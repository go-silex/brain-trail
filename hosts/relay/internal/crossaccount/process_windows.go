//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// processEntry exposes only hosted proof observations; it never terminates a process.
func processEntry() bool {
	if len(os.Args) < 2 || (os.Args[1] != "--process-inspect" && os.Args[1] != "--process-alive") {
		return false
	}
	fail := func(name string, err error) {
		var code uint32
		var errno syscall.Errno
		if errors.As(err, &errno) {
			code = uint32(errno)
		}
		_ = json.NewEncoder(os.Stdout).Encode(struct {
			OK    bool   `json:"ok"`
			Phase string `json:"phase"`
			Code  uint32 `json:"code"`
		}{false, name, code})
		os.Exit(1)
	}
	if !hosted() {
		fail("guard", nil)
	}
	var expected string
	var pid uint32
	if os.Args[1] == "--process-inspect" {
		if len(os.Args) != 3 {
			fail("arguments", nil)
		}
		expected = os.Args[2]
	} else {
		if len(os.Args) != 4 {
			fail("arguments", nil)
		}
		n, err := strconv.ParseUint(os.Args[2], 10, 32)
		if err != nil || n == 0 {
			fail("arguments", nil)
		}
		pid = uint32(n)
		expected = os.Args[3]
	}
	if !filepath.IsAbs(expected) {
		fail("arguments", nil)
	}
	canonical, err := filepath.EvalSymlinks(expected)
	if err != nil {
		fail("expected-path", err)
	}
	if os.Args[1] == "--process-alive" {
		alive, err := matchingProcess(pid, canonical)
		if err != nil {
			var p *phaseError
			if errors.As(err, &p) {
				fail(p.phase, p.err)
			}
			fail("process", err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(struct {
			OK    bool `json:"ok"`
			Alive bool `json:"alive"`
		}{true, alive})
		return true
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		fail("snapshot", err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	err = windows.Process32First(snapshot, &entry)
	var found uint32
	for err == nil {
		if entry.ProcessID != 0 && strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(canonical)) {
			match, e := matchingProcess(entry.ProcessID, canonical)
			if e != nil {
				var p *phaseError
				if errors.As(e, &p) {
					fail(p.phase, p.err)
				}
				fail("process", e)
			}
			if match {
				if found != 0 {
					fail("ambiguous", nil)
				}
				found = entry.ProcessID
			}
		}
		err = windows.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		fail("enumeration", err)
	}
	if found == 0 {
		fail("not-found", nil)
	}
	_ = json.NewEncoder(os.Stdout).Encode(struct {
		OK  bool   `json:"ok"`
		PID uint32 `json:"pid"`
	}{true, found})
	return true
}

func matchingProcess(pid uint32, expected string) (bool, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if err != nil {
		return false, phase("open-process", err)
	}
	defer windows.CloseHandle(h)
	state, err := windows.WaitForSingleObject(h, 0)
	if err != nil {
		return false, phase("process-wait", err)
	}
	if state == windows.WAIT_OBJECT_0 {
		return false, nil
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		return false, phase("process-wait", errors.New("unexpected wait result"))
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err = windows.QueryFullProcessImageName(h, 0, &buffer[0], &size); err != nil {
		state, waitErr := windows.WaitForSingleObject(h, 0)
		if waitErr == nil && state == windows.WAIT_OBJECT_0 {
			return false, nil
		}
		return false, phase("image-name", err)
	}
	actual, err := filepath.EvalSymlinks(windows.UTF16ToString(buffer[:size]))
	if err != nil {
		return false, phase("image-path", err)
	}
	if !strings.EqualFold(filepath.Clean(actual), filepath.Clean(expected)) {
		return false, nil
	}
	state, err = windows.WaitForSingleObject(h, 0)
	if err != nil {
		return false, phase("process-wait", err)
	}
	if state == windows.WAIT_OBJECT_0 {
		return false, nil
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		return false, phase("process-wait", errors.New("unexpected wait result"))
	}
	return true, nil
}
