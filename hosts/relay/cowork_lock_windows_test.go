//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCoworkDirectoryIdentityAndLockOffset(t *testing.T) {
	dir := t.TempDir()
	first, identity, err := coworkOpenLockDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, same, err := coworkOpenLockDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
	if identity != same {
		t.Fatal("reopening the same directory changed its identity")
	}

	offset := coworkDirectoryLockOffset(identity)
	if offset == 0 || offset&1 == 0 || offset>>63 != 0 {
		t.Fatalf("invalid lock offset: %x", offset)
	}
	changed := identity
	changed.volume ^= 1 << 63
	if coworkDirectoryLockOffset(changed) == offset {
		t.Fatal("lock offset did not include the full volume serial number")
	}
	for i := range identity.fileID {
		changed = identity
		changed.fileID[i] ^= 1
		if coworkDirectoryLockOffset(changed) == offset {
			t.Fatalf("lock offset did not include file ID byte %d", i)
		}
	}
}

func TestCoworkLockRejectsReplacedDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "session")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(dir, ".lock")
	unlock, err := coworkLock(lockPath, false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()

	var replaceErr error
	otherUnlock, err := coworkLockWaiting(lockPath, true, func() {
		if replaceErr = os.Rename(dir, filepath.Join(root, "retired")); replaceErr != nil {
			return
		}
		if replaceErr = os.Mkdir(dir, 0700); replaceErr != nil {
			return
		}
		unlock()
		unlock = nil
	})
	if otherUnlock != nil {
		otherUnlock()
	}
	if replaceErr != nil {
		t.Fatal(replaceErr)
	}
	if err == nil || err.Error() != "lock replaced" {
		t.Fatalf("got %v, want lock replaced", err)
	}
}
