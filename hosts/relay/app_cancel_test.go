package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func cancelFixture(t *testing.T) (*appBridge, *appGrant, *appOperation) {
	t.Helper()
	s := &relay{generation: 1, out: make(chan []byte, 8), outputFailure: make(chan struct{}, 1)}
	a, err := newAppBridge(s, "/tmp/relay.sock")
	if err != nil {
		t.Fatal(err)
	}
	owner := Owner{Host: "code", SessionID: "session"}
	p := &appApproval{owner: owner, generation: 1, state: "claimed"}
	g := &appGrant{id: "grant", key: "key", approval: p, active: true, lease: Lease{Epoch: 1, ID: "lease"}, leaseUntil: time.Now().Add(time.Minute)}
	p.grant = g
	a.grants[g.id] = g
	o := &appOperation{scope: Guard{RequestID: "request", RelayID: a.address.RelayID, GrantID: g.id, Owner: owner, Generation: 1, Lease: g.lease}, kind: "current", deadline: time.Now().Add(time.Minute), replies: make(chan json.RawMessage, 2), done: make(chan struct{}), admitted: true}
	a.operations[o.scope.RequestID] = o
	return a, g, o
}

func TestOperationRevocationWakesWaiterAndEmitsExactScope(t *testing.T) {
	a, g, o := cancelFixture(t)
	req := httptest.NewRequest("POST", "/a/pull", nil)
	w := httptest.NewRecorder()
	finished := make(chan struct{})
	go func() { a.awaitOperation(w, req, o, false); close(finished) }()
	a.mu.Lock()
	a.retireGrant(g, time.Now())
	a.mu.Unlock()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("waiter not woken")
	}
	if !strings.Contains(w.Body.String(), `"error":"forbidden"`) {
		t.Fatal(w.Body.String())
	}
	var f AppCancelled
	if err := json.Unmarshal(<-a.relay.out, &f); err != nil || f.T != "app-cancel" || f.Scope != o.scope {
		t.Fatalf("wrong cancel: %+v %v", f, err)
	}
	// A late retirement of the old operation cannot remove or cancel a replacement.
	replacement := *o
	replacement.done = make(chan struct{})
	replacement.scope.Lease.Epoch++
	a.mu.Lock()
	a.operations[o.scope.RequestID] = &replacement
	a.retireOperation(o, "timeout")
	a.mu.Unlock()
	select {
	case <-replacement.done:
		t.Fatal("replacement cancelled")
	default:
	}
	select {
	case <-a.relay.out:
		t.Fatal("duplicate cancel")
	default:
	}
}

func TestOperationTimeoutAndContinuationRetirement(t *testing.T) {
	a, _, o := cancelFixture(t)
	o.deadline = time.Now().Add(-time.Second)
	w := httptest.NewRecorder()
	a.awaitOperation(w, httptest.NewRequest("POST", "/a/pull", nil), o, false)
	if !strings.Contains(w.Body.String(), `"error":"timeout"`) {
		t.Fatal(w.Body.String())
	}
	<-a.relay.out
	a, _, o = cancelFixture(t)
	o.parts = 2
	o.nextPart = 1
	first := json.RawMessage(`{"v":1,"ok":true,"value":{"part":0}}`)
	second := json.RawMessage(`{"v":1,"ok":true,"value":{"part":1}}`)
	o.replies <- first
	o.replies <- second
	w = httptest.NewRecorder()
	a.awaitOperation(w, httptest.NewRequest("POST", "/a/pull", nil), o, false)
	if w.Body.String() != string(first) {
		t.Fatal(w.Body.String())
	}
	select {
	case <-o.done:
		t.Fatal("continuation retired early")
	default:
	}
	o.context = context.Background()
	w = httptest.NewRecorder()
	a.awaitOperation(w, httptest.NewRequest("POST", "/a/pull-next", nil), o, true)
	if w.Body.String() != string(second) {
		t.Fatal(w.Body.String())
	}
	select {
	case <-o.done:
	default:
		t.Fatal("continuation not retired")
	}
	var f AppCancelled
	if err := json.Unmarshal(<-a.relay.out, &f); err != nil || f.Scope != o.scope {
		t.Fatalf("cancel %v", err)
	}
}

func TestCancelQueueFailureFailsClosedAndUnadmittedDoesNotNotify(t *testing.T) {
	a, _, o := cancelFixture(t)
	o.admitted = false
	a.mu.Lock()
	a.retireOperation(o, "busy")
	a.mu.Unlock()
	select {
	case <-a.relay.out:
		t.Fatal("unadmitted operation notified")
	default:
	}
	a, _, o = cancelFixture(t)
	for i := 0; i < cap(a.relay.out); i++ {
		a.relay.out <- []byte("occupied")
	}
	a.mu.Lock()
	a.retireOperation(o, "forbidden")
	a.mu.Unlock()
	select {
	case <-a.relay.outputFailure:
	default:
		t.Fatal("cancel queue failure not fatal")
	}
}

func TestGenerationRevokeInvalidatesPendingBrowserLaunch(t *testing.T) {
	a, g, o := cancelFixture(t)
	s := a.relay
	s.app = a
	s.host = "localhost"
	s.token = "existing-browser-session"
	s.assets = t.TempDir()
	if err := os.WriteFile(filepath.Join(s.assets, "app.js"), []byte("session"), 0600); err != nil {
		t.Fatal(err)
	}
	s.launch = "unredeemed"
	s.launchBound = true
	s.launchGeneration = 1
	s.launchExpiry = time.Now().Add(time.Minute)
	s.launchFile = filepath.Join(t.TempDir(), "open.html")
	if err := os.WriteFile(s.launchFile, []byte("handoff"), 0600); err != nil {
		t.Fatal(err)
	}
	path := s.launchFile
	a.approvals["claimed"] = g.approval
	a.owner, a.ownerGeneration = g.approval.owner, 1
	revoke := []byte(`{"v":1,"target":{"kind":"generation","owner":{"host":"code","sessionId":"session"},"generation":1},"reason":"generation-ended"}`)
	w := httptest.NewRecorder()
	a.host(w, httptest.NewRequest("POST", "/h/app/revoke", nil), revoke)
	if !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("revocation not acknowledged: %s", w.Body.String())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("handoff still exists: %v", err)
	}
	w = httptest.NewRecorder()
	s.browserHandler(w, httptest.NewRequest("GET", "http://localhost/launch/unredeemed", nil))
	if w.Code != 404 {
		t.Fatalf("revoked launch returned %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.browserHandler(w, httptest.NewRequest("GET", "http://localhost/s/existing-browser-session/app.js", nil))
	if w.Code != 200 || w.Body.String() != "session" {
		t.Fatalf("redeemed session no longer works: %d %q", w.Code, w.Body.String())
	}
	select {
	case <-o.done:
	default:
		t.Fatal("grant operation was not retired")
	}
	if a.current(1) {
		t.Fatal("revoked generation remains current")
	}
	s.hostToken = "host-secret"
	req := httptest.NewRequest("POST", "/h/launch", strings.NewReader(`{"link":true,"generation":1}`))
	req.Header.Set("Authorization", "Bearer host-secret")
	w = httptest.NewRecorder()
	s.hostHandler(w, req)
	if !strings.Contains(w.Body.String(), `"error":"stale-generation"`) {
		t.Fatalf("revoked generation accepted another launch: %s", w.Body.String())
	}
}

func TestGenerationRevokeBeforePublicationAndScope(t *testing.T) {
	for _, tc := range []struct {
		name       string
		generation int64
		owner      Owner
		revoked    bool
	}{
		{"before-publication", 0, Owner{}, true},
		{"newer-generation", 2, Owner{}, false},
		{"different-owner", 1, Owner{Host: "code", SessionID: "other"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _, _ := cancelFixture(t)
			a.relay.generation = tc.generation
			if tc.owner != (Owner{}) {
				a.owner, a.ownerGeneration = tc.owner, 1
			}
			a.relay.launch = "pending"
			a.relay.launchExpiry = time.Now().Add(time.Minute)
			w := httptest.NewRecorder()
			a.host(w, httptest.NewRequest("POST", "/h/app/revoke", nil), []byte(`{"v":1,"target":{"kind":"generation","owner":{"host":"code","sessionId":"session"},"generation":1},"reason":"generation-ended"}`))
			if !strings.Contains(w.Body.String(), `"ok":true`) {
				t.Fatal(w.Body.String())
			}
			if got := a.relay.launch == ""; got != tc.revoked {
				t.Fatalf("launch invalidated = %v, want %v", got, tc.revoked)
			}
		})
	}
}

func TestGenerationRevokeStopsLegacyHandoffAndDispatch(t *testing.T) {
	a, _, _ := cancelFixture(t)
	s := a.relay
	s.app = a
	s.hostToken = "host-secret"
	s.host = "localhost"
	s.dir = t.TempDir()
	post := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer host-secret")
		w := httptest.NewRecorder()
		s.hostHandler(w, req)
		return w
	}
	if w := post("/h/launch", `{}`); !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("legacy launch: %s", w.Body.String())
	}
	code, path := s.launch, s.launchFile
	if path == "" {
		t.Fatal("legacy handoff was not tracked")
	}
	revoke := `{"v":1,"target":{"kind":"generation","owner":{"host":"code","sessionId":"session"},"generation":1},"reason":"generation-ended"}`
	if w := post("/h/app/revoke", revoke); !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("revoke: %s", w.Body.String())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("legacy handoff still exists: %v", err)
	}
	if w := post("/h/launch", `{}`); !strings.Contains(w.Body.String(), `"error":"stale-generation"`) {
		t.Fatalf("legacy launch after revoke: %s", w.Body.String())
	}
	marker := filepath.Join(t.TempDir(), "started")
	command := launchFixture("marker")
	command.Env = append(command.Env, "BRAIN_RELAY_LAUNCH_MARKER="+marker)
	if _, err := s.startLaunchForCode(command, "late", 1, code); err == nil {
		t.Fatal("revoked launch dispatched")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("revoked launch started a process: %v", err)
	}
	if w := post("/h/generation", `{"generation":2}`); w.Code != 200 {
		t.Fatalf("next generation: %d %s", w.Code, w.Body.String())
	}
	if w := post("/h/launch", `{}`); !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("next generation launch: %s", w.Body.String())
	}
}
