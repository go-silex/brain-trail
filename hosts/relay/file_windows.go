package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// os.Root.Open uses FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE on Windows.
func fileDescriptorPath(file *os.File) (string, error) {
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "", err
	}
	if n == 0 || n >= uint32(len(buf)) {
		return "", errors.New("descriptor path exceeds Windows limit")
	}
	path := windows.UTF16ToString(buf[:n])
	if strings.HasPrefix(path, `\\?\UNC\`) {
		path = `\\` + path[len(`\\?\UNC\`):]
	} else if strings.HasPrefix(path, `\\?\`) {
		path = path[len(`\\?\`):]
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("descriptor path is not absolute")
	}
	return filepath.Clean(path), nil
}

func openHeldFile(root *os.Root, name string) (*os.File, error) {
	return root.Open(name)
}

func sameFilePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
