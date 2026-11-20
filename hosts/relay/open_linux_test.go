//go:build linux

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// The private xdg-open is a copy of this test binary, not a GUI application.
func TestMain(m *testing.M) {
	if os.Getenv("BTR_XDG_FIXTURE") == "1" {
		if len(os.Args) != 2 || os.WriteFile(os.Getenv("BTR_XDG_MARKER"), []byte(os.Args[1]), 0600) != nil {
			os.Exit(2)
		}
		os.Exit(7)
	}
	os.Exit(m.Run())
}

func TestLinuxOpenerUsesPrivatePATH(t *testing.T) {
	dir := t.TempDir()
	fixture := filepath.Join(dir, "xdg-open")
	executable, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture, executable, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	target := filepath.Join(dir, "document with spaces.md")
	command, err := openCommand(target, "")
	if err != nil {
		t.Fatal(err)
	}
	// Guard the exact command before any process starts, including on regressions.
	if command.Err != nil || command.Path != fixture || len(command.Args) != 2 || command.Args[0] != "xdg-open" || command.Args[1] != target {
		t.Fatalf("unexpected opener selection: path=%q args=%q error=%v", command.Path, command.Args, command.Err)
	}
	marker := filepath.Join(dir, "invoked")
	command.Env = append(os.Environ(), "BTR_XDG_FIXTURE=1", "BTR_XDG_MARKER="+marker)
	s := &relay{out: make(chan []byte, 1), outputFailure: make(chan struct{}, 1)}
	receipt, err := s.startLaunchForCode(command, "path-fixture", 4, "")
	if err != nil || receipt != "spawned" {
		t.Fatalf("PATH opener receipt: %q %v", receipt, err)
	}
	launchExit(t, s.out, "path-fixture", 4, 7)
	invoked, err := os.ReadFile(marker)
	if err != nil || string(invoked) != target {
		t.Fatalf("fixture argument = %q, error = %v", invoked, err)
	}
}

func TestExplicitBrowserBootstrapGenerationLifecycle(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "xdg-open"), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	for _, tc := range []struct {
		name, route, body string
		expire            bool
		want              int
	}{
		{"first publication", "/h/generation", `{"generation":5,"ended":false}`, false, http.StatusSeeOther},
		{"first layout", "/h/event", `{"v":1,"kind":"layout","generation":5}`, false, http.StatusSeeOther},
		{"new generation", "/h/generation", `{"generation":6,"ended":false}`, false, http.StatusNotFound},
		{"new layout", "/h/event", `{"v":1,"kind":"layout","generation":6}`, false, http.StatusNotFound},
		{"generation ended", "/h/generation", `{"generation":5,"ended":true}`, false, http.StatusNotFound},
		{"event ended", "/h/event", `{"v":1,"kind":"ended","generation":5}`, false, http.StatusNotFound},
		{"expired", "", "", true, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newRelayHarness(t)
			id, err := secret()
			if err != nil {
				t.Fatal(err)
			}
			body, err := json.Marshal(map[string]any{"open": true, "id": id, "generation": 5})
			if err != nil {
				t.Fatal(err)
			}
			open := func() map[string]any {
				t.Helper()
				res := request(t, h.private, "POST", "http://localhost/h/launch", "host-secret", "", "", body)
				defer res.Body.Close()
				var result map[string]any
				if err := json.NewDecoder(res.Body).Decode(&result); err != nil || res.StatusCode != http.StatusOK {
					t.Fatalf("open response: status=%d result=%v error=%v", res.StatusCode, result, err)
				}
				return result
			}
			if result := open(); result["ok"] != true {
				t.Fatalf("initial open rejected: %v", result)
			}
			if result := open(); result["error"] != "busy" {
				t.Fatalf("pending bootstrap was not busy: %v", result)
			}
			h.relay.mu.Lock()
			path := h.relay.launchFile
			h.relay.mu.Unlock()
			if filepath.Base(path) != "open-1.html" {
				t.Fatalf("unexpected handoff filename: %q", path)
			}
			bootstrap, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			match := regexp.MustCompile(`url=(http://[^"]+)`).FindSubmatch(bootstrap)
			if len(match) != 2 {
				t.Fatal("missing bootstrap URL")
			}
			if tc.route != "" {
				status(t, request(t, h.private, "POST", "http://localhost"+tc.route, "host-secret", "", "", []byte(tc.body)), http.StatusOK)
			}
			if tc.expire {
				h.relay.mu.Lock()
				h.relay.launchExpiry = time.Now().Add(-time.Second)
				h.relay.mu.Unlock()
			}
			public := *h.public
			public.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
			status(t, request(t, &public, "GET", string(match[1]), "", "", "", nil), tc.want)
			status(t, request(t, &public, "GET", string(match[1]), "", "", "", nil), http.StatusNotFound)
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("revoked handoff file remains: %q, %v", path, err)
			}
			h.relay.mu.Lock()
			timer := h.relay.launchTimer
			h.relay.mu.Unlock()
			if timer != nil {
				t.Fatal("revoked handoff retained its expiry timer")
			}
			if tc.want == http.StatusSeeOther {
				if result := open(); result["ok"] != true {
					t.Fatalf("next open rejected: %v", result)
				}
				h.relay.mu.Lock()
				nextPath := h.relay.launchFile
				h.relay.mu.Unlock()
				if filepath.Base(nextPath) != "open-2.html" {
					t.Fatalf("unexpected next handoff filename: first=%q next=%q", path, nextPath)
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("old handoff file recreated: %q, %v", path, err)
				}
			}
			if tc.want == http.StatusNotFound && !tc.expire {
				if result := open(); result["error"] != "stale-generation" {
					t.Fatalf("stale or ended generation accepted: %v", result)
				}
			}
		})
	}
}
