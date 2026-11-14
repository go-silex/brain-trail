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
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func localBase() (string, error) {
	base := os.Getenv("LocalAppData")
	if !filepath.IsAbs(base) || strings.HasPrefix(base, `\\`) {
		return "", fmt.Errorf("LocalAppData must be a local absolute path")
	}
	base, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", fmt.Errorf("resolve LocalAppData: %w", err)
	}
	volume := filepath.VolumeName(base)
	if len(volume) != 2 || volume[1] != ':' {
		return "", fmt.Errorf("LocalAppData is not on a local drive")
	}
	root, err := windows.UTF16PtrFromString(volume + `\`)
	if err != nil {
		return "", err
	}
	if windows.GetDriveType(root) != windows.DRIVE_FIXED {
		return "", fmt.Errorf("LocalAppData is not on a fixed local drive")
	}
	return base, nil
}

func privateTempDir() (string, error) {
	base, err := localBase()
	if err != nil {
		return "", err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("current user SID: %w", err)
	}
	sid := user.User.Sid.String()
	sd, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")")
	if err != nil {
		return "", fmt.Errorf("private directory DACL: %w", err)
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	for range 10 {
		var random [8]byte
		if _, err = rand.Read(random[:]); err != nil {
			return "", err
		}
		path := filepath.Join(base, "btr-"+hex.EncodeToString(random[:]))
		wide, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return "", err
		}
		if err = windows.CreateDirectory(wide, &sa); err == nil {
			system, e := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
			if e == nil {
				var a aclEvidence
				a, e = inspectACL(path, user.User.Sid, system, false)
				if e == nil && !validACL(a, true) {
					e = fmt.Errorf("private directory ACL invalid")
				}
			}
			if e != nil {
				os.Remove(path)
				return "", e
			}
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

func validACL(a aclEvidence, directory bool) bool {
	return a.OwnerSelf && (!directory || a.Protected) && a.AllowedEntries == 2 && a.UnexpectedEntries == 0
}

func inspectACL(path string, user, system *windows.SID, socket bool) (aclEvidence, error) {
	var result aclEvidence
	var sd *windows.SECURITY_DESCRIPTOR
	var err error
	const info = windows.OWNER_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION
	if socket {
		wide, e := windows.UTF16PtrFromString(path)
		if e != nil {
			return result, e
		}
		handle, e := windows.CreateFile(wide, windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if e != nil {
			return result, fmt.Errorf("open socket metadata: %w", e)
		}
		defer windows.CloseHandle(handle)
		sd, err = windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, info)
	} else {
		sd, err = windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, info)
	}
	if err != nil {
		return result, fmt.Errorf("security info: %w", err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return result, fmt.Errorf("invalid security owner: %v", err)
	}
	result.OwnerSelf = windows.EqualSid(owner, user)
	control, _, err := sd.Control()
	if err != nil {
		return result, err
	}
	result.Protected = control&windows.SE_DACL_PROTECTED != 0
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return result, fmt.Errorf("invalid DACL: %v", err)
	}
	seenUser, seenSystem := false, false
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			return result, err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || (socket && ace.Header.AceFlags&windows.INHERITED_ACE == 0) {
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
	if !filepath.IsAbs(dir) || !strings.EqualFold(filepath.Clean(filepath.Dir(socket)), filepath.Clean(dir)) || len(socket) > 100 {
		return "", fmt.Errorf("invalid private socket path")
	}
	base, err := localBase()
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(filepath.Clean(filepath.Dir(dir)), filepath.Clean(base)) {
		return "", fmt.Errorf("private directory outside LocalAppData")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return "", err
	}
	directory, err := inspectACL(dir, user.User.Sid, system, false)
	if err != nil {
		return "", err
	}
	socketACL, err := inspectACL(socket, user.User.Sid, system, true)
	if err != nil {
		return "", err
	}
	if !validACL(directory, true) || !validACL(socketACL, false) {
		return "", fmt.Errorf("private directory or socket ACL invalid")
	}
	b, err := json.Marshal(struct {
		Kind      string      `json:"kind"`
		Directory aclEvidence `json:"directory"`
		Socket    aclEvidence `json:"socket"`
	}{"windows", directory, socketACL})
	return string(b), err
}
