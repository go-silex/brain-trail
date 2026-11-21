//go:build !windows

package main

import "os"

func coworkPrivateMkdir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return os.Chmod(dir, 0700)
}
