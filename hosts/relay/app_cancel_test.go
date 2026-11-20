package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
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
