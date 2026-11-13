//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func serviceEntry() bool { return false }
func managerGuard() error {
	if os.Geteuid() != 0 {
		return errors.New("Linux proof requires a root-launched manager")
	}
	return nil
}
func prepareStage(stage string) error { return os.Chmod(stage, 0755) }
func prepareSocket(path string) error { return os.Chmod(path, 0777) }
func isPermission(err error) bool {
	return errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM)
}
func isClosed(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}
func verifyIdentity(r request) error {
	info, err := os.Stat(r.Directory)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || os.Geteuid() == 0 || uint32(os.Geteuid()) == st.Uid {
		return errors.New("child is root or directory owner")
	}
	return nil
}

func execute(stage string, r request) error {
	if os.Geteuid() != 0 {
		return errors.New("Linux proof requires a root-launched manager")
	}
	u, err := user.Lookup("nobody")
	if err != nil {
		return err
	}
	uid, e1 := strconv.ParseUint(u.Uid, 10, 32)
	gid, e2 := strconv.ParseUint(u.Gid, 10, 32)
	if e1 != nil || e2 != nil || uid == 0 {
		return errors.New("invalid nobody identity")
	}
	info, err := os.Stat(r.Directory)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint32(uid) == st.Uid || st.Uid == 0 {
		return errors.New("invalid relay directory owner")
	}
	src, err := os.Executable()
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(filepath.Join(stage, "probe"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	arg, err := json.Marshal(r)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(stage, "probe"), "--child", string(arg))
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}}
	data, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("other-account probe failed: %w", err)
	}
	var result report
	if len(data) > 4096 || json.Unmarshal(data, &result) != nil || !result.OK {
		return fmt.Errorf("other-account probe failed: %s", result.Error)
	}
	return nil
}
