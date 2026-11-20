package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"time"
)

const mcpViewLimit = 16
const mcpViewRetention = 120 * time.Second
const mcpLeaseLifetime = 15 * time.Second
const mcpOperationTimeout = 15 * time.Second
const mcpSafeInteger = int64(9007199254740991)

type mcpViewGrant struct {
	client  *mcpRelayClient
	address RelayAddress
	claim   Claimed
	lease   Lease
}
type mcpViewWork struct {
	target    RelayAddress
	proof     json.RawMessage
	expiresAt int64
	done      chan struct{}
	ctx       context.Context
	cancel    context.CancelFunc
	refusal   string
	attached  Attached
}
type mcpView struct {
	key           Token
	recipient     Recipient
	verifier      Token
	openState     string // pending, completing, committed, terminal
	created       time.Time
	retainedUntil time.Time
	mountKey      Token
	mountEpoch    int64
	intent        uint64
	activeUntil   time.Time
	grant         *mcpViewGrant
	work          *mcpViewWork
	pulling       uint64
	operations    map[uint64]context.CancelFunc
	nextOperation uint64
	io            sync.Mutex
}
type mcpViews struct {
	mu       sync.Mutex
	manifest Manifest
	epoch    Token
	views    map[Token]*mcpView
	opens    map[Token]*mcpView
	closed   bool
	stop     chan struct{}
}

func mcpRandomToken() (Token, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return Token(base64.RawURLEncoding.EncodeToString(b[:])), nil
}
func mcpTokenValid(t Token) bool {
	b, err := base64.RawURLEncoding.DecodeString(string(t))
	return err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == string(t)
}
func mcpJSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func mcpState(v *mcpView) json.RawMessage {
	if v.grant != nil {
		return mcpJSON(mcpAttached(v.grant))
	}
	if v.openState == "pending" || v.openState == "completing" || v.work != nil {
		return mcpJSON(Unattached{Kind: "pending"})
	}
	return mcpJSON(Unattached{Kind: "detached"})
}
func mcpAttached(g *mcpViewGrant) Attached {
	return Attached{Kind: "attached", Generation: g.claim.Binding.Generation, Source: Source{Owner: g.claim.Binding.Owner, Label: g.claim.Binding.Label}}
}
func newMCPViews(manifest Manifest) (*mcpViews, error) {
	epoch, err := mcpRandomToken()
	if err != nil {
		return nil, err
	}
	s := &mcpViews{manifest: manifest, epoch: epoch, views: make(map[Token]*mcpView), opens: make(map[Token]*mcpView), stop: make(chan struct{})}
	go s.reaper()
	return s, nil
}
func (s *mcpViews) reaper() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.sweep()
		case <-s.stop:
			return
		}
	}
}
func (s *mcpViews) sweep() {
	now := time.Now()
	var releases []*mcpViewGrant
	s.mu.Lock()
	for key, v := range s.views {
		if v.openState == "pending" && now.Sub(v.created) >= mcpViewRetention {
			v.openState = "terminal"
			v.verifier = ""
			v.retainedUntil = now.Add(mcpViewRetention)
		}
		if v.mountKey != "" && !v.activeUntil.IsZero() && !now.Before(v.activeUntil) {
			v.mountKey = ""
			v.intent++
			s.cancelOperations(v)
			if v.work != nil {
				v.work.cancel()
			}
			v.retainedUntil = now.Add(mcpViewRetention)
			if v.grant != nil {
				go s.suspend(v, v.grant, v.grant.lease)
			}
		}
		if v.mountKey == "" && v.work == nil && !v.retainedUntil.IsZero() && !now.Before(v.retainedUntil) {
			if v.grant != nil {
				releases = append(releases, v.grant)
				v.grant = nil
			}
			delete(s.views, key)
			delete(s.opens, v.recipient.OpenID)
		}
	}
	s.mu.Unlock()
	for _, g := range releases {
		go mcpReleaseGrant(g, "timeout")
	}
}
func (s *mcpViews) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.stop)
	var gs []*mcpViewGrant
	for _, v := range s.views {
		v.intent++
		s.cancelOperations(v)
		if v.work != nil {
			v.work.cancel()
		}
		if v.grant != nil {
			gs = append(gs, v.grant)
			v.grant = nil
		}
	}
	s.mu.Unlock()
	for _, g := range gs {
		mcpReleaseGrant(g, "disconnected")
	}
}
func (s *mcpViews) cancelOperations(v *mcpView) {
	for _, cancel := range v.operations {
		cancel()
	}
	v.pulling = 0
}
func (s *mcpViews) allocate(withVerifier bool) (*mcpView, string) {
	if s.closed || len(s.views) >= mcpViewLimit {
		return nil, "busy"
	}
	key, e := mcpRandomToken()
	if e != nil {
		return nil, "disconnected"
	}
	open, e := mcpRandomToken()
	if e != nil {
		return nil, "disconnected"
	}
	v := &mcpView{key: key, recipient: Recipient{ServerEpoch: s.epoch, OpenID: open}, created: time.Now(), retainedUntil: time.Now().Add(mcpViewRetention), openState: "terminal", operations: make(map[uint64]context.CancelFunc)}
	if withVerifier {
		v.verifier, e = mcpRandomToken()
		if e != nil {
			return nil, "disconnected"
		}
		v.openState = "pending"
		s.opens[open] = v
	}
	s.views[key] = v
	return v, ""
}
func (s *mcpViews) bootstrap(v *mcpView) Bootstrap {
	return Bootstrap{Manifest: s.manifest, ServerEpoch: s.epoch, ViewKey: v.key}
}
func (s *mcpViews) open() (string, Bootstrap, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ref := s.allocate(true)
	if ref != "" {
		return "", Bootstrap{}, ref
	}
	hash := sha256.Sum256([]byte(v.verifier))
	challenge := base64.RawURLEncoding.EncodeToString(hash[:])
	return "BRAIN_TRAIL_OPEN_V1:" + string(v.recipient.OpenID) + ":" + challenge, s.bootstrap(v), ""
}
func (s *mcpViews) compatible(i UiIdentity) bool {
	return i.V == 1 && i.WireRevision == 1 && i.UIBuildID == s.manifest.UIBuildID
}
func (s *mcpViews) reset(i AppReset) (ResetView, string) {
	if !s.compatible(i) {
		return ResetView{}, "unsupported"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, r := s.allocate(false)
	if r != "" {
		return ResetView{}, r
	}
	return ResetView{Bootstrap: s.bootstrap(v), State: Detached{Kind: "detached"}}, ""
}
func mcpErr(err error, refusal string) string {
	if refusal != "" {
		return refusal
	}
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "disconnected"
}
func mcpReleaseGrant(g *mcpViewGrant, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), mcpOperationTimeout)
	defer cancel()
	defer g.client.close()
	_, _ = mcpRelayCall[*struct{}](ctx, g.client, "/a/release", g.claim.GrantKey, Release{V1: V1{V: 1}, RelayID: g.address.RelayID, Reason: reason, Credential: mcpJSON(GrantCredential{Kind: "grant", GrantID: g.claim.GrantID})})
}
func mcpReleaseProof(client *mcpRelayClient, address RelayAddress, recipient Recipient, proof json.RawMessage, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), mcpOperationTimeout)
	defer cancel()
	_, _ = mcpRelayCall[*struct{}](ctx, client, "/a/release", "", Release{V1: V1{V: 1}, RelayID: address.RelayID, Reason: reason, Credential: mcpJSON(ProofCredential{Kind: "proof", Recipient: recipient, Proof: proof})})
}
func (s *mcpViews) suspend(v *mcpView, g *mcpViewGrant, lease Lease) {
	v.io.Lock()
	defer v.io.Unlock()
	if lease.ID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), mcpOperationTimeout)
	defer cancel()
	_, _ = mcpRelayCall[*struct{}](ctx, g.client, "/a/lease", g.claim.GrantKey, LeaseRequest{V1: V1{V: 1}, RelayID: g.address.RelayID, Lease: lease, Active: false})
}
func mcpViewActivityLifetime(v *mcpView) time.Duration {
	if v.grant != nil {
		return mcpLeaseLifetime
	}
	return mcpViewRetention
}
func (s *mcpViews) authenticate(a AppAuth) (*mcpView, string) {
	if a.V != 1 || a.ServerEpoch != s.epoch || !mcpTokenValid(a.ViewKey) || !mcpTokenValid(a.MountKey) {
		return nil, "forbidden"
	}
	v := s.views[a.ViewKey]
	if v == nil || v.mountKey != a.MountKey || !time.Now().Before(v.activeUntil) {
		return nil, "forbidden"
	}
	v.activeUntil = time.Now().Add(mcpViewActivityLifetime(v))
	return v, ""
}
func (s *mcpViews) operation(v *mcpView, parent context.Context) (context.Context, func(), uint64) {
	ctx, cancel := context.WithTimeout(parent, mcpOperationTimeout)
	v.nextOperation++
	id := v.nextOperation
	v.operations[id] = cancel
	intent := v.intent
	return ctx, func() { cancel(); s.mu.Lock(); delete(v.operations, id); s.mu.Unlock() }, intent
}
func (s *mcpViews) full() bool {
	n := 0
	for _, v := range s.views {
		n += len(v.operations)
		if v.work != nil {
			n++
		}
	}
	return n >= mcpViewLimit
}
func (s *mcpViews) lease(ctx context.Context, v *mcpView, g *mcpViewGrant, epoch int64) string {
	id, e := mcpRandomToken()
	if e != nil {
		return "disconnected"
	}
	lease := Lease{Epoch: epoch, ID: id}
	r, e := mcpRelayCall[*struct{}](ctx, g.client, "/a/lease", g.claim.GrantKey, LeaseRequest{V1: V1{V: 1}, RelayID: g.address.RelayID, Lease: lease, Active: true})
	if x := mcpErr(e, r.Refusal); x != "" {
		return x
	}
	if r.Value != nil {
		return "invalid"
	}
	s.mu.Lock()
	g.lease = lease
	s.mu.Unlock()
	return ""
}
func (s *mcpViews) mount(ctx context.Context, a AppMount) (Mounted, string) {
	if !s.compatible(a.UiIdentity) || a.AssetDigest != s.manifest.AssetDigest {
		return Mounted{}, "unsupported"
	}
	if a.ServerEpoch != s.epoch || !mcpTokenValid(a.ViewKey) {
		return Mounted{}, "forbidden"
	}
	s.mu.Lock()
	v := s.views[a.ViewKey]
	if v == nil || s.closed {
		s.mu.Unlock()
		return Mounted{}, "forbidden"
	}
	if s.full() {
		s.mu.Unlock()
		return Mounted{}, "busy"
	}
	key, e := mcpRandomToken()
	if e != nil {
		s.mu.Unlock()
		return Mounted{}, "disconnected"
	}
	if v.mountEpoch >= mcpSafeInteger {
		s.mu.Unlock()
		return Mounted{}, "disconnected"
	}
	if v.mountEpoch != 0 {
		v.intent++
		if v.work != nil {
			v.work.cancel()
		}
	}
	s.cancelOperations(v)
	v.mountEpoch++
	epoch := v.mountEpoch
	v.mountKey = key
	v.activeUntil = time.Now().Add(mcpViewActivityLifetime(v))
	v.retainedUntil = time.Time{}
	op, done, intent := s.operation(v, ctx)
	s.mu.Unlock()
	defer done()
	v.io.Lock()
	s.mu.Lock()
	g := v.grant
	current := v.intent == intent && v.mountKey == key
	already := g != nil && g.lease.Epoch == epoch
	s.mu.Unlock()
	r := ""
	if current && g != nil && !already {
		r = s.lease(op, v, g, epoch)
	}
	v.io.Unlock()
	if r != "" {
		s.mu.Lock()
		if v.intent == intent {
			v.mountKey = ""
			v.retainedUntil = time.Now().Add(mcpViewRetention)
		}
		s.mu.Unlock()
		return Mounted{}, r
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.intent != intent || v.mountKey != key {
		return Mounted{}, "forbidden"
	}
	return Mounted{MountKey: key, State: mcpState(v)}, ""
}
func mcpValidBinding(c Claimed, address RelayAddress, recipient Recipient, kind string, id Token) bool {
	if !mcpTokenValid(c.GrantID) || !mcpTokenValid(c.GrantKey) || c.Binding.RelayID != address.RelayID || c.Binding.Recipient != recipient || c.Binding.Generation <= 0 || c.Binding.Generation > mcpSafeInteger || (c.Binding.Owner.Host != "code" && c.Binding.Owner.Host != "omp") || len(c.Binding.Owner.SessionID) == 0 || len(c.Binding.Owner.SessionID) > 1024 || strings.ContainsRune(c.Binding.Owner.SessionID, 0) || len(c.Binding.Label) > 512 {
		return false
	}
	for _, r := range c.Binding.Label {
		if r < 32 || r == 127 {
			return false
		}
	}
	if kind == "code" {
		var a CodeRef
		return decodeAppJSON(c.Binding.Approval, &a) == nil && a.Kind == kind && a.OpenID == id
	}
	var a ChatRef
	return decodeAppJSON(c.Binding.Approval, &a) == nil && a.Kind == kind && a.PairID == id
}
func (s *mcpViews) startClaim(v *mcpView, address RelayAddress, proof json.RawMessage, kind string, id Token, w *mcpViewWork, intent uint64) {
	ctx, cancel := context.WithTimeout(w.ctx, mcpOperationTimeout)
	defer cancel()
	client, err := newMCPRelayClient(address)
	if err != nil {
		s.finishClaim(v, w, intent, nil, "forbidden")
		return
	}
	result, err := mcpRelayCall[Claimed](ctx, client, "/a/claim", "", Claim{V1: V1{V: 1}, RelayID: address.RelayID, Recipient: v.recipient, Proof: proof})
	refusal := mcpErr(err, result.Refusal)
	if refusal == "" && !mcpValidBinding(result.Value, address, v.recipient, kind, id) {
		refusal = "invalid"
	}
	var g *mcpViewGrant
	v.io.Lock()
	if refusal == "" {
		g = &mcpViewGrant{client: client, address: address, claim: result.Value}
		s.mu.Lock()
		mounted := v.mountKey != "" && time.Now().Before(v.activeUntil)
		epoch := v.mountEpoch
		valid := v.intent == intent && v.work == w
		s.mu.Unlock()
		if valid && mounted {
			refusal = s.lease(ctx, v, g, epoch)
		}
	}
	if refusal != "" {
		if g != nil {
			go mcpReleaseGrant(g, "failed")
		} else {
			go func() { mcpReleaseProof(client, address, v.recipient, proof, "failed"); client.close() }()
		}
		g = nil
	}
	s.finishClaim(v, w, intent, g, refusal)
	v.io.Unlock()
}
func (s *mcpViews) finishClaim(v *mcpView, w *mcpViewWork, intent uint64, g *mcpViewGrant, refusal string) {
	s.mu.Lock()
	valid := v.work == w && v.intent == intent && !s.closed
	if valid && refusal == "" {
		v.grant = g
		if v.openState == "completing" {
			v.openState = "committed"
		} else {
			v.openState = "terminal"
		}
		v.verifier = ""
		w.attached = mcpAttached(g)
		if v.mountKey == "" {
			v.retainedUntil = time.Now().Add(mcpViewRetention)
		} else if time.Now().Before(v.activeUntil) {
			v.activeUntil = time.Now().Add(mcpLeaseLifetime)
		}
	} else {
		if refusal == "" {
			refusal = "forbidden"
		}
		if v.work == w {
			v.openState = "terminal"
			v.verifier = ""
			v.retainedUntil = time.Now().Add(mcpViewRetention)
		}
	}
	w.refusal = refusal
	if v.work == w {
		v.work = nil
	}
	close(w.done)
	s.mu.Unlock()
	if !valid && g != nil {
		go mcpReleaseGrant(g, "cancelled")
	}
}
func (s *mcpViews) complete(ctx context.Context, a CompleteOpen) (Completed, string) {
	if a.V != 1 || !mcpTokenValid(a.OpenID) || !mcpTokenValid(a.Relay.RelayID) {
		return Completed{}, "invalid"
	}
	s.mu.Lock()
	v := s.opens[a.OpenID]
	if v == nil || s.closed {
		s.mu.Unlock()
		return Completed{}, "forbidden"
	}
	if v.openState == "committed" {
		if v.grant != nil && v.grant.address == a.Relay {
			s.mu.Unlock()
			return Completed{Status: "attached"}, ""
		}
		s.mu.Unlock()
		return Completed{}, "forbidden"
	}
	if v.openState == "pending" && time.Since(v.created) >= mcpViewRetention {
		v.openState = "terminal"
		v.verifier = ""
		v.retainedUntil = time.Now().Add(mcpViewRetention)
	}
	var w *mcpViewWork
	if v.openState == "completing" {
		w = v.work
		if w == nil || w.target != a.Relay {
			s.mu.Unlock()
			return Completed{}, "forbidden"
		}
	} else if v.openState == "pending" {
		if mcpRelaySocketValid(a.Relay.Socket) != nil {
			s.mu.Unlock()
			return Completed{}, "forbidden"
		}
		if s.full() {
			s.mu.Unlock()
			return Completed{}, "busy"
		}
		proof := mcpJSON(CodeProof{Kind: "code", OpenID: a.OpenID, Method: "S256", Verifier: v.verifier})
		workCtx, cancel := context.WithCancel(context.Background())
		w = &mcpViewWork{target: a.Relay, proof: proof, done: make(chan struct{}), ctx: workCtx, cancel: cancel}
		v.work = w
		v.openState = "completing"
		intent := v.intent
		go s.startClaim(v, a.Relay, proof, "code", a.OpenID, w, intent)
	} else {
		s.mu.Unlock()
		return Completed{}, "forbidden"
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return Completed{}, "disconnected"
	case <-w.done:
		if w.refusal != "" {
			return Completed{}, w.refusal
		}
		return Completed{Status: "attached"}, ""
	}
}
func (s *mcpViews) pair(ctx context.Context, a AppPair) (Attached, string) {
	e := a.Envelope
	if e.V != 1 || e.Kind != "chat" || !mcpTokenValid(e.PairID) || !mcpTokenValid(e.Secret) || !mcpTokenValid(e.Relay.RelayID) || e.ExpiresAt <= 0 || e.ExpiresAt > mcpSafeInteger {
		return Attached{}, "invalid"
	}
	proof := mcpJSON(ChatProof{Kind: "chat", PairID: e.PairID, Secret: e.Secret})
	s.mu.Lock()
	v, r := s.authenticate(a.AppAuth)
	if r != "" {
		s.mu.Unlock()
		return Attached{}, r
	}
	if v.grant != nil {
		s.mu.Unlock()
		return Attached{}, "busy"
	}
	var w *mcpViewWork
	if v.work != nil {
		w = v.work
		if v.openState == "completing" || w.target != e.Relay || w.expiresAt != e.ExpiresAt || string(w.proof) != string(proof) {
			s.mu.Unlock()
			return Attached{}, "busy"
		}
	} else {
		if mcpRelaySocketValid(e.Relay.Socket) != nil {
			s.mu.Unlock()
			return Attached{}, "forbidden"
		}
		if s.full() {
			s.mu.Unlock()
			return Attached{}, "busy"
		}
		v.intent++
		v.openState = "terminal"
		v.verifier = ""
		workCtx, cancel := context.WithCancel(context.Background())
		w = &mcpViewWork{target: e.Relay, proof: proof, expiresAt: e.ExpiresAt, done: make(chan struct{}), ctx: workCtx, cancel: cancel}
		v.work = w
		intent := v.intent
		go s.startClaim(v, e.Relay, proof, "chat", e.PairID, w, intent)
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return Attached{}, "disconnected"
	case <-w.done:
		return w.attached, w.refusal
	}
}
func (s *mcpViews) detach(ctx context.Context, a AppDetach) (Detached, string) {
	s.mu.Lock()
	v, r := s.authenticate(a)
	if r != "" {
		s.mu.Unlock()
		return Detached{}, r
	}
	v.intent++
	s.cancelOperations(v)
	if v.work != nil {
		v.work.cancel()
	}
	v.openState = "terminal"
	v.verifier = ""
	g := v.grant
	v.grant = nil
	v.activeUntil = time.Now().Add(mcpViewRetention)
	s.mu.Unlock()
	if g != nil {
		go mcpReleaseGrant(g, "detached")
	}
	return Detached{Kind: "detached"}, ""
}
func (s *mcpViews) unmount(ctx context.Context, a AppUnmount) string {
	s.mu.Lock()
	v, r := s.authenticate(a)
	if r != "" {
		s.mu.Unlock()
		return r
	}
	v.intent++
	s.cancelOperations(v)
	if v.work != nil {
		v.work.cancel()
	}
	v.mountKey = ""
	v.activeUntil = time.Time{}
	v.retainedUntil = time.Now().Add(mcpViewRetention)
	g := v.grant
	var lease Lease
	if g != nil {
		lease = g.lease
	}
	s.mu.Unlock()
	if g != nil {
		go s.suspend(v, g, lease)
	}
	return ""
}
func (s *mcpViews) pull(ctx context.Context, a AppPull) (Pulled, string) {
	if a.Cursor != nil && !mcpValidCursor(*a.Cursor) {
		return Pulled{}, "invalid"
	}
	s.mu.Lock()
	v, r := s.authenticate(a.AppAuth)
	if r != "" {
		s.mu.Unlock()
		return Pulled{}, r
	}
	if v.grant == nil {
		p := Pulled{State: mcpState(v), Events: []json.RawMessage{}}
		s.mu.Unlock()
		return p, ""
	}
	if v.pulling != 0 || s.full() {
		s.mu.Unlock()
		return Pulled{}, "busy"
	}
	g := v.grant
	op, done, intent := s.operation(v, ctx)
	pullID := v.nextOperation
	v.pulling = pullID
	lease := g.lease
	s.mu.Unlock()
	defer done()
	defer func() {
		s.mu.Lock()
		if v.pulling == pullID {
			v.pulling = 0
		}
		s.mu.Unlock()
	}()
	first, err := mcpRelayCall[CurrentPart](op, g.client, "/a/pull", g.claim.GrantKey, RelayPull{V1: V1{V: 1}, RelayID: g.address.RelayID, Lease: lease, Cursor: a.Cursor})
	if r = mcpErr(err, first.Refusal); r != "" {
		return Pulled{}, r
	}
	p := first.Value
	if !mcpValidPart(p, 0) || p.Cursor.Generation != g.claim.Binding.Generation {
		return Pulled{}, "invalid"
	}
	events := append([]json.RawMessage{}, p.Events...)
	if p.Parts == 2 {
		next, e := mcpRelayCall[CurrentPart](op, g.client, "/a/pull-next", g.claim.GrantKey, RelayPullNext{V1: V1{V: 1}, RelayID: g.address.RelayID, Lease: lease, ReadID: p.ReadID, Part: 1})
		if r = mcpErr(e, next.Refusal); r != "" {
			return Pulled{}, r
		}
		n := next.Value
		if !mcpValidPart(n, 1) || n.Parts != 2 || n.ReadID != p.ReadID || !reflect.DeepEqual(n.Cursor, p.Cursor) {
			return Pulled{}, "invalid"
		}
		events = append(events, n.Events...)
	}
	if !mcpValidEvents(events, p.Parts, g.claim.Binding.Generation) {
		return Pulled{}, "invalid"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.intent != intent || v.grant != g || v.mountKey != a.MountKey {
		return Pulled{}, "forbidden"
	}
	return Pulled{State: mcpState(v), Cursor: &p.Cursor, Events: events}, ""
}
func mcpValidCursor(c Cursor) bool {
	return c.Generation > 0 && c.Generation <= mcpSafeInteger && c.Revision >= 0 && c.Revision <= mcpSafeInteger && (c.LayoutRev == nil || (*c.LayoutRev >= 0 && *c.LayoutRev <= mcpSafeInteger))
}
func mcpValidPart(p CurrentPart, part int) bool {
	return mcpTokenValid(p.ReadID) && p.Part == part && (p.Parts == 1 || p.Parts == 2) && len(p.Events) <= 1 && mcpValidCursor(p.Cursor) && (p.Parts != 2 || len(p.Events) == 1)
}
func mcpValidEvents(events []json.RawMessage, parts int, generation int64) bool {
	for i, e := range events {
		var head struct {
			V          int    `json:"v"`
			Kind       string `json:"kind"`
			Generation int64  `json:"generation"`
		}
		if json.Unmarshal(e, &head) != nil || head.V != 1 || head.Generation != generation || (head.Kind != "layout" && head.Kind != "snapshot") || (parts == 2 && ((i == 0 && head.Kind != "layout") || (i == 1 && head.Kind != "snapshot"))) {
			return false
		}
	}
	return true
}
func (s *mcpViews) command(ctx context.Context, a AppCommandRequest) (json.RawMessage, string) {
	if len(a.Request) > 65536 {
		return nil, "too-large"
	}
	s.mu.Lock()
	v, r := s.authenticate(a.AppAuth)
	if r != "" {
		s.mu.Unlock()
		return nil, r
	}
	if v.grant == nil {
		s.mu.Unlock()
		return nil, "forbidden"
	}
	if s.full() {
		s.mu.Unlock()
		return nil, "busy"
	}
	g := v.grant
	op, done, intent := s.operation(v, ctx)
	lease := g.lease
	s.mu.Unlock()
	defer done()
	result, err := mcpRelayCall[json.RawMessage](op, g.client, "/a/command", g.claim.GrantKey, RelayCommand{V1: V1{V: 1}, RelayID: g.address.RelayID, Lease: lease, Request: a.Request})
	if r = mcpErr(err, result.Refusal); r != "" {
		return nil, r
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.intent != intent || v.grant != g || v.mountKey != a.MountKey {
		return nil, "forbidden"
	}
	return result.Value, ""
}
