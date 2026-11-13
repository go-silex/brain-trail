//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func applicationPath(app application) string {
	if runtime.GOOS == "darwin" {
		dirs := []string{"/Applications", "/System/Applications"}
		if home, err := os.UserHomeDir(); err == nil {
			dirs = append(dirs, filepath.Join(home, "Applications"))
		}
		for _, dir := range dirs {
			path := filepath.Join(dir, app.name+".app")
			if info, err := os.Stat(path); err == nil && info.IsDir() {
				return path
			}
		}
		return ""
	}
	if app.name == "Obsidian" {
		if output, err := exec.Command("xdg-mime", "query", "default", "x-scheme-handler/obsidian").Output(); err == nil && strings.TrimSpace(string(output)) != "" {
			return "obsidian-handler"
		}
	}
	for _, name := range app.unix {
		if path, err := exec.LookPath(name); err == nil {
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
				return path
			}
		}
	}
	return ""
}

func openCommand(path, app string) (*exec.Cmd, error) {
	if app == "" {
		if runtime.GOOS == "darwin" {
			return exec.Command("/usr/bin/open", "--", path), nil
		}
		return exec.Command("xdg-open", path), nil
	}
	selected, executable, err := selectedApp(app)
	if err != nil {
		return nil, err
	}
	if selected.name == "Obsidian" {
		path = obsidianURL(path)
		if executable == "obsidian-handler" {
			return exec.Command("xdg-open", path), nil
		}
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("/usr/bin/open", "-a", executable, "--", path), nil
	}
	return exec.Command(executable, path), nil
}

func (s *relay) openPath(path, app, id string, generation int64, launchCode string) (string, error) {
	command, err := openCommand(path, app)
	if err != nil {
		return "", err
	}
	return s.startLaunchForCode(command, id, generation, launchCode)
}
