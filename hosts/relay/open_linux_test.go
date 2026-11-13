//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
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
