//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/binary"
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
	return coworkLockWaiting(path, wait, nil)
}

// Session locks use directory-identity byte ranges in the sessions-level
// lock file, so no descendant handle prevents Windows from retiring a session.
func coworkLockWaiting(path string, wait bool, waiting func()) (func(), error) {
	var pinned *os.File
	var info os.FileInfo
	var err error
	var overlapped windows.Overlapped
	if filepath.Base(path) == ".lock" {
		dir := filepath.Dir(path)
		var identity [12]byte
		pinned, info, identity, err = coworkOpenLockDirectory(dir)
		if err != nil {
			return nil, err
		}
		key := sha256.Sum256(identity[:])
		offset := binary.LittleEndian.Uint64(key[:8])&0x7fffffffffffffff | 1
		overlapped.Offset = uint32(offset)
		overlapped.OffsetHigh = uint32(offset >> 32)
		path = dir
	}
	lockPath := path
	if pinned != nil {
		lockPath = filepath.Join(filepath.Dir(path), ".prune-lock")
	}
	f, lockInfo, err := coworkOpenLockFile(lockPath)
	if err != nil {
		if pinned != nil {
			pinned.Close()
		}
		return nil, err
	}
	if pinned == nil {
		info = lockInfo
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
		if err == nil {
			break
		}
		if err != windows.ERROR_LOCK_VIOLATION || !wait || time.Now().After(deadline) {
			f.Close()
			if pinned != nil {
				pinned.Close()
			}
			return nil, err
		}
		if waiting != nil {
			waiting()
			waiting = nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, current) {
		windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
		f.Close()
		if pinned != nil {
			pinned.Close()
		}
		return nil, errors.New("lock replaced")
	}
	return func() {
		windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
		f.Close()
		if pinned != nil {
			pinned.Close()
		}
	}, nil
}

func coworkOpenLockDirectory(path string) (*os.File, os.FileInfo, [12]byte, error) {
	var identity [12]byte
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, nil, identity, err
	}
	handle, err := windows.CreateFile(wide, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, nil, identity, err
	}
	var attrs windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &attrs); err != nil ||
		attrs.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		attrs.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return nil, nil, identity, errors.New("invalid lock directory")
	}
	binary.LittleEndian.PutUint32(identity[0:4], attrs.VolumeSerialNumber)
	binary.LittleEndian.PutUint32(identity[4:8], attrs.FileIndexHigh)
	binary.LittleEndian.PutUint32(identity[8:12], attrs.FileIndexLow)
	f := os.NewFile(uintptr(handle), path)
	info, err := f.Stat()
	if err != nil || !info.IsDir() {
		f.Close()
		return nil, nil, identity, errors.New("invalid lock directory")
	}
	return f, info, identity, nil
}

func coworkOpenLockFile(path string) (*os.File, os.FileInfo, error) {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, nil, err
	}
	handle, err := windows.CreateFile(wide, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
		windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, nil, err
	}
	var attrs windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &attrs); err != nil || attrs.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return nil, nil, errors.New("invalid lock file")
	}
	f := os.NewFile(uintptr(handle), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, nil, errors.New("invalid lock file")
	}
	return f, info, nil
}
