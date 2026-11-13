package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// The real test executable is the controlled child; no desktop application is launched.
func TestLaunchFixtureProcess(t *testing.T) {
	switch os.Getenv("BRAIN_RELAY_LAUNCH_FIXTURE") {
	case "nonzero":
		os.Exit(7)
	case "wait":
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	case "wait-nonzero":
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(7)
	case "marker":
		if err := os.WriteFile(os.Getenv("BRAIN_RELAY_LAUNCH_MARKER"), []byte("started"), 0600); err != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
}

func launchFixture(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestLaunchFixtureProcess$")
	cmd.Env = append(os.Environ(), "BRAIN_RELAY_LAUNCH_FIXTURE="+mode)
	return cmd
}

func launchExit(t *testing.T, output <-chan []byte, id string, generation int64, code int) {
	t.Helper()
	select {
	case data := <-output:
		var frame struct {
			Type       string `json:"t"`
			ID         string `json:"id"`
			Generation int64  `json:"generation"`
			Code       int    `json:"code"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "launch-exit" || frame.ID != id || frame.Generation != generation || frame.Code != code {
			t.Fatalf("unexpected terminal outcome: %+v", frame)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("missing launch outcome")
	}
}

func TestLaunchReceiptsAndTerminalOutcomes(t *testing.T) {
	s := &relay{out: make(chan []byte, 64), outputFailure: make(chan struct{}, 1)}
	missing := exec.Command(filepath.Join(t.TempDir(), "missing-executable"))
	if _, err := s.startLaunch(missing, "missing", 1); err == nil {
		t.Fatal("failed spawn returned a receipt")
	}
	select {
	case frame := <-s.out:
		t.Fatalf("failed spawn emitted terminal outcome: %s", frame)
	default:
	}

	fast := launchFixture("nonzero")
	status, err := s.startLaunch(fast, "quick", 2)
	if err != nil || status != "spawned" {
		t.Fatalf("quick launch: %q %v", status, err)
	}
	launchExit(t, s.out, "quick", 2, 7)

	slow := launchFixture("wait")
	input, err := slow.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	type result struct {
		status string
		err    error
	}
	resultCh := make(chan result, 1)
	go func() { status, err := s.startLaunch(slow, "running", 3); resultCh <- result{status, err} }()
	select {
	case got := <-resultCh:
		if got.err != nil || got.status != "spawned" {
			t.Fatalf("running launch: %+v", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("receipt waited for live child to exit")
	}
	defer func() {
		if slow.Process != nil {
			_ = slow.Process.Kill()
		}
	}()
	select {
	case frame := <-s.out:
		t.Fatalf("live child reported exit: %s", frame)
	default:
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	launchExit(t, s.out, "running", 3, 0)
}

func TestLaunchOutcomeQueueFailureDisconnects(t *testing.T) {
	s := &relay{out: make(chan []byte), outputFailure: make(chan struct{}, 1)}
	status, err := s.startLaunch(launchFixture("nonzero"), "undelivered", 1)
	if err != nil || status != "spawned" {
		t.Fatalf("launch: %q %v", status, err)
	}
	select {
	case <-s.outputFailure:
	case <-time.After(10 * time.Second):
		t.Fatal("undeliverable terminal outcome did not signal failure")
	}
}

func TestFileOpenRefusalDoesNotDisconnectHost(t *testing.T) {
	h := newRelayHarness(t)
	status(t, request(t, h.private, "POST", "http://localhost/h/event", "host-secret", "", "", []byte(`{"v":1,"kind":"layout","generation":5}`)), 200)
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	held, err := h.relay.files.Prepare(root, path)
	if err != nil {
		t.Fatal(err)
	}
	id, err := secret()
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"id": held.ID, "app": "not-an-allowed-application", "launchId": id, "generation": 0})
	if err != nil {
		t.Fatal(err)
	}
	response := request(t, h.private, "POST", "http://localhost/h/file/open", "host-secret", "", "", body)
	var refusal map[string]any
	if err := json.NewDecoder(response.Body).Decode(&refusal); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || refusal["ok"] != false || refusal["error"] != "launch-failed" {
		t.Fatalf("unexpected opener refusal: %d %v", response.StatusCode, refusal)
	}
	verify := request(t, h.private, "POST", "http://localhost/h/file/verify", "host-secret", "", "", []byte(`{"id":"`+held.ID+`"}`))
	var result map[string]any
	if err := json.NewDecoder(verify.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	verify.Body.Close()
	if verify.StatusCode != 200 || result["ok"] != true {
		t.Fatalf("host unavailable after refusal: %d %v", verify.StatusCode, result)
	}
}

func TestLaunchObserverCapacityPrecedesProcessStart(t *testing.T) {
	s := &relay{out: make(chan []byte, 64), outputFailure: make(chan struct{}, 1)}
	inputs := make([]io.WriteCloser, 0, 32)
	defer func() {
		for _, input := range inputs {
			_ = input.Close()
		}
	}()
	for range 32 {
		cmd := launchFixture("wait")
		input, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, input)
		status, err := s.startLaunch(cmd, "live", 1)
		if err != nil || status != "spawned" {
			t.Fatalf("starting observer: %q %v", status, err)
		}
	}
	marker := filepath.Join(t.TempDir(), "started")
	extra := launchFixture("marker")
	extra.Env = append(extra.Env, "BRAIN_RELAY_LAUNCH_MARKER="+marker)
	if _, err := s.startLaunch(extra, "overflow", 1); err == nil {
		t.Fatal("observer limit accepted another process")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("over-capacity process had an effect: %v", err)
	}
	for _, input := range inputs {
		_ = input.Close()
	}
	for range 32 {
		launchExit(t, s.out, "live", 1, 0)
	}
}

func TestLaunchReservationPreservesFirstBootstrap(t *testing.T) {
	h := newRelayHarness(t)
	type result struct {
		value map[string]any
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for range 2 {
		go func() {
			<-start
			req, err := http.NewRequest("POST", "http://localhost/h/launch", bytes.NewBufferString(`{}`))
			if err != nil {
				results <- result{err: err}
				return
			}
			req.Header.Set("Authorization", "Bearer host-secret")
			response, err := h.private.Do(req)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer response.Body.Close()
			var value map[string]any
			err = json.NewDecoder(response.Body).Decode(&value)
			results <- result{value: value, err: err}
		}()
	}
	close(start)
	successes, busy := 0, 0
	for range 2 {
		r := <-results
		if r.err != nil {
			t.Fatal(r.err)
		}
		if r.value["ok"] == true {
			successes++
		} else if r.value["error"] == "busy" {
			busy++
		} else {
			t.Fatalf("unexpected launch result: %v", r.value)
		}
	}
	if successes != 1 || busy != 1 {
		t.Fatalf("simultaneous launches: %d succeeded, %d busy", successes, busy)
	}
	path := filepath.Join(h.relay.dir, "open.html")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	res := request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", []byte(`{}`))
	var denied map[string]any
	if err := json.NewDecoder(res.Body).Decode(&denied); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if denied["error"] != "busy" {
		t.Fatalf("unconsumed launch was not busy: %v", denied)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, after) {
		t.Fatal("busy request overwrote the first bootstrap")
	}
	matches := regexp.MustCompile(`url=(http://[^"]+)`).FindSubmatch(original)
	if len(matches) != 2 {
		t.Fatal("missing launch URL")
	}
	public := *h.public
	public.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	launch := request(t, &public, "GET", string(matches[1]), "", "", "", nil)
	status(t, launch, http.StatusSeeOther)
	again := request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", []byte(`{}`))
	var accepted map[string]any
	if err := json.NewDecoder(again.Body).Decode(&accepted); err != nil {
		t.Fatal(err)
	}
	again.Body.Close()
	if accepted["ok"] != true {
		t.Fatalf("consumed launch did not free lane: %v", accepted)
	}
	h.relay.mu.Lock()
	h.relay.launchExpiry = time.Now().Add(-time.Second)
	h.relay.mu.Unlock()
	expired := request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", []byte(`{}`))
	accepted = nil
	if err := json.NewDecoder(expired.Body).Decode(&accepted); err != nil {
		t.Fatal(err)
	}
	expired.Body.Close()
	if accepted["ok"] != true {
		t.Fatalf("expired launch did not free lane: %v", accepted)
	}
}

func TestLaunchFailureClearsOnlyMatchingReservation(t *testing.T) {
	h := newRelayHarness(t)
	h.relay.outputFailure = make(chan struct{}, 1)
	prepare := func() map[string]any {
		response := request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", []byte(`{}`))
		defer response.Body.Close()
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	currentCode := func() string {
		h.relay.mu.Lock()
		defer h.relay.mu.Unlock()
		return h.relay.launch
	}
	awaitObserver := func() {
		deadline := time.Now().Add(10 * time.Second)
		for {
			h.relay.mu.Lock()
			count := h.relay.observers
			h.relay.mu.Unlock()
			if count == 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("launch observer did not finish")
			}
			time.Sleep(time.Millisecond)
		}
	}
	if got := prepare(); got["ok"] != true {
		t.Fatalf("prepare: %v", got)
	}
	first := currentCode()
	if _, err := h.relay.startLaunchForCode(launchFixture("nonzero"), "matching", 0, first); err != nil {
		t.Fatal(err)
	}
	launchExit(t, h.relay.out, "matching", 0, 7)
	awaitObserver()
	if got := prepare(); got["ok"] != true {
		t.Fatalf("matching failure did not free lane: %v", got)
	}
	old := currentCode()
	slow := launchFixture("wait-nonzero")
	input, err := slow.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if _, err := h.relay.startLaunchForCode(slow, "old", 0, old); err != nil {
		t.Fatal(err)
	}
	public := *h.public
	public.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	status(t, request(t, &public, "GET", h.base+"/launch/"+old, "", "", "", nil), http.StatusSeeOther)
	if got := prepare(); got["ok"] != true {
		t.Fatalf("consumed old lane not available: %v", got)
	}
	newer := currentCode()
	if newer == old || newer == "" {
		t.Fatal("new reservation not created")
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	launchExit(t, h.relay.out, "old", 0, 7)
	awaitObserver()
	if got := prepare(); got["error"] != "busy" {
		t.Fatalf("old failure cleared newer reservation: %v", got)
	}
	if currentCode() != newer {
		t.Fatal("old failure replaced newer launch code")
	}
}

func TestFirstBrowserLaunchAcceptsHostGenerationBeforePublication(t *testing.T) {
	h := newRelayHarness(t)
	// Make bootstrap creation fail before any OS opener can be invoked.
	path := filepath.Join(h.relay.dir, "open.html")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	id, err := secret()
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"open": true, "id": id, "generation": 5})
	if err != nil {
		t.Fatal(err)
	}
	response := request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", body)
	status(t, response, http.StatusInternalServerError)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	response = request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", []byte(`{}`))
	defer response.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || result["ok"] != true {
		t.Fatalf("failed first launch did not free its reservation: %d %v", response.StatusCode, result)
	}
}
