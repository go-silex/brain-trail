package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCoworkDetector(t *testing.T) {
	for _, tc := range []struct {
		path string
		want bool
	}{{"/home/u/.config/Claude/local-agent-mode-sessions/a/b/local_123/outputs", true}, {"/Users/u/Library/Application Support/Claude/local-agent-mode-sessions/a/b/agent/local_ditto_123/outputs", true}, {`C:\Users\u\Claude\local-agent-mode-sessions\a\local_123\outputs`, true}, {"/a/xlocal-agent-mode-sessions/local_1", false}, {"/sessions/local_1", false}, {"", false}, {"/local-agent-mode-sessions/a/../b", false}} {
		if got := isLocalCowork(tc.path); got != tc.want {
			t.Errorf("%q: %v", tc.path, got)
		}
	}
}
func TestCoworkProjection(t *testing.T) {
	for _, tc := range []struct{ tool, field, kind string }{{"Read", "file_path", "read"}, {"Write", "file_path", "write"}, {"Edit", "file_path", "write"}, {"NotebookEdit", "notebook_path", "write"}} {
		t.Run(tc.tool, func(t *testing.T) {
			var p coworkPayload
			_ = json.Unmarshal([]byte(fmt.Sprintf(`{"hook_event_name":"PostToolUse","tool_name":%q,"tool_use_id":"1","tool_input":{%q:"/tmp/test"}}`, tc.tool, tc.field)), &p)
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
			p := coworkPayload{Event: "PostToolUse", ToolName: name, ToolUseID: "x", CWD: "/cwd"}
			p.Input.Path = "/base"
			names := make([]string, 205)
			for i := range names {
				names[i] = fmt.Sprintf("%d", i)
			}
			b, _ := json.Marshal(map[string]any{"filenames": names})
			p.RawResponse = b
			r, _, _ := projectCowork(p, 1)
			if len(r.Seen) != 200 || r.Seen[0] != "/base/0" {
				t.Fatal(r.Seen)
			}
			p.Input.Path = "relative"
			r, _, _ = projectCowork(p, 1)
			if r.Seen[0] != "/cwd/0" {
				t.Fatal(r.Seen[0])
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
func TestCoworkRejectAndPrivacy(t *testing.T) {
	root := t.TempDir()
	cwd := "/x/local-agent-mode-sessions/a/local_1/outputs"
	now := time.Now()
	for _, data := range []string{"not json", strings.Repeat("a", coworkInputLimit+1), fmt.Sprintf(`{"cwd":%q,"session_id":"../x","hook_event_name":"SessionStart"}`, cwd)} {
		captureCowork(strings.NewReader(data), root, now)
	}
	if _, err := os.Stat(filepath.Join(root, "sessions")); !os.IsNotExist(err) {
		t.Fatal("invalid payload created store")
	}
	secret := "SECRET_SYNTHETIC_CANARY"
	payload := fmt.Sprintf(`{"cwd":%q,"session_id":"ok","hook_event_name":"PostToolUse","tool_name":"Read","tool_use_id":"a","prompt":%q,"error":%q,"tool_input":{"file_path":"/tmp/file","command":%q,"query":%q},"tool_response":{"content":%q}}`, cwd, secret, secret, secret, secret, secret)
	captureCowork(strings.NewReader(payload), root, now)
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
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
	dir := filepath.Join(root, "sessions", "s", "r")
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
	if _, e := os.Stat(filepath.Join(root, "sessions", "s", "truncated")); e != nil {
		t.Fatal(e)
	}
	old := now.Add(-8 * 24 * time.Hour)
	if e := os.Chtimes(dir, old, old); e != nil {
		t.Fatal(e)
	}
	if e := writeCoworkReceipt(root, "new", "local_y", "start", []byte(`{}`), "start", now); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("old session remains")
	}
}
