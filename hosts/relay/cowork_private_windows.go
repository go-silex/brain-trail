//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"

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

func coworkPrivateMkdir(dir string) error {
	err := os.Mkdir(dir, 0700)
	if os.IsNotExist(err) {
		if err = coworkPrivateMkdir(filepath.Dir(dir)); err != nil {
			return err
		}
		err = os.Mkdir(dir, 0700)
	}
	if err != nil && !os.IsExist(err) {
		return err
	}
	if err = coworkVerifyDir(dir); err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
