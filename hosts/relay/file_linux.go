package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func fileDescriptorPath(file *os.File) (string, error) {
	path, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", file.Fd()))
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(path) || strings.HasSuffix(path, " (deleted)") {
		return "", errors.New("descriptor has no stable filesystem path")
	}
	return filepath.Clean(path), nil
}

func openHeldFile(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|unix.O_NONBLOCK, 0)
}

func sameFilePath(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }
