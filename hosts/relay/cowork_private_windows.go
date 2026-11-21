//go:build windows

package main

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func coworkLocalBase() (string, error) { return localBase() }

func coworkVerifyDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("untrusted store directory")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !windows.EqualSid(owner, user.User.Sid) {
		return errors.New("untrusted store owner")
	}
	return nil
}

func coworkCreateDir(dir string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sid := user.User.Sid.String()
	sd, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")")
	if err != nil {
		return err
	}
	wide, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	err = windows.CreateDirectory(wide, &sa)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	return coworkVerifyDir(dir)
}

func coworkPrepareParent(dir string) error {
	return coworkPrivateMkdir(dir)
}

func coworkPrivateMkdir(dir string) error {
	if err := coworkCreateDir(dir); err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return err
	}
	acl, err := inspectACL(dir, user.User.Sid, system, false)
	if err != nil || !validACL(acl, true) {
		return errors.New("untrusted store ACL")
	}
	return nil
}
