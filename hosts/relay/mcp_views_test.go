package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type lifecycleRoundTripper func(*http.Request) (*http.Response, error)

func (f lifecycleRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func lifecycleReply(value any) *http.Response {
	body, _ := json.Marshal(map[string]any{"v": 1, "ok": true, "value": value})
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}
}

func lifecycleToken(t *testing.T) Token {
	t.Helper()
	token, err := mcpRandomToken()
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func lifecycleView(t *testing.T) (*mcpViews, AppMount, AppAuth) {
	t.Helper()
	manifest := Manifest{V1: V1{V: 1}, WireRevision: 1, UIBuildID: Hex64(strings.Repeat("a", 64)), AssetDigest: Hex64(strings.Repeat("b", 64))}
	s, err := newMCPViews(manifest)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	identity := UiIdentity{V1: V1{V: 1}, WireRevision: 1, UIBuildID: manifest.UIBuildID}
	reset, refusal := s.reset(identity)
	if refusal != "" {
		t.Fatalf("reset: %s", refusal)
	}
	mount := AppMount{UiIdentity: identity, AssetDigest: manifest.AssetDigest, ServerEpoch: s.epoch, ViewKey: reset.Bootstrap.ViewKey}
	mounted, refusal := s.mount(context.Background(), mount)
	if refusal != "" {
		t.Fatalf("mount: %s", refusal)
	}
	return s, mount, AppAuth{V1: V1{V: 1}, ServerEpoch: s.epoch, ViewKey: mount.ViewKey, MountKey: mounted.MountKey}
}

func TestMCPUnpairedViewCanPairAfterIdle(t *testing.T) {
	for _, detached := range []bool{false, true} {
		name := "reset"
		if detached {
			name = "detach"
		}
		t.Run(name, func(t *testing.T) {
			s, _, auth := lifecycleView(t)
			if detached {
				client := &mcpRelayClient{http: &http.Client{Transport: lifecycleRoundTripper(func(*http.Request) (*http.Response, error) { return lifecycleReply(nil), nil })}}
				s.mu.Lock()
				s.views[auth.ViewKey].grant = &mcpViewGrant{client: client, address: RelayAddress{RelayID: lifecycleToken(t)}, claim: Claimed{GrantID: lifecycleToken(t)}}
				s.mu.Unlock()
				if _, refusal := s.detach(context.Background(), auth); refusal != "" {
					t.Fatalf("detach: %s", refusal)
				}
			}
			dir, err := privateTempDir()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			socket := filepath.Join(dir, "relay.sock")
			listener, err := privateListener(socket)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := privacyEvidence(dir, socket); err != nil {
				t.Fatalf("relay privacy evidence: %v; %s", err, privacyTestDiagnostic(dir, socket))
			}
			if err := mcpRelaySocketValid(socket); err != nil {
				t.Fatalf("MCP relay socket validation: %v", err)
			}
			relayID, pairID, secret := lifecycleToken(t), lifecycleToken(t), lifecycleToken(t)
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/a/claim" {
					var claim Claim
					if err := json.NewDecoder(r.Body).Decode(&claim); err != nil {
						http.Error(w, err.Error(), 400)
						return
					}
					value := Claimed{GrantID: lifecycleToken(t), GrantKey: lifecycleToken(t), Binding: Binding{RelayID: relayID, Recipient: claim.Recipient, Approval: mcpJSON(ChatRef{Kind: "chat", PairID: pairID}), Owner: Owner{Host: "code", SessionID: "session"}, Generation: 1, Label: "test"}}
					json.NewEncoder(w).Encode(WireSuccess[Claimed]{V1: V1{V: 1}, Success: Success[Claimed]{OK: true, Value: value}})
					return
				}
				json.NewEncoder(w).Encode(WireSuccess[*struct{}]{V1: V1{V: 1}, Success: Success[*struct{}]{OK: true}})
			})}
			go server.Serve(listener)
			t.Cleanup(func() { server.Close() })
			s.mu.Lock()
			s.views[auth.ViewKey].activeUntil = s.views[auth.ViewKey].activeUntil.Add(-20 * time.Second)
			s.mu.Unlock()
			s.sweep()
			s.mu.Lock()
			view := s.views[auth.ViewKey]
			live := view != nil && view.mountKey == auth.MountKey && time.Now().Before(view.activeUntil)
			s.mu.Unlock()
			if !live {
				t.Fatal("unpaired mount expired before pair")
			}
			envelope := ChatEnvelope{V1: V1{V: 1}, Kind: "chat", Relay: RelayAddress{Socket: socket, RelayID: relayID}, PairID: pairID, Secret: secret, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
			attached, refusal := s.pair(context.Background(), AppPair{AppAuth: auth, Envelope: envelope})
			if refusal != "" || attached.Kind != "attached" {
				t.Fatalf("pair after idle: attached=%+v refusal=%q", attached, refusal)
			}
			s.close()
		})
	}
}

func TestMCPRemountOldPullCleanupPreservesNewReservation(t *testing.T) {
	s, mount, oldAuth := lifecycleView(t)
	started := make(chan int, 2)
	releaseOld := make(chan struct{})
	releaseNew := make(chan struct{})
	var releaseOldOnce, releaseNewOnce sync.Once
	defer releaseOldOnce.Do(func() { close(releaseOld) })
	defer releaseNewOnce.Do(func() { close(releaseNew) })
	var mu sync.Mutex
	count := 0
	readID := lifecycleToken(t)
	client := &mcpRelayClient{http: &http.Client{Transport: lifecycleRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/a/pull" {
			return lifecycleReply(nil), nil
		}
		mu.Lock()
		count++
		n := count
		mu.Unlock()
		started <- n
		if n == 1 {
			<-releaseOld
		} else {
			<-releaseNew
		}
		return lifecycleReply(CurrentPart{ReadID: readID, Part: 0, Parts: 1, Cursor: Cursor{Generation: 1}, Events: []json.RawMessage{}}), nil
	})}}
	s.mu.Lock()
	s.views[oldAuth.ViewKey].grant = &mcpViewGrant{client: client, address: RelayAddress{RelayID: lifecycleToken(t)}, claim: Claimed{GrantID: lifecycleToken(t), GrantKey: lifecycleToken(t), Binding: Binding{Generation: 1, Owner: Owner{Host: "code", SessionID: "session"}}}, lease: Lease{Epoch: 1, ID: lifecycleToken(t)}}
	s.mu.Unlock()
	oldDone := make(chan string, 1)
	go func() { _, refusal := s.pull(context.Background(), AppPull{AppAuth: oldAuth}); oldDone <- refusal }()
	if n := <-started; n != 1 {
		t.Fatalf("first pull order: %d", n)
	}
	mounted, refusal := s.mount(context.Background(), mount)
	if refusal != "" {
		t.Fatalf("remount: %s", refusal)
	}
	newAuth := oldAuth
	newAuth.MountKey = mounted.MountKey
	newDone := make(chan string, 1)
	go func() { _, refusal := s.pull(context.Background(), AppPull{AppAuth: newAuth}); newDone <- refusal }()
	select {
	case n := <-started:
		if n != 2 {
			t.Fatalf("second pull order: %d", n)
		}
	case refusal := <-newDone:
		t.Fatalf("new pull did not reserve after remount: %q", refusal)
	}
	releaseOldOnce.Do(func() { close(releaseOld) })
	<-oldDone
	thirdDone := make(chan string, 1)
	go func() { _, refusal := s.pull(context.Background(), AppPull{AppAuth: newAuth}); thirdDone <- refusal }()
	select {
	case refusal := <-thirdDone:
		if refusal != "busy" {
			t.Fatalf("old cleanup cleared new reservation: %q", refusal)
		}
	case n := <-started:
		t.Fatalf("old cleanup admitted another pull: %d", n)
	}
	releaseNewOnce.Do(func() { close(releaseNew) })
	if refusal := <-newDone; refusal != "" {
		t.Fatalf("new pull: %s", refusal)
	}
}
