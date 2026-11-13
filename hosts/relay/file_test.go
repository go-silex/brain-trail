package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHeldFileAuthority(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	path := filepath.Join(root, "file.txt")
	other := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(path, []byte("original é😀"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewFileAuthority()
	defer a.Close()
	p, err := a.Prepare(root, path)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Inside || !sameFilePath(p.Path, canonical) {
		t.Fatalf("unexpected descriptor path: %+v", p)
	}
	got, err := a.Read(p.ID)
	if err != nil || got.Text != "original é😀" {
		t.Fatalf("read: %+v, %v", got, err)
	}
	q, err := a.Prepare(root, other)
	if err != nil || q.Inside {
		t.Fatalf("outside classification: %+v, %v", q, err)
	}
	a.Release(q.ID)
	if _, err := a.Prepare(root, root); err == nil {
		t.Fatal("directory accepted as regular file")
	}
	if _, err := a.Prepare(root, "relative"); err == nil {
		t.Fatal("relative path accepted")
	}
	// Rename-save must be possible with a held descriptor, but must not read the replacement.
	old := filepath.Join(root, "old.txt")
	if err := os.Rename(path, old); err != nil {
		t.Fatalf("held descriptor prevented rename-save: %v", err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Read(p.ID); err == nil {
		t.Fatal("replacement accepted by held capability")
	}
	if _, err := a.Verify(p.ID); err == nil {
		t.Fatal("replacement verified")
	}
	a.Release(p.ID)
	if _, err := a.Read(p.ID); err == nil {
		t.Fatal("released handle remained readable")
	}
}

func TestHeldFileSymlinkAndWorkspaceReplacement(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(root, "in")
	outside := filepath.Join(base, "out")
	for _, p := range []string{inside, outside} {
		if err := os.WriteFile(p, []byte(p), 0600); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err == nil {
		a := NewFileAuthority()
		defer a.Close()
		canonical, err := filepath.EvalSymlinks(outside)
		if err != nil {
			t.Fatal(err)
		}
		p, err := a.Prepare(root, link)
		if err != nil {
			t.Fatal(err)
		}
		if p.Inside || !sameFilePath(p.Path, canonical) {
			t.Fatalf("symlink canonical classification: %+v", p)
		}
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(inside, link); err != nil {
			t.Fatal(err)
		}
		if _, err := a.Read(p.ID); err == nil {
			t.Fatal("changed symlink accepted")
		}
	} else {
		t.Fatalf("symlink fixture unavailable: %v", err)
	}
	a := NewFileAuthority()
	defer a.Close()
	p, err := a.Prepare(root, inside)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(root, filepath.Join(base, "old-root")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "in"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Read(p.ID); err == nil {
		t.Fatal("replaced workspace accepted")
	}
}

func TestHeldFileBoundsExpiryAndClose(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "large")
	if err := os.WriteFile(path, []byte(strings.Repeat("é", 50000)), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewFileAuthority()
	defer a.Close()
	ids := make([]string, 0, 8)
	for range 8 {
		p, err := a.Prepare(root, path)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p.ID)
	}
	if _, err := a.Prepare(root, path); err == nil {
		t.Fatal("ninth handle accepted")
	}
	read, err := a.Read(ids[0])
	if err != nil || len([]rune(read.Text)) != 40001 {
		t.Fatalf("preview bound: %d, %v", len([]rune(read.Text)), err)
	}
	// Advance one capability's expiry without a ten-minute wall-clock delay.
	a.mu.Lock()
	a.handles[ids[0]].expires = time.Now().Add(-time.Second)
	a.mu.Unlock()
	if _, err := a.Read(ids[0]); err == nil {
		t.Fatal("expired handle readable")
	}
	if _, err := a.Prepare(root, path); err != nil {
		t.Fatalf("expired handle did not release capacity: %v", err)
	}
	a.Close()
	if _, err := a.Read(ids[1]); err == nil {
		t.Fatal("closed authority retained handle")
	}
	if _, err := a.Prepare(root, path); err == nil {
		t.Fatal("closed authority accepted handle")
	}
}
