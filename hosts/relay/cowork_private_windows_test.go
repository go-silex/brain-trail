//go:build windows

package main

import (
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestCoworkPublishedFilesHavePrivateACL(t *testing.T) {
	root := filepath.Join(t.TempDir(), "store")
	if err := writeCoworkReceipt(root, "session", "local_task", "receipt", []byte(`{}`), "tool", time.Now()); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "sessions", coworkSessionKey("session"))
	for _, path := range []string{filepath.Join(dir, "session.json"), filepath.Join(dir, "r", "receipt.json")} {
		acl, err := inspectACL(path, user.User.Sid, system, false)
		if err != nil {
			t.Fatalf("inspect %s: %v", path, err)
		}
		if !validACL(acl, true) {
			t.Errorf("invalid owner or protected DACL for %s: %+v", path, acl)
		}
	}
}
