//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
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

type aclEvidence struct {
	OwnerSelf         bool `json:"ownerSelf"`
	Protected         bool `json:"protected"`
	AllowedEntries    int  `json:"allowedEntries"`
	UnexpectedEntries int  `json:"unexpectedEntries"`
}

func inspectACL(path string, user, system *windows.SID, inherited bool) (aclEvidence, error) {
	var result aclEvidence
	var sd *windows.SECURITY_DESCRIPTOR
	var err error
	const info = windows.OWNER_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION
	if inherited {
		wide, wideErr := windows.UTF16PtrFromString(path)
		if wideErr != nil {
			return result, fmt.Errorf("socket path: %w", wideErr)
		}
		handle, openErr := windows.CreateFile(wide, windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if openErr != nil {
			return result, fmt.Errorf("open socket metadata(%s): %w", path, openErr)
		}
		defer windows.CloseHandle(handle)
		sd, err = windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, info)
	} else {
		sd, err = windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, info)
	}
	if err != nil {
		return result, fmt.Errorf("security info(%s): %w", path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return result, fmt.Errorf("owner(%s): %v", path, err)
	}
	result.OwnerSelf = windows.EqualSid(owner, user)
	control, _, err := sd.Control()
	if err != nil {
		return result, fmt.Errorf("control(%s): %w", path, err)
	}
	result.Protected = control&windows.SE_DACL_PROTECTED != 0
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return result, fmt.Errorf("DACL(%s): %v", path, err)
	}
	seenUser, seenSystem := false, false
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			return result, fmt.Errorf("GetAce(%s,%d): %w", path, i, err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || (inherited && ace.Header.AceFlags&windows.INHERITED_ACE == 0) {
			result.UnexpectedEntries++
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		switch {
		case windows.EqualSid(sid, user) && !seenUser:
			seenUser = true
			result.AllowedEntries++
		case windows.EqualSid(sid, system) && !seenSystem:
			seenSystem = true
			result.AllowedEntries++
		default:
			result.UnexpectedEntries++
		}
	}
	return result, nil
}

func privacyEvidence(dir, socket string) (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("current user SID: %w", err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return "", fmt.Errorf("SYSTEM SID: %w", err)
	}
	directory, err := inspectACL(dir, user.User.Sid, system, false)
	if err != nil {
		return "", err
	}
	socketACL, err := inspectACL(socket, user.User.Sid, system, true)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(struct {
		Kind      string      `json:"kind"`
		Directory aclEvidence `json:"directory"`
		Socket    aclEvidence `json:"socket"`
	}{"windows", directory, socketACL})
	return string(b), err
}
