//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"time"
	"unsafe"

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

// FILE_ID_INFO consists of a 64-bit volume serial number and a 128-bit file ID.
type coworkDirectoryIdentity struct {
	volume uint64
	fileID [16]byte
}

func coworkDirectoryLockOffset(identity coworkDirectoryIdentity) uint64 {
	var data [24]byte
	binary.LittleEndian.PutUint64(data[:8], identity.volume)
	copy(data[8:], identity.fileID[:])
	key := sha256.Sum256(data[:])
	return binary.LittleEndian.Uint64(key[:8])&0x7fffffffffffffff | 1
}

func coworkLock(path string, wait bool) (func(), error) {
	return coworkLockWaiting(path, wait, nil)
}

// Session locks use directory-identity byte ranges in the sessions-level
// lock file, so no descendant handle prevents Windows from retiring a session.
func coworkLockWaiting(path string, wait bool, waiting func()) (func(), error) {
	var pinned *os.File
	var info os.FileInfo
	var identity coworkDirectoryIdentity
	var err error
	var overlapped windows.Overlapped
	if filepath.Base(path) == ".lock" {
		dir := filepath.Dir(path)
		pinned, identity, err = coworkOpenLockDirectory(dir)
		if err != nil {
			return nil, err
		}
		offset := coworkDirectoryLockOffset(identity)
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
	replaced := false
	if pinned != nil {
		current, currentIdentity, openErr := coworkOpenLockDirectory(path)
		if openErr != nil {
			replaced = true
		} else {
			replaced = identity != currentIdentity
			current.Close()
		}
	} else {
		current, statErr := os.Lstat(path)
		replaced = statErr != nil || !os.SameFile(info, current)
	}
	if replaced {
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

func coworkOpenLockDirectory(path string) (*os.File, coworkDirectoryIdentity, error) {
	var identity coworkDirectoryIdentity
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, identity, err
	}
	handle, err := windows.CreateFile(wide, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, identity, err
	}
	var attrs windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &attrs); err != nil ||
		attrs.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		attrs.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return nil, identity, errors.New("invalid lock directory")
	}
	if err = windows.GetFileInformationByHandleEx(handle, windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&identity)), uint32(unsafe.Sizeof(identity))); err != nil {
		windows.CloseHandle(handle)
		return nil, identity, err
	}
	return os.NewFile(uintptr(handle), path), identity, nil
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
