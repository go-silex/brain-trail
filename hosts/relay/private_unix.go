//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func privateTempDir() (string, error) {
	base, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return "", fmt.Errorf("resolve temporary directory: %w", err)
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return "", err
	}
	if err = secureParent(base); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(base, "btr-")
	if err != nil {
		return "", err
	}
	if err = secureDirectory(dir); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}

func secureParent(path string) error {
	for {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || (stat.Uid != uint32(os.Geteuid()) && stat.Uid != 0) {
			return fmt.Errorf("untrusted temporary directory owner: %s", path)
		}
		if info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0 {
			return fmt.Errorf("writable temporary directory without sticky bit: %s", path)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}

func secureDirectory(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm() != 0700 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return fmt.Errorf("private directory ownership or mode invalid: %s", dir)
	}
	return secureParent(filepath.Dir(dir))
}

func privacyEvidence(dir, socket string) (string, error) {
	if !filepath.IsAbs(dir) || filepath.Clean(filepath.Dir(socket)) != filepath.Clean(dir) || len(socket) > 100 {
		return "", fmt.Errorf("invalid private socket path")
	}
	if err := secureDirectory(dir); err != nil {
		return "", err
	}
	info, err := os.Lstat(socket)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || stat.Uid != uint32(os.Geteuid()) {
		return "", fmt.Errorf("invalid private socket")
	}
	return "unix", nil
}
