package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type relayHarness struct {
	relay   *relay
	private *http.Client
	public  *http.Client
	base    string
	socket  string
}

func newRelayHarness(t *testing.T) *relayHarness {
	t.Helper()
	s := &relay{hostToken: "host-secret", token: "browser-secret", assets: t.TempDir(), dir: t.TempDir(), clients: make(map[chan []byte]struct{}), pending: make(map[string]chan json.RawMessage), out: make(chan []byte, 64), files: NewFileAuthority()}
	dir, err := os.MkdirTemp("", "btr-t-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	unix, err := net.Listen("unix", filepath.Join(dir, "s"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.files.Close)
	private := &http.Server{Handler: http.HandlerFunc(s.hostHandler)}
	go private.Serve(unix)
	t.Cleanup(func() { private.Close() })
	public := httptest.NewUnstartedServer(http.HandlerFunc(s.browserHandler))
	s.host = public.Listener.Addr().String()
	public.Start()
	t.Cleanup(public.Close)
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", unix.Addr().String())
	}}
	t.Cleanup(transport.CloseIdleConnections)
	return &relayHarness{s, &http.Client{Transport: transport, Timeout: 5 * time.Second}, public.Client(), public.URL, unix.Addr().String()}
}
func request(t *testing.T, c *http.Client, method, url, token, origin, host string, data []byte) *http.Response {
	t.Helper()
	r, err := http.NewRequest(method, url, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if host != "" {
		r.Host = host
	}
	r.Header.Set("Content-Type", "application/json")
	res, err := c.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	return res
}
func status(t *testing.T, response *http.Response, want int) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != want {
		b, _ := io.ReadAll(response.Body)
		t.Fatalf("status %d, want %d: %s", response.StatusCode, want, b)
	}
}
func TestPrivateAndPublicTransportBoundary(t *testing.T) {
	h := newRelayHarness(t)
	hostURL := "http://localhost/h/event"
	event := []byte(`{"v":1,"kind":"layout","generation":1}`)
	r := request(t, h.private, "POST", hostURL, "wrong", "", "", event)
	if r.StatusCode != 401 {
		t.Fatalf("unauthorized status %d", r.StatusCode)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if len(b) != 0 {
		t.Fatalf("unauthorized response not empty: %q", b)
	}
	status(t, request(t, h.private, "POST", hostURL, "host-secret", "", "", event), 200)
	status(t, request(t, h.public, "POST", h.base+"/h/event", "host-secret", h.base, "", event), 404)
	prefix := h.base + "/s/browser-secret/"
	status(t, request(t, h.public, "GET", prefix, "", "", "evil.example", nil), 403)
	status(t, request(t, h.public, "POST", prefix+"command", "", "http://evil.example", "", []byte(`{}`)), 403)
	status(t, request(t, h.public, "GET", h.base+"/s/wrong/", "", "", "", nil), 404)
	status(t, request(t, h.private, "POST", hostURL, "host-secret", "", "", []byte(`{"v":1,"kind":"snapshot","generation":0,"revision":1}`)), 409)
	status(t, request(t, h.private, "POST", hostURL, "host-secret", "", "", append([]byte(`{"x":"`), append(bytes.Repeat([]byte("x"), 4194304), []byte(`"}`)...)...)), 413)
}
func TestCommandReadinessAndGenerationOverTransport(t *testing.T) {
	h := newRelayHarness(t)
	prefix := h.base + "/s/browser-secret/"
	hostURL := "http://localhost/h/"
	res := request(t, h.public, "POST", prefix+"command", "", h.base, "", []byte(`{"op":"x"}`))
	var disconnected map[string]any
	json.NewDecoder(res.Body).Decode(&disconnected)
	res.Body.Close()
	if disconnected["error"] != "disconnected" {
		t.Fatalf("command before initialization: %v", disconnected)
	}
	stream := request(t, h.public, "GET", prefix+"events", "", "", "", nil)
	defer stream.Body.Close()
	if stream.StatusCode != 200 {
		t.Fatal(stream.Status)
	}
	var frame map[string]any
	select {
	case raw := <-h.relay.out:
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing client frame")
	}
	seq := frame["seq"]
	for _, body := range []string{`{"v":1,"kind":"layout","generation":2}`, `{"v":1,"kind":"snapshot","generation":2,"revision":3}`} {
		status(t, request(t, h.private, "POST", hostURL+"event", "host-secret", "", "", []byte(body)), 200)
	}
	ready, _ := json.Marshal(map[string]any{"seq": seq})
	status(t, request(t, h.private, "POST", hostURL+"ready", "host-secret", "", "", ready), 200)
	scanner := bufio.NewScanner(stream.Body)
	for range 2 {
		if !scanner.Scan() || !strings.HasPrefix(scanner.Text(), "data: ") {
			t.Fatalf("missing event: %q %v", scanner.Text(), scanner.Err())
		}
		if !scanner.Scan() {
			t.Fatal("missing event separator")
		}
	}
	status(t, request(t, h.private, "POST", hostURL+"event", "host-secret", "", "", []byte(`{"v":1,"kind":"snapshot","generation":2,"revision":2}`)), 409)
	status(t, request(t, h.private, "POST", hostURL+"event", "host-secret", "", "", []byte(`{"v":1,"kind":"invalid","generation":3}`)), 400)
	status(t, request(t, h.private, "POST", hostURL+"event", "host-secret", "", "", []byte(`{"v":1,"kind":"snapshot","generation":2,"revision":4}`)), 200)
	status(t, request(t, h.private, "POST", hostURL+"event", "host-secret", "", "", []byte(`{"v":1,"kind":"ended","generation":3}`)), 200)
	res = request(t, h.public, "POST", prefix+"command", "", h.base, "", []byte(`{"op":"x"}`))
	disconnected = nil
	json.NewDecoder(res.Body).Decode(&disconnected)
	res.Body.Close()
	if disconnected["error"] != "disconnected" {
		t.Fatalf("ended generation still accepted command: %v", disconnected)
	}
}
