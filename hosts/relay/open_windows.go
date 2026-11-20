//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func applicationPath(app application) string {
	if app.name == "Obsidian" && obsidianHandler() {
		return "obsidian-handler"
	}
	// Executable names and installation directories are fixed; never resolve a
	// .cmd or .bat launcher, which would be interpreted by cmd.exe.
	directories := map[string][]string{
		"Obsidian":           {"Obsidian"},
		"Visual Studio Code": {"Programs/Microsoft VS Code", "Microsoft VS Code"},
		"Cursor":             {"Programs/cursor", "Cursor"},
		"Windsurf":           {"Programs/Windsurf", "Windsurf"},
		"Zed":                {"Programs/Zed", "Zed"},
		"Sublime Text":       {"Sublime Text", "Sublime Text 3"},
		"Typora":             {"Programs/Typora", "Typora"},
	}
	for _, root := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
		if root == "" {
			continue
		}
		for _, dir := range directories[app.name] {
			for _, name := range app.windows {
				path := filepath.Join(root, filepath.FromSlash(dir), name)
				if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
					return path
				}
			}
		}
	}
	for _, name := range app.windows {
		if path, err := exec.LookPath(name); err == nil {
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
				return path
			}
		}
	}
	return ""
}

// Only accept a registered handler whose executable is Obsidian itself.
// In particular, never dispatch a command or batch script through the shell.
func obsidianHandler() bool {
	key, err := registry.OpenKey(registry.CLASSES_ROOT, `obsidian\shell\open\command`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	command, _, err := key.GetStringValue("")
	if err != nil {
		return false
	}
	args, err := windows.DecomposeCommandLine(command)
	return err == nil && len(args) > 0 && strings.EqualFold(filepath.Base(args[0]), "Obsidian.exe")
}

func (s *relay) openPath(path, app, id string, generation int64, launchCode string, scopes ...*Guard) (string, error) {
	if app != "" {
		selected, executable, err := selectedApp(app)
		if err != nil {
			return "", err
		}
		if selected.name == "Obsidian" {
			path = obsidianURL(path)
			if executable == "obsidian-handler" {
				unlock, err := s.lockLaunchScope(scopes...)
				if err != nil {
					return "", err
				}
				err = shellOpen(path)
				unlock()
				if err != nil {
					return "", err
				}
				return "dispatched", nil
			}
		}
		return s.startLaunchForCode(exec.Command(executable, path), id, generation, launchCode, scopes...)
	}
	unlock, err := s.lockLaunchScope(scopes...)
	if err != nil {
		return "", err
	}
	err = shellOpen(path)
	unlock()
	if err != nil {
		return "", err
	}
	return "dispatched", nil
}

// QueryCurrentDefault may return a legacy command line instead of a ProgID.
// Never parse or execute that string as a command.
func validBrowserProgID(id string) bool {
	if len(id) == 0 || len(id) > 255 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

var (
	associationClass = windows.GUID{Data1: 0x591209c7, Data2: 0x767b, Data3: 0x42b2, Data4: [8]byte{0x9f, 0xba, 0x44, 0xee, 0x46, 0x15, 0xf2, 0xc7}}
	associationIID   = windows.GUID{Data1: 0x4e530b0a, Data2: 0xe611, Data3: 0x4c77, Data4: [8]byte{0xa3, 0xac, 0x90, 0x31, 0xd0, 0x22, 0x28, 0x1b}}
	coCreateInstance = windows.NewLazySystemDLL("ole32.dll").NewProc("CoCreateInstance")
	shellExecuteEx   = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")
)

type associationRegistration struct {
	vtable *struct {
		queryInterface, addRef, release, queryCurrentDefault uintptr
	}
}

// SHELLEXECUTEINFOW, with native pointer alignment on 32- and 64-bit Windows.
type shellExecuteInfo struct {
	size, mask uint32
	window uintptr
	verb, file, parameters, directory *uint16
	show int32
	instance, idList uintptr
	class *uint16
	classKey uintptr
	hotKey uint32
	icon, process uintptr
}

func queryBrowserProgID() (string, error) {
	var registration *associationRegistration
	hr, _, _ := coCreateInstance.Call(
		uintptr(unsafe.Pointer(&associationClass)), 0, 1,
		uintptr(unsafe.Pointer(&associationIID)), uintptr(unsafe.Pointer(&registration)),
	)
	if int32(hr) < 0 {
		return "", fmt.Errorf("create association registration: HRESULT %#x", uint32(hr))
	}
	defer syscall.SyscallN(registration.vtable.release, uintptr(unsafe.Pointer(registration)))
	protocol, _ := windows.UTF16PtrFromString("https")
	var result *uint16
	// AT_URLPROTOCOL and AL_EFFECTIVE are both 1.
	hr, _, _ = syscall.SyscallN(registration.vtable.queryCurrentDefault,
		uintptr(unsafe.Pointer(registration)), uintptr(unsafe.Pointer(protocol)), 1, 1,
		uintptr(unsafe.Pointer(&result)))
	if int32(hr) < 0 {
		return "", fmt.Errorf("query browser association: HRESULT %#x", uint32(hr))
	}
	if result == nil {
		return "", errors.New("browser association is empty")
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(result))
	id := windows.UTF16PtrToString(result)
	if !validBrowserProgID(id) {
		return "", errors.New("browser association is not a ProgID")
	}
	return id, nil
}

func (s *relay) openBrowser(path, id string, generation int64, launchCode string) (string, error) {
	// COM and ShellExecuteEx must run on the same STA thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, 0x2|0x4); err != nil && err != syscall.Errno(1) { // S_FALSE is success.
		return "", err
	}
	defer windows.CoUninitialize()
	progID, err := queryBrowserProgID()
	if err != nil {
		return "", err
	}
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	class, err := windows.UTF16PtrFromString(progID)
	if err != nil {
		return "", err
	}
	verb, _ := windows.UTF16PtrFromString("open")
	info := shellExecuteInfo{
		size: uint32(unsafe.Sizeof(shellExecuteInfo{})),
		mask: 0x00000001 | 0x00000100, // SEE_MASK_CLASSNAME | SEE_MASK_NOASYNC
		verb: verb, file: file, class: class, show: windows.SW_SHOWNORMAL,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.launch != launchCode || !s.launchBound || s.launchGeneration != generation || s.generation != generation || s.generationEnded || !time.Now().Before(s.launchExpiry) {
		return "", os.ErrPermission
	}
	ok, _, callErr := shellExecuteEx.Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return "", fmt.Errorf("open browser: %w", callErr)
	}
	return "dispatched", nil
}

func shellOpen(path string) error {
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}
