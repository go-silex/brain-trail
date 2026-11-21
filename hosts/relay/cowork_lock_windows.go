//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
)

func coworkOpenRead(path string) (*os.File, error) {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(wide, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var attrs windows.ByHandleFileInformation
	kind, kindErr := windows.GetFileType(handle)
	if err = windows.GetFileInformationByHandle(handle, &attrs); err != nil || kindErr != nil || kind != windows.FILE_TYPE_DISK || attrs.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		windows.CloseHandle(handle)
		return nil, errors.New("invalid file")
	}
	return os.NewFile(uintptr(handle), path), nil
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
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(wide, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var attrs windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &attrs); err != nil || attrs.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return nil, errors.New("invalid lock file")
	}
	f := os.NewFile(uintptr(handle), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("invalid lock file")
	}
	var overlapped windows.Overlapped
	deadline := time.Now().Add(2 * time.Second)
	for {
		err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
		if err == nil {
			break
		}
		if err != windows.ERROR_LOCK_VIOLATION || !wait || time.Now().After(deadline) {
			f.Close()
			return nil, err
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, current) {
		windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
		f.Close()
		return nil, errors.New("lock replaced")
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped); f.Close() }, nil
}
