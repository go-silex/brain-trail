package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func coworkTestTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS != "windows" {
		if err := os.Chmod(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestCoworkStoreIdentityResumeAndDuplicates(t *testing.T) {
	root := filepath.Join(coworkTestTempDir(t), "store")
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
	put("TaskA", "first", "tool", now)
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
	root := filepath.Join(coworkTestTempDir(t), "store")
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
	base := coworkTestTempDir(t)
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

func TestCoworkPruneProgressAndRecovery(t *testing.T) {
	sessions := filepath.Join(coworkTestTempDir(t), "sessions")
	if err := coworkPrivateMkdir(sessions); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i := range 130 {
		dir := filepath.Join(sessions, fmt.Sprintf("%032x", i))
		if err := coworkPrivateMkdir(dir); err != nil {
			t.Fatal(err)
		}
		if i == 129 {
			old := now.Add(-8 * 24 * time.Hour)
			if err := os.Chtimes(dir, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	tomb := filepath.Join(sessions, ".prune-interrupted")
	if err := coworkPrivateMkdir(tomb); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		pruneCowork(sessions, "", now)
	}
	if _, err := os.Stat(filepath.Join(sessions, fmt.Sprintf("%032x", 129))); !os.IsNotExist(err) {
		t.Fatal("orphan beyond first 64 candidates was not pruned")
	}
	if _, err := os.Stat(tomb); !os.IsNotExist(err) {
		t.Fatal("interrupted tombstone was not removed")
	}
}

func TestCoworkPruneCursorDoesNotFollowSymlink(t *testing.T) {
	base := coworkTestTempDir(t)
	sessions := filepath.Join(base, "sessions")
	if err := coworkPrivateMkdir(sessions); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(sessions, coworkSessionKey("id"))
	if err := coworkPrivateMkdir(dir); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "target")
	if err := os.WriteFile(target, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(sessions, ".prune-cursor")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	pruneCowork(sessions, "", time.Now())
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "preserve" {
		t.Fatalf("cursor followed symlink: %q %v", data, err)
	}
}

func TestCoworkConcurrentWritesAndLifecycleNames(t *testing.T) {
	root := filepath.Join(coworkTestTempDir(t), "store")
	now := time.Now()
	var wg sync.WaitGroup
	errs := make(chan error, 24)
	for i := range 24 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- writeCoworkReceipt(root, "same", "local_task", fmt.Sprintf("%d", i), []byte(`{}`), "tool", now)
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, event := range []string{"start", "end"} {
		if err := writeCoworkReceipt(root, "same", "local_task", event, []byte(`{}`), event, now); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(root, "sessions", coworkSessionKey("same"), "r", "_"+event+".json")); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, "sessions", coworkSessionKey("same"), "r"))
	if err != nil || len(entries) != 26 {
		t.Fatalf("lost concurrent receipts: %d, %v", len(entries), err)
	}
}

func TestCoworkParentPermissionsUnchanged(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission semantics")
	}
	state := coworkTestTempDir(t)
	parent := filepath.Join(state, "brain-trail")
	if err := os.Mkdir(parent, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0750); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(parent, "cowork", "v1")
	if err := writeCoworkReceipt(root, "id", "local_task", "key", []byte(`{}`), "tool", time.Now()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(parent)
	if err != nil || info.Mode().Perm() != 0750 {
		t.Fatalf("parent permissions changed: %v %v", info, err)
	}
	if err := os.Chmod(parent, 0770); err != nil {
		t.Fatal(err)
	}
	if err := writeCoworkReceipt(root, "id", "local_task", "another", []byte(`{}`), "tool", time.Now()); err == nil {
		t.Fatal("accepted group-writable parent")
	}
}

func TestCoworkCreatesMissingStatePrivately(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix state path")
	}
	base := coworkTestTempDir(t)
	state := filepath.Join(base, "missing", "state")
	root := filepath.Join(state, "brain-trail", "cowork", "v1")
	if err := writeCoworkReceipt(root, "id", "local_task", "key", []byte(`{}`), "tool", time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Dir(state), state, filepath.Join(state, "brain-trail")} {
		info, err := os.Stat(dir)
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatalf("state ancestor not private: %s %v %v", dir, info, err)
		}
	}
}

func TestCoworkRejectsUnsafeAncestors(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix ancestor semantics")
	}
	base := coworkTestTempDir(t)
	ancestor := filepath.Join(base, "ancestor")
	if err := os.Mkdir(ancestor, 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(ancestor, "missing", "brain-trail", "cowork", "v1")
	write := func() error {
		return writeCoworkReceipt(root, "id", "local_task", "key", []byte(`{}`), "tool", time.Now())
	}
	if err := os.Chmod(ancestor, 0777); err != nil {
		t.Fatal(err)
	}
	if err := write(); err == nil {
		t.Fatal("accepted writable ancestor")
	}
	if err := os.Chmod(ancestor, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(ancestor, link); err != nil {
		t.Fatal(err)
	}
	root = filepath.Join(link, "missing", "brain-trail", "cowork", "v1")
	if err := write(); err == nil {
		t.Fatal("accepted symlink ancestor")
	}
	root = filepath.Join(ancestor, "missing", "brain-trail", "cowork", "v1")
	if err := os.Chmod(ancestor, os.ModeSticky|0777); err != nil {
		t.Fatal(err)
	}
	if err := write(); err != nil {
		t.Fatalf("rejected sticky ancestor: %v", err)
	}
	cowork := filepath.Dir(root)
	if err := os.Chmod(cowork, 0777); err != nil {
		t.Fatal(err)
	}
	if err := write(); err == nil {
		t.Fatal("accepted writable cowork ancestor")
	}
}

func TestCoworkPruneRetiresLockedDirectory(t *testing.T) {
	sessions := filepath.Join(coworkTestTempDir(t), "sessions")
	if err := coworkPrivateMkdir(sessions); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(sessions, coworkSessionKey("old"))
	if err := coworkPrivateMkdir(dir); err != nil {
		t.Fatal(err)
	}
	unlock, err := coworkLock(filepath.Join(dir, ".lock"), false)
	if err != nil {
		t.Fatal(err)
	}
	waiting := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		release, err := coworkLockWaiting(filepath.Join(dir, ".lock"), true, func() { close(waiting) })
		if err == nil {
			release()
		}
		result <- err
	}()
	select {
	case <-waiting:
	case err := <-result:
		unlock()
		t.Fatalf("competitor did not wait for lock: %v", err)
	case <-time.After(time.Second):
		unlock()
		t.Fatal("competitor did not reach lock")
	}
	cleanup := coworkPruneLocked(dir)
	if cleanup == nil {
		unlock()
		t.Fatal("could not retire session")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		unlock()
		t.Fatal("live session name still exists")
	}
	entries, err := os.ReadDir(sessions)
	if err != nil || len(entries) != 1 {
		unlock()
		t.Fatal("missing tombstone", err)
	}
	tomb := filepath.Join(sessions, entries[0].Name())
	pruneCowork(sessions, "", time.Now())
	if _, err := os.Stat(tomb); err != nil {
		unlock()
		t.Fatal("removed locked tombstone", err)
	}
	unlock()
	if err := <-result; err == nil {
		t.Fatal("waiting writer acquired retired lock")
	}
	cleanup()
	if _, err := os.Stat(tomb); !os.IsNotExist(err) {
		t.Fatal("tombstone not cleaned")
	}
}
