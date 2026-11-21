//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func coworkLocalBase() (string, error) { return "", errors.New("not Windows") }

func coworkVerifyDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("untrusted store directory")
	}
	return nil
}

func coworkPrivateMkdir(dir string) error {
	err := os.Mkdir(dir, 0700)
	if os.IsNotExist(err) {
		if err = coworkPrivateMkdir(filepath.Dir(dir)); err != nil {
			return err
		}
		err = os.Mkdir(dir, 0700)
	}
	if err != nil && !os.IsExist(err) {
		return err
	}
	if err = coworkVerifyDir(dir); err != nil {
		return err
	}
	return os.Chmod(dir, 0700)
}
