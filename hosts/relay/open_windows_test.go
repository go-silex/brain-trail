//go:build windows

package main

import (
	"strings"
	"testing"
	"unsafe"
)

func TestBrowserProgIDRejectsLegacyCommands(t *testing.T) {
	for _, tc := range []struct {
		id string
		valid bool
	}{
		{"ChromeHTML", true},
		{"AppXq0fevzme2pys62n3e0fbqa7peapykr8v", true},
		{"browser.test-1", true},
		{"", false},
		{`"C:\Program Files\Browser\browser.exe" "%1"`, false},
		{`C:\browser.exe`, false},
		{"browser %1", false},
		{strings.Repeat("a", 256), false},
	} {
		if got := validBrowserProgID(tc.id); got != tc.valid {
			t.Errorf("validBrowserProgID(%q) = %v, want %v", tc.id, got, tc.valid)
		}
	}
}

func TestShellExecuteInfoNativeLayout(t *testing.T) {
	var info shellExecuteInfo
	if unsafe.Sizeof(uintptr(0)) == 8 {
		if unsafe.Sizeof(info) != 112 || unsafe.Offsetof(info.class) != 72 || unsafe.Offsetof(info.process) != 104 {
			t.Fatalf("unexpected 64-bit SHELLEXECUTEINFO layout: size=%d class=%d process=%d", unsafe.Sizeof(info), unsafe.Offsetof(info.class), unsafe.Offsetof(info.process))
		}
	} else if unsafe.Sizeof(info) != 60 || unsafe.Offsetof(info.class) != 40 || unsafe.Offsetof(info.process) != 56 {
		t.Fatalf("unexpected 32-bit SHELLEXECUTEINFO layout: size=%d class=%d process=%d", unsafe.Sizeof(info), unsafe.Offsetof(info.class), unsafe.Offsetof(info.process))
	}
}
