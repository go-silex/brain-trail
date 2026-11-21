package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

type coworkSession struct {
	V       int    `json:"v"`
	ID      string `json:"id"`
	Started int64  `json:"started"`
	Task    string `json:"task"`
}

func strconvInt(n int64) string { return strconv.FormatInt(n, 10) }
func coworkStoreRoot() (string, error) {
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("LOCALAPPDATA")
	case "darwin":
		home, e := os.UserHomeDir()
		if e != nil {
			return "", e
		}
		base = filepath.Join(home, "Library", "Application Support")
	default:
		base = os.Getenv("XDG_STATE_HOME")
		if base == "" {
			home, e := os.UserHomeDir()
			if e != nil {
				return "", e
			}
			base = filepath.Join(home, ".local", "state")
		}
	}
	if !filepath.IsAbs(base) {
		return "", errors.New("invalid state directory")
	}
	return filepath.Join(base, "brain-trail", "cowork", "v1"), nil
}
func coworkExclusive(path string, data []byte) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	n, e := f.Write(data)
	if e == nil && n != len(data) {
		e = errors.New("short write")
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		_ = os.Remove(path)
	}
	return e
}
func writeCoworkReceipt(root, id, task, key string, data []byte, event string, now time.Time) error {
	if !coworkID.MatchString(id) {
		return errors.New("invalid session")
	}
	sessions := filepath.Join(root, "sessions")
	if err := coworkPrivateMkdir(sessions); err != nil {
		return err
	}
	dir := filepath.Join(sessions, id)
	if err := coworkPrivateMkdir(dir); err != nil {
		return err
	}
	// Serialize all writers to enforce the cap across hook processes.
	lock := filepath.Join(dir, ".lock")
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := os.Mkdir(lock, 0700)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			return err
		}
		if st, e := os.Stat(lock); e == nil && time.Since(st.ModTime()) > time.Minute {
			_ = os.Remove(lock)
		}
		if time.Now().After(deadline) {
			return errors.New("store busy")
		}
		time.Sleep(5 * time.Millisecond)
	}
	defer os.Remove(lock)
	receipts := filepath.Join(dir, "r")
	if err := coworkPrivateMkdir(receipts); err != nil {
		return err
	}
	session, _ := json.Marshal(coworkSession{V: 1, ID: id, Started: now.UnixMilli(), Task: task})
	if err := coworkExclusive(filepath.Join(dir, "session.json"), session); err != nil && !os.IsExist(err) {
		return err
	}
	target := filepath.Join(receipts, key+".json")
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	entries, err := os.ReadDir(receipts)
	if err != nil {
		return err
	}
	if len(entries) >= 5000 {
		_ = coworkExclusive(filepath.Join(dir, "truncated"), nil)
		if event == "end" {
			_ = coworkExclusive(filepath.Join(dir, "ended"), nil)
		}
		if event == "start" {
			pruneCowork(sessions, id, now)
		}
		return nil
	}
	if err = coworkExclusive(target, data); err != nil && !os.IsExist(err) {
		return err
	}
	if event == "end" {
		_ = coworkExclusive(filepath.Join(dir, "ended"), nil)
	}
	if event == "start" {
		pruneCowork(sessions, id, now)
	}
	return nil
}
func pruneCowork(sessions, current string, now time.Time) {
	entries, err := os.ReadDir(sessions)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == current || !coworkID.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(sessions, entry.Name())
		st, e := os.Stat(filepath.Join(dir, "r"))
		if e != nil {
			st, e = os.Stat(filepath.Join(dir, "session.json"))
		}
		if e == nil && now.Sub(st.ModTime()) > 7*24*time.Hour {
			_ = os.RemoveAll(dir)
		}
	}
}
