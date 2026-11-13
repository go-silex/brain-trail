//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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

func openPath(path, app string) error {
	if app != "" {
		selected, executable, err := selectedApp(app)
		if err != nil {
			return err
		}
		if selected.name == "Obsidian" {
			path = obsidianURL(path)
			if executable == "obsidian-handler" {
				return shellOpen(path)
			}
		}
		return launch(exec.Command(executable, path))
	}
	return shellOpen(path)
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
