package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestCommandCapacityAndCancellation(t *testing.T) {
	h := newRelayHarness(t)
	prefix := h.base + "/s/browser-secret/"
	stream := request(t, h.public, "GET", prefix+"events", "", "", "", nil)
	defer stream.Body.Close()
	var announced map[string]any
	select {
	case frame := <-h.relay.out:
		if err := json.Unmarshal(frame, &announced); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no client announcement")
	}
	for _, body := range []string{`{"v":1,"kind":"layout","generation":1}`, `{"v":1,"kind":"snapshot","generation":1,"revision":1}`} {
		status(t, request(t, h.private, "POST", "http://localhost/h/event", "host-secret", "", "", []byte(body)), 200)
	}
	ready, _ := json.Marshal(map[string]any{"seq": announced["seq"]})
	status(t, request(t, h.private, "POST", "http://localhost/h/ready", "host-secret", "", "", ready), 200)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	completed := make(chan struct{}, 16)
	for range 16 {
		go func() {
			defer func() { completed <- struct{}{} }()
			req, err := http.NewRequestWithContext(ctx, "POST", prefix+"command", bytes.NewBufferString(`{}`))
			if err != nil {
				return
			}
			req.Header.Set("Origin", h.base)
			req.Header.Set("Content-Type", "application/json")
			res, err := h.public.Do(req)
			if err == nil {
				res.Body.Close()
			}
		}()
	}
	for range 16 {
		select {
		case <-h.relay.out:
		case <-time.After(5 * time.Second):
			t.Fatal("commands did not reach host")
		}
	}
	res := request(t, h.public, "POST", prefix+"command", "", h.base, "", []byte(`{}`))
	var response map[string]any
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if response["error"] != "busy" {
		t.Fatalf("seventeenth command: %v", response)
	}
	cancel()
	for range 16 {
		select {
		case <-completed:
		case <-time.After(5 * time.Second):
			t.Fatal("cancelled command did not return")
		}
	}
	// Cancellation must eventually release slots; no host reply is required.
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.relay.mu.Lock()
		remaining := len(h.relay.pending)
		h.relay.mu.Unlock()
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancelled commands retained capacity")
		}
		time.Sleep(time.Millisecond)
	}
}
