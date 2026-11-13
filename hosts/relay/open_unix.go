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

func (s *relay) openPath(path, app, id string, generation int64, launchCode string) (string, error) {
	if app == "" {
		if runtime.GOOS == "darwin" {
			return s.startLaunchForCode(exec.Command("/usr/bin/open", "--", path), id, generation, launchCode)
		}
		return s.startLaunchForCode(exec.Command("/usr/bin/xdg-open", path), id, generation, launchCode)
	}
	selected, executable, err := selectedApp(app)
	if err != nil {
		return "", err
	}
	if selected.name == "Obsidian" {
		path = obsidianURL(path)
		if executable == "obsidian-handler" {
			return s.startLaunchForCode(exec.Command("/usr/bin/xdg-open", path), id, generation, launchCode)
		}
	}
	if runtime.GOOS == "darwin" {
		return s.startLaunchForCode(exec.Command("/usr/bin/open", "-a", executable, "--", path), id, generation, launchCode)
	}
	return s.startLaunchForCode(exec.Command(executable, path), id, generation, launchCode)
}
