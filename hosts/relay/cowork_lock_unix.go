//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

func coworkOpenRead(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}
func coworkPruneLocked(dir string) func() {
	tombstone, err := os.MkdirTemp(filepath.Dir(dir), ".prune-*")
	if err != nil {
		return nil
	}
	if err = os.Remove(tombstone); err != nil {
		return nil
	}
	if err = os.Rename(dir, tombstone); err != nil {
		return nil
	}
	return func() { _ = os.RemoveAll(tombstone) }
}

func coworkLock(path string, wait bool) (func(), error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("invalid lock file")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if (err != unix.EWOULDBLOCK && err != unix.EAGAIN) || !wait || time.Now().After(deadline) {
			f.Close()
			return nil, err
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, current) {
		unix.Flock(fd, unix.LOCK_UN)
		f.Close()
		return nil, errors.New("lock replaced")
	}
	return func() { unix.Flock(fd, unix.LOCK_UN); f.Close() }, nil
}
