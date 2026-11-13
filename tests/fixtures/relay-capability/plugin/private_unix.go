//go:build !windows

package main

import "os"

func privateTempDir() (string, error) {
	return os.MkdirTemp("", "btr-é😀-")
}

func privacyEvidence(_, _ string) (string, error) {
	return "", nil
}
