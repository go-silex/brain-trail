//go:build !windows

package main

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"syscall"
)

func coworkLocalBase() (string, error) { return "", errors.New("not Windows") }

func coworkCreateTemp(dir string) (*os.File, error) {
	return os.CreateTemp(dir, ".tmp-*")
}

// Resolve only an existing prefix so a not-yet-created state directory keeps its
// intended name while symlinked system or home ancestors are canonical.
func coworkCanonicalPath(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("invalid store directory")
	}
	path = filepath.Clean(path)
	var missing []string
	for {
		resolved, err := filepath.EvalSymlinks(path)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", err
		}
		// A component may have appeared since EvalSymlinks; retry unless
		// it is a dangling symlink, which must not be treated as missing.
		info, statErr := os.Lstat(path)
		if statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return "", err
			}
			continue
		}
		if !os.IsNotExist(statErr) {
			return "", statErr
		}
		missing = append(missing, filepath.Base(path))
		path = parent
	}
}

func coworkCanonicalRoot(root string) (string, error) {
	boundary := filepath.Dir(root)
	suffix := []string{filepath.Base(root)}
	if filepath.Base(root) == "v1" && filepath.Base(boundary) == "cowork" && filepath.Base(filepath.Dir(boundary)) == "brain-trail" {
		boundary = filepath.Dir(filepath.Dir(boundary))
		suffix = []string{"brain-trail", "cowork", "v1"}
	}
	base, err := coworkCanonicalPath(boundary)
	if err != nil {
		return "", err
	}
	expected := base
	for _, part := range suffix {
		expected = filepath.Join(expected, part)
		info, statErr := os.Lstat(expected)
		if statErr != nil && !os.IsNotExist(statErr) {
			return "", statErr
		}
		if statErr == nil && info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("untrusted store directory")
		}
	}
	resolved, err := coworkCanonicalPath(root)
	if err != nil {
		return "", err
	}
	if resolved != expected {
		return "", errors.New("store path changed during canonicalization")
	}
	return resolved, nil
}

func coworkVerifyStorePath(root, leaf string) error {
	for dir := leaf; ; dir = filepath.Dir(dir) {
		if err := coworkVerifyDir(dir); err != nil {
			return err
		}
		if dir == root {
			break
		}
		if filepath.Dir(dir) == dir {
			return errors.New("invalid store path")
		}
	}
	start := filepath.Dir(root)
	if filepath.Base(root) == "v1" && filepath.Base(start) == "cowork" && filepath.Base(filepath.Dir(start)) == "brain-trail" {
		for _, dir := range []string{start, filepath.Dir(start), filepath.Dir(filepath.Dir(start))} {
			if err := coworkVerifyDir(dir); err != nil {
				return err
			}
		}
	}
	return coworkWalkAncestors(leaf, false)
}

func coworkVerifyAncestors(dir string) error {
	return coworkWalkAncestors(dir, true)
}

func coworkWalkAncestors(dir string, allowMissing bool) error {
	for {
		info, err := os.Lstat(dir)
		if err != nil && (!allowMissing || !os.IsNotExist(err)) {
			return err
		}
		if err == nil {
			st, ok := info.Sys().(*syscall.Stat_t)
			if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
				(st.Uid != 0 && st.Uid != uint32(os.Geteuid())) ||
				(info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0) {
				return fmt.Errorf("untrusted ancestor %s", dir)
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil
		}
		dir = parent
	}
}

func coworkOpenDir(dir string) (int, error) {
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var st unix.Stat_t
	if err = unix.Fstat(fd, &st); err != nil || st.Uid != uint32(os.Geteuid()) || st.Mode&0022 != 0 {
		unix.Close(fd)
		return -1, errors.New("untrusted store directory")
	}
	return fd, nil
}

func coworkVerifyDir(dir string) error {
	fd, err := coworkOpenDir(dir)
	if err == nil {
		unix.Close(fd)
	}
	return err
}

func coworkEnsureState(dir string) error {
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if os.IsNotExist(err) {
		parent := filepath.Dir(dir)
		if parent == dir {
			return err
		}
		if err = coworkEnsureState(parent); err != nil {
			return err
		}
		if err = os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return err
		}
		fd, err = unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	}
	if err != nil {
		return err
	}
	var st unix.Stat_t
	err = unix.Fstat(fd, &st)
	unix.Close(fd)
	if err != nil {
		return fmt.Errorf("stat state directory %s: %w", dir, err)
	}
	if (st.Uid != 0 && st.Uid != uint32(os.Geteuid())) || (st.Mode&0022 != 0 && st.Mode&unix.S_ISVTX == 0) {
		return fmt.Errorf("untrusted state directory %s (mode %#o)", dir, st.Mode&0777)
	}
	return nil
}

func coworkPrepareParent(dir string) error {
	if err := coworkVerifyAncestors(dir); err != nil {
		return err
	}
	if err := coworkEnsureState(filepath.Dir(dir)); err != nil {
		return err
	}
	if err := coworkVerifyDir(filepath.Dir(dir)); err != nil {
		return err
	}
	var st unix.Stat_t
	var err error
	err = os.Mkdir(dir, 0700)
	if err != nil && !os.IsExist(err) {
		return err
	}
	fd, err := coworkOpenDir(dir)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err = unix.Fstat(fd, &st); err != nil || st.Mode&0022 != 0 {
		return errors.New("untrusted state parent")
	}
	return nil
}

func coworkPrivateMkdir(dir string) error {
	err := os.Mkdir(dir, 0700)
	if err != nil && !os.IsExist(err) {
		return err
	}
	fd, err := coworkOpenDir(dir)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return unix.Fchmod(fd, 0700)
}
