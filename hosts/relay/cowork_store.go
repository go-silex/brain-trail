package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
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
		var err error
		base, err = coworkLocalBase()
		if err != nil {
			return "", err
		}
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
func coworkSessionKey(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:16])
}

func coworkReadRegular(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	f, err := coworkOpenRead(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() > limit {
		return nil, errors.New("invalid file")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("file exceeds limit")
	}
	return data, nil
}

// Caller holds the session lock. Never publish a partial JSON file.
func coworkPublish(path string, data []byte) error {
	if _, err := os.Lstat(path); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		var n int
		n, err = f.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func coworkTouch(path string, now time.Time) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		if err = coworkPublish(path, nil); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return errors.New("invalid activity marker")
	}
	return os.Chtimes(path, now, now)
}

func writeCoworkReceipt(root, id, task, key string, data []byte, event string, now time.Time) error {
	if !coworkID.MatchString(id) || len(data) > 8192 {
		return errors.New("invalid session or receipt")
	}
	sessions := filepath.Join(root, "sessions")
	if filepath.Base(root) == "v1" && filepath.Base(filepath.Dir(root)) == "cowork" {
		if err := coworkPrivateMkdir(filepath.Dir(filepath.Dir(root))); err != nil {
			return err
		}
		if err := coworkPrivateMkdir(filepath.Dir(root)); err != nil {
			return err
		}
	}
	if err := coworkPrivateMkdir(root); err != nil {
		return err
	}
	if err := coworkPrivateMkdir(sessions); err != nil {
		return err
	}
	sessionKey := coworkSessionKey(id)
	dir := filepath.Join(sessions, sessionKey)
	if err := coworkPrivateMkdir(dir); err != nil {
		return err
	}
	unlock, err := coworkLock(filepath.Join(dir, ".lock"), true)
	if err != nil {
		return err
	}
	err = func() error {
		defer unlock()
		receipts := filepath.Join(dir, "r")
		if err := coworkPrivateMkdir(receipts); err != nil {
			return err
		}
		metadata := filepath.Join(dir, "session.json")
		raw, err := coworkReadRegular(metadata, 8192)
		if _, statErr := os.Lstat(metadata); os.IsNotExist(statErr) {
			raw, _ = json.Marshal(coworkSession{V: 1, ID: id, Started: now.UnixMilli(), Task: task})
			if err = coworkPublish(metadata, raw); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		var session coworkSession
		if json.Unmarshal(raw, &session) != nil || session.V != 1 || session.ID != id {
			return errors.New("session identity mismatch")
		}
		if err := coworkTouch(filepath.Join(dir, "active"), now); err != nil {
			return err
		}
		if event == "start" {
			if err := os.Remove(filepath.Join(dir, "ended")); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		target := filepath.Join(receipts, key+".json")
		_, err = os.Lstat(target)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if os.IsNotExist(err) {
			entries, err := os.ReadDir(receipts)
			if err != nil {
				return err
			}
			count := 0
			for _, entry := range entries {
				if filepath.Ext(entry.Name()) == ".json" {
					count++
				}
			}
			if count >= 5000 {
				if err := coworkPublish(filepath.Join(dir, "truncated"), nil); err != nil && !os.IsExist(err) {
					return err
				}
			} else if err := coworkPublish(target, data); err != nil && !os.IsExist(err) {
				return err
			}
		}
		if event == "end" {
			if err := coworkPublish(filepath.Join(dir, "ended"), nil); err != nil && !os.IsExist(err) {
				return err
			}
		}
		return nil
	}()
	if event == "start" {
		pruneCowork(sessions, sessionKey, now)
	}
	return err
}

func coworkExpired(dir string, now time.Time) bool {
	st, err := os.Lstat(filepath.Join(dir, "active"))
	if os.IsNotExist(err) {
		st, err = os.Lstat(filepath.Join(dir, "session.json"))
	}
	return err == nil && st.Mode().IsRegular() && now.Sub(st.ModTime()) > 7*24*time.Hour
}

func pruneCowork(sessions, current string, now time.Time) {
	f, err := os.Open(sessions)
	if err != nil {
		return
	}
	defer f.Close()
	entries, _ := f.ReadDir(64)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == current || len(entry.Name()) != 32 {
			continue
		}
		if _, err := hex.DecodeString(entry.Name()); err != nil {
			continue
		}
		dir := filepath.Join(sessions, entry.Name())
		if coworkVerifyDir(dir) != nil || !coworkExpired(dir, now) {
			continue
		}
		unlock, err := coworkLock(filepath.Join(dir, ".lock"), false)
		if err != nil {
			continue
		}
		var cleanup func()
		if coworkVerifyDir(dir) == nil && coworkExpired(dir, now) {
			cleanup = coworkPruneLocked(dir)
		}
		unlock()
		if cleanup != nil {
			cleanup()
		}
	}
}
