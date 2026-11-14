package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/unix"
)

func fileDescriptorPath(file *os.File) (string, error) {
	var buf [unix.PathMax]byte
	// FcntlFlock passes its pointer directly to fcntl; F_GETPATH writes a
	// MAXPATHLEN-byte pathname rather than a flock structure.
	err := unix.FcntlFlock(file.Fd(), unix.F_GETPATH, (*unix.Flock_t)(unsafe.Pointer(&buf[0])))
	if err != nil {
		return "", err
	}
	end := bytes.IndexByte(buf[:], 0)
	if end <= 0 {
		return "", errors.New("descriptor has no stable filesystem path")
	}
	path := string(buf[:end])
	if !filepath.IsAbs(path) {
		return "", errors.New("descriptor path is not absolute")
	}
	return filepath.Clean(path), nil
}

func openHeldFile(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|unix.O_NONBLOCK, 0)
}
func sameFilePath(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }
