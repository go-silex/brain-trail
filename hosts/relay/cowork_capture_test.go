package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCoworkDetector(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Claude")
	for _, tc := range []struct {
		path string
		want bool
	}{
		{filepath.Join(root, "local-agent-mode-sessions", "a", "b", "local_123", "outputs"), true},
		{filepath.Join(root, "local-agent-mode-sessions", "a", "b", "agent", "local_ditto_123", "outputs"), true},
		{filepath.Join(filepath.Dir(root), "project", "local-agent-mode-sessions", "a", "b", "local_123"), false},
		{filepath.Join(root, "local-agent-mode-sessions", "a", "local_123"), false},
		{filepath.Join(root, "xlocal-agent-mode-sessions", "a", "b", "local_123"), false},
		{filepath.Join("relative", "local-agent-mode-sessions", "a", "b", "local_123"), false},
	} {
		if got := coworkTaskAt(tc.path, root, false) != ""; got != tc.want {
			t.Errorf("%q: %v", tc.path, got)
		}
	}
}
func TestCoworkDetectorPlatformRoots(t *testing.T) {
	root := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("APPDATA", root)
		t.Setenv("LOCALAPPDATA", root)
		for _, cwd := range []string{
			filepath.Join(root, "Claude", "local-agent-mode-sessions", "a", "b", "local_1", "outputs"),
			filepath.Join(root, "Packages", "Claude_package", "LocalCache", "Roaming", "Claude", "local-agent-mode-sessions", "a", "b", "agent", "local_ditto_1", "outputs"),
		} {
			if !isLocalCowork(cwd) {
				t.Fatalf("trusted Windows root rejected: %q", cwd)
			}
		}
	} else {
		config, err := os.UserConfigDir()
		if err != nil {
			t.Fatal(err)
		}
		cwd := filepath.Join(config, "Claude", "local-agent-mode-sessions", "a", "b", "local_1", "outputs")
		if !isLocalCowork(cwd) {
			t.Fatalf("trusted root rejected: %q", cwd)
		}
	}
}

func TestCoworkProjection(t *testing.T) {
	for _, tc := range []struct{ tool, field, kind string }{{"Read", "file_path", "read"}, {"Write", "file_path", "write"}, {"Edit", "file_path", "write"}, {"NotebookEdit", "notebook_path", "write"}} {
		t.Run(tc.tool, func(t *testing.T) {
			var p coworkPayload
			file := filepath.Join(t.TempDir(), "test")
			_ = json.Unmarshal([]byte(fmt.Sprintf(`{"hook_event_name":"PostToolUse","tool_name":%q,"tool_use_id":"1","tool_input":{%q:%q}}`, tc.tool, tc.field, file)), &p)
			r, _, ok := projectCowork(p, 1)
			if !ok || len(r.Files) != 1 || r.Files[0].K != tc.kind {
				t.Fatalf("%+v", r)
			}
			p.Event = "PostToolUseFailure"
			r, _, _ = projectCowork(p, 1)
			if r.Ok || len(r.Files) != 0 {
				t.Fatal(r)
			}
			p.Event = "PostToolUse"
			p.RawResponse = []byte(`{"is_error":true}`)
			r, _, _ = projectCowork(p, 1)
			if r.Ok || len(r.Files) != 0 {
				t.Fatal(r)
			}
		})
	}
	for _, name := range []string{"Glob", "Grep"} {
		t.Run(name, func(t *testing.T) {
			volumeRoot := filepath.VolumeName(t.TempDir()) + string(os.PathSeparator)
			cwd, base := filepath.Join(volumeRoot, "cwd"), filepath.Join(volumeRoot, "base")
			p := coworkPayload{Event: "PostToolUse", ToolName: name, ToolUseID: "x", CWD: cwd}
			p.RawInput, _ = json.Marshal(map[string]string{"path": base})
			names := make([]string, 205)
			for i := range names {
				names[i] = fmt.Sprintf("%d", i)
			}
			b, _ := json.Marshal(map[string]any{"filenames": names})
			p.RawResponse = b
			r, _, _ := projectCowork(p, 1)
			if len(r.Seen) != 200 || r.Seen[0] != filepath.Join(base, "0") {
				t.Fatal(r.Seen)
			}
			p.RawInput = []byte(`{"path":"relative"}`)
			r, _, _ = projectCowork(p, 1)
			if len(r.Seen) == 0 || r.Seen[0] != filepath.Join(cwd, "0") {
				t.Fatal(r.Seen)
			}
		})
	}
	for _, server := range []string{"", "named"} {
		p := coworkPayload{Event: "PostToolUse", ToolName: "mcp__abc__read__more", ToolUseID: "x"}
		p.MCPServer.Name = server
		r, _, ok := projectCowork(p, 1)
		if server == "" {
			server = "abc"
		}
		if !ok || r.MCP.Server != server || r.MCP.Tool != "read__more" {
			t.Fatal(r)
		}
	}
}
func TestCoworkLenientInputAndControlPaths(t *testing.T) {
	p := coworkPayload{Event: "PostToolUse", ToolName: "mcp__drive__search", ToolUseID: "1", RawInput: []byte(`{"path":["one","two"]}`)}
	r, _, ok := projectCowork(p, 1)
	if !ok || r.MCP == nil || r.MCP.Tool != "search" {
		t.Fatalf("connector lost: %+v", r)
	}
	p.ToolName = "Read"
	p.RawInput, _ = json.Marshal(map[string]any{"file_path": filepath.Join(t.TempDir(), "bad\nname")})
	r, _, ok = projectCowork(p, 1)
	if !ok || len(r.Files) != 0 {
		t.Fatalf("control character retained: %+v", r)
	}
	p.ToolName = "Glob"
	p.CWD = t.TempDir()
	p.RawInput = []byte(`{"path":["invalid"]}`)
	p.RawResponse = []byte(`{"is_error":"invalid","filenames":["good",3,"bad\nname"]}`)
	r, _, ok = projectCowork(p, 1)
	if !ok || !r.Ok || len(r.Seen) != 1 || r.Seen[0] != filepath.Join(p.CWD, "good") {
		t.Fatalf("lenient decoding: %+v", r)
	}
}

func TestCoworkRejectAndPrivacy(t *testing.T) {
	root := t.TempDir()
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(config, "Claude", "local-agent-mode-sessions", "a", "b", "local_1", "outputs")
	now := time.Now()
	for _, data := range []string{"not json", strings.Repeat("a", coworkInputLimit+1), fmt.Sprintf(`{"cwd":%q,"session_id":"../x","hook_event_name":"SessionStart"}`, cwd)} {
		captureCowork(strings.NewReader(data), root, now)
	}
	if _, err := os.Stat(filepath.Join(root, "sessions")); !os.IsNotExist(err) {
		t.Fatal("invalid payload created store")
	}
	secret := "SECRET_SYNTHETIC_CANARY"
	file := filepath.Join(t.TempDir(), "file")
	payloadBytes, _ := json.Marshal(map[string]any{"cwd": cwd, "session_id": "ok", "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_use_id": "a", "prompt": secret, "error": secret, "tool_input": map[string]any{"file_path": file, "command": secret, "query": secret}, "tool_response": map[string]any{"content": secret}})
	payload := string(payloadBytes)
	captureCowork(strings.NewReader(payload), root, now)
	receipts, err := os.ReadDir(filepath.Join(root, "sessions", coworkSessionKey("ok"), "r"))
	if err != nil || len(receipts) != 1 {
		t.Fatalf("expected one stored receipt: %v, %v", receipts, err)
	}
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if !d.IsDir() {
			b, e := os.ReadFile(p)
			if e != nil {
				return e
			}
			if bytes.Contains(b, []byte(secret)) {
				t.Errorf("secret in %s", p)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestCoworkConcurrentDedupeCapPrune(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := writeCoworkReceipt(root, "s", "local_x", "same", []byte(`{}`), "tool", now); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	dir := filepath.Join(root, "sessions", coworkSessionKey("s"), "r")
	entries, e := os.ReadDir(dir)
	if e != nil || len(entries) != 1 {
		t.Fatalf("%d %v", len(entries), e)
	}
	for i := 1; i < 5000; i++ {
		if e := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%04d.json", i)), nil, 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e := writeCoworkReceipt(root, "s", "local_x", "overflow", []byte(`{}`), "tool", now); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(root, "sessions", coworkSessionKey("s"), "truncated")); e != nil {
		t.Fatal(e)
	}
	old := now.Add(-8 * 24 * time.Hour)
	if e := os.Chtimes(filepath.Join(root, "sessions", coworkSessionKey("s"), "active"), old, old); e != nil {
		t.Fatal(e)
	}
	if e := writeCoworkReceipt(root, "new", "local_y", "start", []byte(`{}`), "start", now); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("old session remains")
	}
}
