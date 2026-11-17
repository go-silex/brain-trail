package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const appTTL = 120 * time.Second
const appBudget = 15 * time.Second

type appApproval struct {
	key        string
	ref        json.RawMessage
	owner      Owner
	generation int64
	label      string
	challenge  Token
	secret     Token
	expires    time.Time
	expiresAt  int64
	state      string
	grant      *appGrant
	terminal   time.Time
}
type appGrant struct {
	id, key                 Token
	approval                *appApproval
	recipient               Recipient
	lease                   Lease
	active                  bool
	leaseUntil, retainUntil time.Time
}
type appOperation struct {
	scope        Guard
	kind         string
	deadline     time.Time
	replies      chan json.RawMessage
	nextPart     int
	parts        int
	cursor       *Cursor
	continuation bool
	context      context.Context
}
type appPairPending struct {
	generation int64
	deadline   time.Time
	reply      chan json.RawMessage
	context    context.Context
}
type appBridge struct {
	mu              sync.Mutex
	relay           *relay
	address         RelayAddress
	approvals       map[string]*appApproval
	grants          map[Token]*appGrant
	operations      map[Token]*appOperation
	owner           Owner
	ownerGeneration int64
	pairs           map[Token]*appPairPending
	closed          bool
}

func newAppBridge(s *relay, socket string) (*appBridge, error) {
	id, err := secret()
	if err != nil {
		return nil, err
	}
	return &appBridge{relay: s, address: RelayAddress{Socket: socket, RelayID: Token(id)}, approvals: make(map[string]*appApproval), grants: make(map[Token]*appGrant), operations: make(map[Token]*appOperation), pairs: make(map[Token]*appPairPending)}, nil
}
func appToken() (Token, error)           { s, e := secret(); return Token(s), e }
func appOK(w http.ResponseWriter, v any) { jsonOut(w, map[string]any{"v": 1, "ok": true, "value": v}) }
func appErr(w http.ResponseWriter, e string) {
	jsonOut(w, map[string]any{"v": 1, "ok": false, "error": e})
}
func appEqual(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func appValidOwner(o Owner) bool {
	return (o.Host == "code" || o.Host == "omp") && len(o.SessionID) > 0 && len(o.SessionID) <= 1024 && utf8.ValidString(o.SessionID) && !strings.ContainsRune(o.SessionID, 0)
}
func appValidLabel(s string) bool {
	if len(s) > 512 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func appPositive(n int64) bool { return n > 0 && n <= 9007199254740991 }
func appCursor(c *Cursor, generation int64) bool {
	return c == nil || (c.Generation == generation && c.Revision >= 0 && (c.LayoutRev == nil || *c.LayoutRev >= 0))
}
func appReason(s string) bool {
	switch s {
	case "cancelled", "timeout", "failed", "detached", "generation-ended", "session-ended", "disconnected":
		return true
	}
	return false
}
func appError(s string) bool {
	switch s {
	case "invalid", "forbidden", "stale-generation", "unsupported", "launch-failed", "busy", "too-large", "disconnected", "timeout":
		return true
	}
	return false
}
func appKind(raw json.RawMessage) string {
	var h struct {
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(raw, &h)
	return h.Kind
}
func appRef(raw json.RawMessage) (string, json.RawMessage, bool) {
	switch appKind(raw) {
	case "code":
		var v CodeRef
		if decodeAppJSON(raw, &v) == nil {
			b, _ := json.Marshal(v)
			return "code:" + string(v.OpenID), b, true
		}
	case "chat":
		var v ChatRef
		if decodeAppJSON(raw, &v) == nil {
			b, _ := json.Marshal(v)
			return "chat:" + string(v.PairID), b, true
		}
	}
	return "", nil, false
}
func appProof(raw json.RawMessage, recipient Recipient) (string, Token, bool) {
	switch appKind(raw) {
	case "code":
		var p CodeProof
		if decodeAppJSON(raw, &p) == nil && p.Method == "S256" && p.OpenID == recipient.OpenID {
			sum := sha256.Sum256([]byte(p.Verifier))
			return "code:" + string(p.OpenID), Token(base64.RawURLEncoding.EncodeToString(sum[:])), true
		}
	case "chat":
		var p ChatProof
		if decodeAppJSON(raw, &p) == nil {
			return "chat:" + string(p.PairID), p.Secret, true
		}
	}
	return "", "", false
}
func (a *appBridge) current(generation int64) bool {
	a.relay.mu.Lock()
	defer a.relay.mu.Unlock()
	return !a.relay.generationEnded && a.relay.generation == generation
}
func (a *appBridge) retireGrant(g *appGrant, now time.Time) {
	if g == nil {
		return
	}
	g.active = false
	g.approval.state = "revoked"
	g.approval.terminal = now
	delete(a.grants, g.id)
	for id, o := range a.operations {
		if o.scope.GrantID == g.id {
			delete(a.operations, id)
		}
	}
}
func (a *appBridge) clean(now time.Time) {
	for _, g := range a.grants {
		if g.active && !now.Before(g.leaseUntil) {
			g.active = false
			g.retainUntil = now.Add(appTTL)
			for id, o := range a.operations {
				if o.scope.GrantID == g.id {
					delete(a.operations, id)
				}
			}
		}
		if !g.active && !now.Before(g.retainUntil) {
			a.retireGrant(g, now)
		}
	}
	for k, p := range a.approvals {
		if (p.state == "pending" || p.state == "claimed") && !a.current(p.generation) {
			p.state = "revoked"
			p.terminal = now
			a.retireGrant(p.grant, now)
		}
		if p.state == "pending" && !now.Before(p.expires) {
			p.state = "expired"
			p.terminal = now
		}
		if (p.state == "expired" || p.state == "revoked") && !p.terminal.IsZero() && now.Sub(p.terminal) >= appTTL {
			delete(a.approvals, k)
		}
	}
	for id, o := range a.operations {
		if !now.Before(o.deadline) {
			delete(a.operations, id)
		}
	}
	for id, p := range a.pairs {
		if !now.Before(p.deadline) {
			delete(a.pairs, id)
		}
	}
}
func (a *appBridge) generationChanged() {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	for _, p := range a.approvals {
		if !a.current(p.generation) && (p.state == "pending" || p.state == "claimed") {
			p.state = "revoked"
			p.terminal = now
			a.retireGrant(p.grant, now)
		}
	}
	for id, p := range a.pairs {
		if !a.current(p.generation) {
			delete(a.pairs, id)
		}
	}
}
func (a *appBridge) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	now := time.Now()
	for _, p := range a.approvals {
		p.state = "revoked"
		p.terminal = now
		a.retireGrant(p.grant, now)
	}
	clear(a.operations)
	clear(a.pairs)
}
func (a *appBridge) guardLocked(scope Guard, now time.Time) bool {
	g := a.grants[scope.GrantID]
	o := a.operations[scope.RequestID]
	return !a.closed && g != nil && o != nil && (o.context == nil || o.context.Err() == nil) && o.scope == scope && now.Before(o.deadline) && g.active && now.Before(g.leaseUntil) && g.lease == scope.Lease && scope.RelayID == a.address.RelayID && g.approval.owner == scope.Owner && g.approval.generation == scope.Generation && a.current(scope.Generation)
}
func (a *appBridge) checkGuard(scope Guard) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	a.clean(now)
	return a.guardLocked(scope, now)
}
func (a *appBridge) issue(q HostApprove, now time.Time) (Approved, string) {
	var out Approved
	if q.V != 1 || !appValidOwner(q.Owner) || !appPositive(q.Generation) || !appValidLabel(q.Label) {
		return out, "invalid"
	}
	if !a.current(q.Generation) {
		return out, "stale-generation"
	}
	if a.ownerGeneration == q.Generation && a.owner != q.Owner {
		return out, "forbidden"
	}
	var key string
	var ref json.RawMessage
	var challenge Token
	var pair Token
	switch appKind(q.Approval) {
	case "code":
		var x CodeApproval
		if decodeAppJSON(q.Approval, &x) != nil || x.Method != "S256" {
			return out, "invalid"
		}
		key = "code:" + string(x.OpenID)
		challenge = x.Challenge
		ref, _ = json.Marshal(CodeRef{Kind: "code", OpenID: x.OpenID})
	case "chat":
		var x ChatApproval
		if decodeAppJSON(q.Approval, &x) != nil {
			return out, "invalid"
		}
		key = "chat:" + string(x.PairID)
		pair = x.PairID
		ref, _ = json.Marshal(ChatRef{Kind: "chat", PairID: x.PairID})
	default:
		return out, "invalid"
	}
	if old := a.approvals[key]; old != nil {
		if challenge != "" && old.state == "pending" && old.owner == q.Owner && old.generation == q.Generation && old.label == q.Label && old.challenge == challenge {
			return Approved{Relay: a.address, Approval: old.ref, ExpiresAt: old.expiresAt}, ""
		}
		return out, "forbidden"
	}
	count := 0
	for _, p := range a.approvals {
		if p.owner == q.Owner {
			count++
		}
	}
	if count >= 16 {
		return out, "busy"
	}
	var sec Token
	if pair != "" {
		var err error
		sec, err = appToken()
		if err != nil {
			return out, "disconnected"
		}
		for _, p := range a.approvals {
			if p.owner == q.Owner && p.state == "pending" && strings.HasPrefix(p.key, "chat:") {
				p.state = "revoked"
				p.terminal = now
			}
		}
	}
	expires := now.Add(appTTL)
	p := &appApproval{key: key, ref: ref, owner: q.Owner, generation: q.Generation, label: q.Label, challenge: challenge, secret: sec, expires: expires, expiresAt: expires.UnixMilli(), state: "pending"}
	a.approvals[key] = p
	a.owner = q.Owner
	a.ownerGeneration = q.Generation
	out = Approved{Relay: a.address, Approval: ref, ExpiresAt: p.expiresAt}
	if pair != "" {
		out.Envelope = &ChatEnvelope{V1: V1{V: 1}, Kind: "chat", Relay: a.address, PairID: pair, Secret: sec, ExpiresAt: p.expiresAt}
	}
	return out, ""
}
func (a *appBridge) host(w http.ResponseWriter, r *http.Request, b []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	a.clean(now)
	if a.closed {
		appErr(w, "disconnected")
		return
	}
	switch r.URL.Path {
	case "/h/app/approve":
		var q HostApprove
		if decodeAppJSON(b, &q) != nil {
			appErr(w, "invalid")
			return
		}
		v, e := a.issue(q, now)
		if e != "" {
			appErr(w, e)
		} else {
			appOK(w, v)
		}
	case "/h/app/check":
		var q HostCheck
		if decodeAppJSON(b, &q) != nil || q.V != 1 {
			appErr(w, "invalid")
			return
		}
		switch appKind(q.Target) {
		case "approval":
			var t ApprovalTarget
			if decodeAppJSON(q.Target, &t) != nil {
				appErr(w, "invalid")
				return
			}
			key, _, ok := appRef(t.Approval)
			if !ok {
				appErr(w, "invalid")
				return
			}
			v := ApprovalChecked{Kind: "approval", State: "missing"}
			if p := a.approvals[key]; p != nil {
				v.State = p.state
				v.ExpiresAt = &p.expiresAt
				if p.grant != nil {
					v.GrantID = &p.grant.id
				}
			}
			appOK(w, v)
		case "operation":
			var t OperationTarget
			if decodeAppJSON(q.Target, &t) != nil {
				appErr(w, "invalid")
				return
			}
			if !a.guardLocked(t.Scope, now) {
				appErr(w, "forbidden")
				return
			}
			appOK(w, OperationChecked{Kind: "operation"})
		default:
			appErr(w, "invalid")
		}
	case "/h/app/revoke":
		var q HostRevoke
		if decodeAppJSON(b, &q) != nil || q.V != 1 || !appReason(q.Reason) {
			appErr(w, "invalid")
			return
		}
		switch appKind(q.Target) {
		case "approval":
			var t ApprovalTarget
			if decodeAppJSON(q.Target, &t) != nil {
				appErr(w, "invalid")
				return
			}
			key, _, ok := appRef(t.Approval)
			if !ok {
				appErr(w, "invalid")
				return
			}
			if p := a.approvals[key]; p != nil {
				p.state = "revoked"
				p.terminal = now
				a.retireGrant(p.grant, now)
			}
		case "grant":
			var t GrantTarget
			if decodeAppJSON(q.Target, &t) != nil {
				appErr(w, "invalid")
				return
			}
			a.retireGrant(a.grants[t.GrantID], now)
		case "generation":
			var t GenerationTarget
			if decodeAppJSON(q.Target, &t) != nil || !appValidOwner(t.Owner) || !appPositive(t.Generation) {
				appErr(w, "invalid")
				return
			}
			for _, p := range a.approvals {
				if p.owner == t.Owner && p.generation == t.Generation {
					p.state = "revoked"
					p.terminal = now
					a.retireGrant(p.grant, now)
				}
			}
		default:
			appErr(w, "invalid")
			return
		}
		appOK(w, nil)
	case "/h/app/reply":
		a.hostReply(w, b, now)
	case "/h/app/browser-pair-reply":
		a.pairReply(w, b, now)
	default:
		appErr(w, "invalid")
	}
}
func (a *appBridge) hostReply(w http.ResponseWriter, b []byte, now time.Time) {
	var q HostAppReply
	if decodeAppJSON(b, &q) != nil || q.V != 1 {
		appErr(w, "invalid")
		return
	}
	o := a.operations[q.Scope.RequestID]
	if o == nil || o.nextPart < 0 || !a.guardLocked(q.Scope, now) {
		appErr(w, "forbidden")
		return
	}
	var shape struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
		Error string          `json:"error"`
	}
	if json.Unmarshal(q.Result, &shape) != nil {
		appErr(w, "invalid")
		return
	}
	var result json.RawMessage
	if !shape.OK {
		var f Failure
		if decodeAppJSON(q.Result, &f) != nil || f.OK || !appError(f.Error) {
			appErr(w, "invalid")
			return
		}
		result = q.Result
		o.nextPart = -1
	} else if o.kind == "command" {
		var s Success[CommandFrameValue]
		if decodeAppJSON(q.Result, &s) != nil || !s.OK || s.Value.Kind != "command" || len(s.Value.Reply) == 0 {
			appErr(w, "invalid")
			return
		}
		result, _ = json.Marshal(Success[json.RawMessage]{OK: true, Value: s.Value.Reply})
		o.nextPart = -1
	} else {
		var s Success[CurrentFrameValue]
		if decodeAppJSON(q.Result, &s) != nil || !s.OK || s.Value.Kind != "current" {
			appErr(w, "invalid")
			return
		}
		c := s.Value.Chunk
		if c.ReadID != q.Scope.RequestID || c.Part != o.nextPart || c.Parts < 1 || c.Parts > 2 || c.Part >= c.Parts || len(c.Events) > 1 || !appCursor(&c.Cursor, q.Scope.Generation) || (c.Parts == 2 && len(c.Events) != 1) || (o.nextPart > 0 && (o.parts != c.Parts || o.cursor == nil || !appSameCursor(*o.cursor, c.Cursor))) {
			appErr(w, "invalid")
			return
		}
		for _, event := range c.Events {
			var ev struct {
				V          int    `json:"v"`
				Kind       string `json:"kind"`
				Generation int64  `json:"generation"`
			}
			if json.Unmarshal(event, &ev) != nil || ev.V != 1 || ev.Generation != q.Scope.Generation || (ev.Kind != "layout" && ev.Kind != "snapshot") || (c.Parts == 2 && ((c.Part == 0 && ev.Kind != "layout") || (c.Part == 1 && ev.Kind != "snapshot"))) {
				appErr(w, "invalid")
				return
			}
		}
		o.parts = c.Parts
		o.cursor = &c.Cursor
		o.nextPart++
		result, _ = json.Marshal(Success[CurrentPart]{OK: true, Value: c})
	}
	wrapped := append([]byte(`{"v":1,`), result[1:]...)
	encoded, err := ascii(json.RawMessage(wrapped))
	if err != nil || len(encoded) > 2*1024*1024 {
		o.nextPart = -1
		select {
		case o.replies <- json.RawMessage(`{"v":1,"ok":false,"error":"too-large"}`):
		default:
		}
		appErr(w, "too-large")
		return
	}
	select {
	case o.replies <- encoded:
		appOK(w, nil)
	default:
		appErr(w, "busy")
	}
}
func appSameCursor(a, b Cursor) bool {
	if a.Generation != b.Generation || a.Revision != b.Revision || (a.LayoutRev == nil) != (b.LayoutRev == nil) {
		return false
	}
	return a.LayoutRev == nil || *a.LayoutRev == *b.LayoutRev
}
func (a *appBridge) pairReply(w http.ResponseWriter, b []byte, now time.Time) {
	var q HostBrowserPairReply
	if decodeAppJSON(b, &q) != nil || q.V != 1 {
		appErr(w, "invalid")
		return
	}
	p := a.pairs[q.RequestID]
	if p == nil || p.context.Err() != nil || !now.Before(p.deadline) || !a.current(p.generation) {
		appErr(w, "forbidden")
		return
	}
	var s Success[BrowserPairAuthority]
	if decodeAppJSON(q.Result, &s) == nil && s.OK {
		x := s.Value
		if x.Generation != p.generation {
			appErr(w, "stale-generation")
			return
		}
		ref, _ := json.Marshal(ChatApproval{Kind: "chat", PairID: x.PairID})
		v, e := a.issue(HostApprove{V1: V1{V: 1}, Owner: x.Owner, Generation: x.Generation, Label: x.Label, Approval: ref}, now)
		if e != "" {
			appErr(w, e)
			return
		}
		msg, _ := json.Marshal(WireSuccess[*ChatEnvelope]{V1: V1{V: 1}, Success: Success[*ChatEnvelope]{OK: true, Value: v.Envelope}})
		delete(a.pairs, q.RequestID)
		p.reply <- msg
		appOK(w, nil)
		return
	}
	var f Failure
	if decodeAppJSON(q.Result, &f) != nil || f.OK || !appError(f.Error) {
		appErr(w, "invalid")
		return
	}
	msg, _ := json.Marshal(WireFailure{V1: V1{V: 1}, Failure: f})
	delete(a.pairs, q.RequestID)
	p.reply <- msg
	appOK(w, nil)
}
func (a *appBridge) browserPair(w http.ResponseWriter, r *http.Request, b []byte) {
	var q BrowserPairRequest
	if decodeAppJSON(b, &q) != nil || q.V != 1 || !appPositive(q.Generation) {
		appErr(w, "invalid")
		return
	}
	id, e := appToken()
	if e != nil {
		appErr(w, "disconnected")
		return
	}
	now := time.Now()
	p := &appPairPending{generation: q.Generation, deadline: now.Add(appBudget), reply: make(chan json.RawMessage, 1), context: r.Context()}
	a.mu.Lock()
	a.clean(now)
	if a.closed || !a.current(q.Generation) {
		a.mu.Unlock()
		appErr(w, "stale-generation")
		return
	}
	if len(a.operations)+len(a.pairs) >= 16 {
		a.mu.Unlock()
		appErr(w, "busy")
		return
	}
	a.pairs[id] = p
	if !a.relay.frame(BrowserPairFrame{V1: V1{V: 1}, T: "app-pair", RequestID: id, Generation: q.Generation}) {
		delete(a.pairs, id)
		a.mu.Unlock()
		appErr(w, "busy")
		return
	}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.pairs, id); a.mu.Unlock() }()
	timer := time.NewTimer(time.Until(p.deadline))
	defer timer.Stop()
	select {
	case v := <-p.reply:
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(v)
	case <-timer.C:
		appErr(w, "timeout")
	case <-r.Context().Done():
	}
}

func (a *appBridge) app(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		appErr(w, "invalid")
		return
	}
	b, e := body(r, hostLimit)
	if e != nil {
		if e.Error() == "too-large" {
			appErr(w, "too-large")
		} else {
			appErr(w, "invalid")
		}
		return
	}
	now := time.Now()
	a.mu.Lock()
	a.clean(now)
	if a.closed {
		a.mu.Unlock()
		appErr(w, "disconnected")
		return
	}
	if r.URL.Path == "/a/claim" {
		var q Claim
		if decodeAppJSON(b, &q) != nil || q.V != 1 || q.RelayID != a.address.RelayID || r.Header.Get("Authorization") != "" {
			a.mu.Unlock()
			appErr(w, "invalid")
			return
		}
		key, proof, ok := appProof(q.Proof, q.Recipient)
		p := a.approvals[key]
		if !ok || p == nil || p.state != "pending" || !now.Before(p.expires) || !a.current(p.generation) || !appEqual(string(proof), string(p.challenge)+string(p.secret)) {
			a.mu.Unlock()
			appErr(w, "forbidden")
			return
		}
		id, e1 := appToken()
		token, e2 := appToken()
		if e1 != nil || e2 != nil {
			a.mu.Unlock()
			appErr(w, "disconnected")
			return
		}
		g := &appGrant{id: id, key: token, approval: p, recipient: q.Recipient, retainUntil: now.Add(appTTL)}
		p.state = "claimed"
		p.grant = g
		a.grants[id] = g
		v := Claimed{GrantID: id, GrantKey: token, Binding: Binding{RelayID: a.address.RelayID, Approval: p.ref, Recipient: q.Recipient, Owner: p.owner, Generation: p.generation, Label: p.label}}
		a.mu.Unlock()
		appOK(w, v)
		return
	}
	if r.URL.Path == "/a/release" {
		var q Release
		if decodeAppJSON(b, &q) != nil || q.V != 1 || q.RelayID != a.address.RelayID || !appReason(q.Reason) {
			a.mu.Unlock()
			appErr(w, "invalid")
			return
		}
		switch appKind(q.Credential) {
		case "grant":
			var c GrantCredential
			if decodeAppJSON(q.Credential, &c) != nil {
				a.mu.Unlock()
				appErr(w, "invalid")
				return
			}
			g := a.grants[c.GrantID]
			if g == nil || !appEqual(r.Header.Get("Authorization"), "Bearer "+string(g.key)) {
				a.mu.Unlock()
				appErr(w, "forbidden")
				return
			}
			a.retireGrant(g, now)
		case "proof":
			var c ProofCredential
			if decodeAppJSON(q.Credential, &c) != nil || r.Header.Get("Authorization") != "" {
				a.mu.Unlock()
				appErr(w, "invalid")
				return
			}
			key, proof, ok := appProof(c.Proof, c.Recipient)
			p := a.approvals[key]
			if !ok || p == nil || !appEqual(string(proof), string(p.challenge)+string(p.secret)) || (p.grant != nil && p.grant.recipient != c.Recipient) {
				a.mu.Unlock()
				appErr(w, "forbidden")
				return
			}
			p.state = "revoked"
			p.terminal = now
			a.retireGrant(p.grant, now)
		default:
			a.mu.Unlock()
			appErr(w, "invalid")
			return
		}
		a.mu.Unlock()
		appOK(w, nil)
		return
	}
	auth := r.Header.Get("Authorization")
	var g *appGrant
	for _, candidate := range a.grants {
		if appEqual(auth, "Bearer "+string(candidate.key)) {
			g = candidate
		}
	}
	if g == nil || !a.current(g.approval.generation) {
		a.mu.Unlock()
		appErr(w, "forbidden")
		return
	}
	switch r.URL.Path {
	case "/a/lease":
		var q LeaseRequest
		if decodeAppJSON(b, &q) != nil || q.V != 1 || q.RelayID != a.address.RelayID || !appPositive(q.Lease.Epoch) {
			a.mu.Unlock()
			appErr(w, "invalid")
			return
		}
		if q.Active {
			if q.Lease.Epoch < g.lease.Epoch || (q.Lease.Epoch == g.lease.Epoch && (q.Lease.ID != g.lease.ID || !g.active)) {
				a.mu.Unlock()
				appErr(w, "forbidden")
				return
			}
			if q.Lease.Epoch > g.lease.Epoch {
				if q.Lease.ID == g.lease.ID {
					a.mu.Unlock()
					appErr(w, "forbidden")
					return
				}
				for id, o := range a.operations {
					if o.scope.GrantID == g.id {
						delete(a.operations, id)
					}
				}
				g.lease = q.Lease
			}
			g.active = true
			g.leaseUntil = now.Add(appBudget)
		} else {
			if q.Lease != g.lease {
				a.mu.Unlock()
				appErr(w, "forbidden")
				return
			}
			g.active = false
			g.retainUntil = now.Add(appTTL)
			for id, o := range a.operations {
				if o.scope.GrantID == g.id {
					delete(a.operations, id)
				}
			}
		}
		a.mu.Unlock()
		appOK(w, nil)
		return
	case "/a/pull", "/a/command", "/a/pull-next":
		var lease Lease
		var cursor *Cursor
		var request json.RawMessage
		var readID Token
		kind := "current"
		switch r.URL.Path {
		case "/a/pull":
			var q RelayPull
			if decodeAppJSON(b, &q) != nil || q.V != 1 || q.RelayID != a.address.RelayID || !appCursor(q.Cursor, g.approval.generation) {
				a.mu.Unlock()
				appErr(w, "invalid")
				return
			}
			lease = q.Lease
			cursor = q.Cursor
		case "/a/command":
			var q RelayCommand
			if len(b) > 65536+1024 || decodeAppJSON(b, &q) != nil || q.V != 1 || q.RelayID != a.address.RelayID || len(q.Request) > 65536 || len(q.Request) == 0 {
				a.mu.Unlock()
				appErr(w, "invalid")
				return
			}
			lease = q.Lease
			request = q.Request
			kind = "command"
		case "/a/pull-next":
			var q RelayPullNext
			if decodeAppJSON(b, &q) != nil || q.V != 1 || q.RelayID != a.address.RelayID || q.Part != 1 {
				a.mu.Unlock()
				appErr(w, "invalid")
				return
			}
			lease = q.Lease
			readID = q.ReadID
		}
		if !g.active || lease != g.lease || !now.Before(g.leaseUntil) {
			a.mu.Unlock()
			appErr(w, "forbidden")
			return
		}
		g.leaseUntil = now.Add(appBudget)
		if readID != "" {
			o := a.operations[readID]
			if o == nil || o.kind != "current" || o.scope.GrantID != g.id || o.parts != 2 || o.nextPart < 1 || o.continuation || !a.guardLocked(o.scope, now) {
				a.mu.Unlock()
				appErr(w, "forbidden")
				return
			}
			o.continuation = true
			o.context = r.Context()
			a.mu.Unlock()
			a.awaitOperation(w, r, o, true)
			return
		}
		if len(a.operations)+len(a.pairs) >= 16 {
			a.mu.Unlock()
			appErr(w, "busy")
			return
		}
		id, err := appToken()
		if err != nil {
			a.mu.Unlock()
			appErr(w, "disconnected")
			return
		}
		scope := Guard{RequestID: id, RelayID: a.address.RelayID, GrantID: g.id, Owner: g.approval.owner, Generation: g.approval.generation, Lease: g.lease}
		o := &appOperation{scope: scope, kind: kind, deadline: now.Add(appBudget), replies: make(chan json.RawMessage, 2), context: r.Context()}
		a.operations[id] = o
		var frame any = AppCurrent{V1: V1{V: 1}, T: "app-current", Scope: scope, Cursor: cursor}
		if kind == "command" {
			frame = AppCommand{V1: V1{V: 1}, T: "app-cmd", Scope: scope, Request: request}
		}
		if !a.relay.frame(frame) {
			delete(a.operations, id)
			a.mu.Unlock()
			appErr(w, "busy")
			return
		}
		a.mu.Unlock()
		a.awaitOperation(w, r, o, false)
		return
	default:
		a.mu.Unlock()
		appErr(w, "invalid")
		return
	}
}
func (a *appBridge) awaitOperation(w http.ResponseWriter, r *http.Request, o *appOperation, next bool) {
	timer := time.NewTimer(time.Until(o.deadline))
	defer timer.Stop()
	select {
	case v := <-o.replies:
		a.mu.Lock()
		live := a.guardLocked(o.scope, time.Now())
		keep := live && !next && o.kind == "current" && o.parts == 2 && o.nextPart > 0
		if !keep {
			delete(a.operations, o.scope.RequestID)
		} else {
			o.context = nil
		}
		a.mu.Unlock()
		if !live {
			appErr(w, "forbidden")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(v)
	case <-timer.C:
		a.mu.Lock()
		delete(a.operations, o.scope.RequestID)
		a.mu.Unlock()
		appErr(w, "timeout")
	case <-r.Context().Done():
		a.mu.Lock()
		delete(a.operations, o.scope.RequestID)
		a.mu.Unlock()
	}
}
