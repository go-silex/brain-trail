//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CreateDirectory receives the protected DACL atomically, before the name exists.
func privateTempDir() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("current user SID: %w", err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return "", fmt.Errorf("private directory DACL: %w", err)
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	for range 10 {
		var random [8]byte
		if _, err = rand.Read(random[:]); err != nil {
			return "", err
		}
		path := filepath.Join(os.TempDir(), "btr-é😀-"+hex.EncodeToString(random[:]))
		wide, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return "", err
		}
		if err = windows.CreateDirectory(wide, &sa); err == nil {
			return path, nil
		}
		if !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return "", fmt.Errorf("create private directory: %w", err)
		}
	}
	return "", fmt.Errorf("could not allocate private directory after collisions")
}
