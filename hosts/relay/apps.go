package main

import (
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"strings"
)

// The names match hooks/workspace.ts. Only these applications can be launched.
type application struct {
	name    string
	unix    []string
	windows []string
}

var applications = []application{
	{"Obsidian", []string{"obsidian"}, []string{"Obsidian.exe"}},
	{"Visual Studio Code", []string{"code", "code-oss"}, []string{"Code.exe"}},
	{"Cursor", []string{"cursor"}, []string{"Cursor.exe"}},
	{"Windsurf", []string{"windsurf"}, []string{"Windsurf.exe"}},
	{"Zed", []string{"zed"}, []string{"zed.exe"}},
	{"Sublime Text", []string{"subl", "sublime_text"}, []string{"sublime_text.exe"}},
	{"Typora", []string{"typora"}, []string{"Typora.exe"}},
	{"iA Writer", nil, nil},
	{"Bear", nil, nil},
	{"TextEdit", nil, nil},
	{"Xcode", nil, nil},
	{"BBEdit", nil, nil},
	{"Nova", nil, nil},
}

var errUnsupportedApp = errors.New("unsupported or unavailable application")

func appNames() []string {
	names := make([]string, 0, len(applications))
	for _, app := range applications {
		if applicationPath(app) != "" {
			names = append(names, app.name)
		}
	}
	return names
}

func selectedApp(name string) (application, string, error) {
	for _, app := range applications {
		if app.name == name {
			if path := applicationPath(app); path != "" {
				return app, path, nil
			}
			break
		}
	}
	return application{}, "", fmt.Errorf("%w: %q", errUnsupportedApp, name)
}

func obsidianURL(path string) string {
	return "obsidian://open?path=" + strings.ReplaceAll(url.QueryEscape(path), "+", "%20")
}

// Wait in the background to reap the child without blocking on a GUI process.
func launch(command *exec.Cmd) error {
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}
