package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCoworkStoreIdentityResumeAndDuplicates(t *testing.T) {
	root := filepath.Join(t.TempDir(), "store")
	now := time.Now().Truncate(time.Second)
	put := func(id, key, event string, at time.Time) {
		t.Helper()
		if err := writeCoworkReceipt(root, id, "local_task", key, []byte(`{"v":1}`), event, at); err != nil {
			t.Fatal(err)
		}
	}
	put("TaskA", "first", "start", now)
	put("taska", "first", "tool", now)
	if coworkSessionKey("TaskA") == coworkSessionKey("taska") {
		t.Fatal("case-sensitive IDs collide")
	}
	dir := filepath.Join(root, "sessions", coworkSessionKey("TaskA"))
	put("TaskA", "first", "tool", now.Add(time.Hour))
	st, err := os.Stat(filepath.Join(dir, "active"))
	if err != nil || !st.ModTime().Equal(now.Add(time.Hour)) {
		t.Fatalf("duplicate did not refresh activity: %v %v", st, err)
	}
	put("TaskA", "end", "end", now.Add(2*time.Hour))
	put("TaskA", "start2", "start", now.Add(3*time.Hour))
	if _, err := os.Stat(filepath.Join(dir, "ended")); !os.IsNotExist(err) {
		t.Fatal("resume retained ended marker")
	}
	metadata, _ := json.Marshal(coworkSession{V: 1, ID: "different", Started: now.UnixMilli()})
	if err := os.WriteFile(filepath.Join(dir, "session.json"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeCoworkReceipt(root, "TaskA", "local_task", "forbidden", []byte(`{}`), "tool", now); err == nil {
		t.Fatal("accepted mismatched metadata")
	}
	if _, err := os.Stat(filepath.Join(dir, "r", "forbidden.json")); !os.IsNotExist(err) {
		t.Fatal("wrote to mismatched session")
	}
}

func TestCoworkStoreCapAndPruningLock(t *testing.T) {
	root := filepath.Join(t.TempDir(), "store")
	now := time.Now().Truncate(time.Second)
	old := now.Add(-8 * 24 * time.Hour)
	if err := writeCoworkReceipt(root, "old", "local_old", "first", []byte(`{}`), "tool", old); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "sessions", coworkSessionKey("old"))
	unlock, err := coworkLock(filepath.Join(dir, ".lock"), false)
	if err != nil {
		t.Fatal(err)
	}
	pruneCowork(filepath.Join(root, "sessions"), "", now)
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("pruned locked session", err)
	}
	unlock()
	pruneCowork(filepath.Join(root, "sessions"), "", now)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("expired session not pruned")
	}
	if err := writeCoworkReceipt(root, "cap", "local_cap", "first", []byte(`{}`), "tool", old); err != nil {
		t.Fatal(err)
	}
	dir = filepath.Join(root, "sessions", coworkSessionKey("cap"))
	for i := 1; i < 5000; i++ {
		if err := os.WriteFile(filepath.Join(dir, "r", fmt.Sprintf("%d.json", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeCoworkReceipt(root, "cap", "local_cap", "overflow", []byte(`{}`), "end", now); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"truncated", "ended"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "r", "overflow.json")); !os.IsNotExist(err) {
		t.Fatal("cap exceeded")
	}
	st, err := os.Stat(filepath.Join(dir, "active"))
	if err != nil || !st.ModTime().Equal(now) {
		t.Fatal("capped session not active", err)
	}
}

func TestCoworkStoreRejectsLinksAndLargeFiles(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "store")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "sessions")); err == nil {
		if err := writeCoworkReceipt(root, "id", "local_id", "a", []byte(`{}`), "tool", time.Now()); err == nil {
			t.Fatal("accepted linked sessions")
		}
	}
	path := filepath.Join(base, "large")
	if err := os.WriteFile(path, make([]byte, 8193), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := coworkReadRegular(path, 8192); err == nil {
		t.Fatal("accepted oversized file")
	}
	if _, err := coworkReadRegular(target, 8192); err == nil {
		t.Fatal("accepted directory")
	}
}
