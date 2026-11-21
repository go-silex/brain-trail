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

func coworkVerifyAncestors(dir string) error {
	for {
		info, err := os.Lstat(dir)
		if err != nil && !os.IsNotExist(err) {
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
	if err = unix.Fstat(fd, &st); err != nil || st.Uid != uint32(os.Geteuid()) {
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
