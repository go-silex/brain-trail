//go:build !windows

package main

import (
	"errors"
	"fmt"
	"net/url"
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

// browserCommand selects the system's web browser, not the handler for HTML
// documents. Only the private handoff filename is passed to the browser.
func browserCommand(path string) (*exec.Cmd, error) {
	if runtime.GOOS == "darwin" {
		const script = `ObjC.import('AppKit'); var u = $.NSURL.URLWithString('https://example.invalid/'); var app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(u); app ? ObjC.unwrap(app.path) : ''`
		out, err := exec.Command("/usr/bin/osascript", "-l", "JavaScript", "-e", script).Output()
		if err != nil {
			return nil, err
		}
		app := strings.TrimSpace(string(out))
		if app == "" || !filepath.IsAbs(app) {
			return nil, fmt.Errorf("no default web browser")
		}
		return exec.Command("/usr/bin/open", "-a", app, "--", path), nil
	}
	out, err := exec.Command("xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return nil, err
	}
	id := strings.TrimSpace(string(out))
	if id == "" || strings.HasPrefix(id, "-") || strings.ContainsAny(id, "/\\\x00\r\n") || !strings.HasSuffix(id, ".desktop") {
		return nil, fmt.Errorf("invalid default web browser desktop ID")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("browser handoff path must be absolute")
	}
	if _, err := exec.LookPath("gtk-launch"); err == nil {
		fileURL := (&url.URL{Scheme: "file", Path: path}).String()
		return exec.Command("gtk-launch", id, fileURL), nil
	} else if !errors.Is(err, exec.ErrNotFound) {
		return nil, err
	}
	// Fall back only when the current HTML association reports the same
	// desktop ID as the browser. xdg-open resolves it again when launched.
	html, err := exec.Command("xdg-mime", "query", "default", "text/html").Output()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(html)) != id {
		return nil, fmt.Errorf("HTML handler differs from default browser and gtk-launch is unavailable")
	}
	return exec.Command("xdg-open", path), nil
}

func (s *relay) openBrowser(path, id string, generation int64, launchCode string) (string, error) {
	command, err := browserCommand(path)
	if err != nil {
		return "", err
	}
	return s.startLaunchForCode(command, id, generation, launchCode)
}

func (s *relay) openPath(path, app, id string, generation int64, launchCode string, scopes ...*Guard) (string, error) {
	command, err := openCommand(path, app)
	if err != nil {
		return "", err
	}
	return s.startLaunchForCode(command, id, generation, launchCode, scopes...)
}
