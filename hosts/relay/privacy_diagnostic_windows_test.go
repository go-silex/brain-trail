//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// privacyTestDiagnostic reports only ACL predicates and aggregate ACE flags.
func privacyTestDiagnostic(dir, socket string) string {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "ACL diagnostic unavailable: token"
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return "ACL diagnostic unavailable: system principal"
	}
	directory, err := inspectACL(dir, user.User.Sid, system, false)
	if err != nil {
		return "ACL diagnostic unavailable: directory"
	}
	sock, err := inspectACL(socket, user.User.Sid, system, true)
	if err != nil {
		return "ACL diagnostic unavailable: socket"
	}
	var inherited, explicit, allow, other, inheritOnly int
	var sd *windows.SECURITY_DESCRIPTOR
	wide, err := windows.UTF16PtrFromString(socket)
	if err != nil {
		return "ACL diagnostic unavailable: socket encoding"
	}
	h, err := windows.CreateFile(wide, windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "ACL diagnostic unavailable: socket handle"
	}
	defer windows.CloseHandle(h)
	sd, err = windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "ACL diagnostic unavailable: socket DACL"
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return "ACL diagnostic unavailable: nil socket DACL"
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil {
			return "ACL diagnostic unavailable: ACE"
		}
		if ace.Header.AceFlags&windows.INHERITED_ACE != 0 {
			inherited++
		} else {
			explicit++
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			inheritOnly++
		}
		if ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE {
			allow++
		} else {
			other++
		}
	}
	return fmt.Sprintf("directory owner=%t protected=%t allowed=%d unexpected=%d; socket owner=%t protected=%t allowed=%d unexpected=%d inherited=%d explicit=%d allow=%d other=%d inheritOnly=%d", directory.OwnerSelf, directory.Protected, directory.AllowedEntries, directory.UnexpectedEntries, sock.OwnerSelf, sock.Protected, sock.AllowedEntries, sock.UnexpectedEntries, inherited, explicit, allow, other, inheritOnly)
}
