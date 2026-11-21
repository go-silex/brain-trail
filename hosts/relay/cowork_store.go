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
	"sort"
	"strconv"
	"strings"
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
	f, err := coworkCreateTemp(filepath.Dir(path))
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
	if err := coworkVerifyAncestors(root); err != nil {
		return err
	}
	sessions := filepath.Join(root, "sessions")
	if filepath.Base(root) == "v1" && filepath.Base(filepath.Dir(root)) == "cowork" {
		if err := coworkPrepareParent(filepath.Dir(filepath.Dir(root))); err != nil {
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
		if event == "start" || event == "end" {
			key = "_" + key
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
		if os.IsNotExist(err) {
			st, err = os.Lstat(dir)
			return err == nil && st.IsDir() && now.Sub(st.ModTime()) > 7*24*time.Hour
		}
	}
	return err == nil && st.Mode().IsRegular() && now.Sub(st.ModTime()) > 7*24*time.Hour
}

func pruneCowork(sessions, current string, now time.Time) {
	unlockPass, err := coworkLock(filepath.Join(sessions, ".prune-lock"), false)
	if err != nil {
		return
	}
	defer unlockPass()
	f, err := os.Open(sessions)
	if err != nil {
		return
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil || len(names) == 0 {
		return
	}
	candidates := names[:0]
	for _, name := range names {
		if strings.HasPrefix(name, ".prune-") && name != ".prune-lock" && name != ".prune-cursor" {
			dir := filepath.Join(sessions, name)
			if coworkVerifyDir(dir) == nil {
				unlock, err := coworkLock(filepath.Join(dir, ".lock"), false)
				if err == nil {
					unlock()
					_ = os.RemoveAll(dir)
				}
			}
			continue
		}
		if len(name) == 32 {
			if _, err := hex.DecodeString(name); err == nil {
				candidates = append(candidates, name)
			}
		}
	}
	names = candidates
	if len(names) == 0 {
		return
	}
	sort.Strings(names)
	cursorPath := filepath.Join(sessions, ".prune-cursor")
	cursor, _ := coworkReadRegular(cursorPath, 1024)
	start := sort.SearchStrings(names, string(cursor))
	for start < len(names) && names[start] <= string(cursor) {
		start++
	}
	if start == len(names) {
		start = 0
	}
	count := len(names)
	if count > 64 {
		count = 64
	}
	for i := range count {
		name := names[(start+i)%len(names)]
		if name == current {
			continue
		}
		dir := filepath.Join(sessions, name)
		if coworkVerifyDir(dir) != nil || !coworkExpired(dir, now) {
			continue
		}
		before, statErr := os.Lstat(dir)
		_, lockErr := os.Lstat(filepath.Join(dir, ".lock"))
		unlock, err := coworkLock(filepath.Join(dir, ".lock"), false)
		if err != nil {
			continue
		}
		var cleanup func()
		expired := coworkExpired(dir, now)
		if !expired && statErr == nil && os.IsNotExist(lockErr) {
			after, err := os.Lstat(dir)
			_, activeErr := os.Lstat(filepath.Join(dir, "active"))
			_, metadataErr := os.Lstat(filepath.Join(dir, "session.json"))
			expired = err == nil && os.SameFile(before, after) &&
				os.IsNotExist(activeErr) && os.IsNotExist(metadataErr) &&
				now.Sub(before.ModTime()) > 7*24*time.Hour
		}
		if coworkVerifyDir(dir) == nil && expired {
			cleanup = coworkPruneLocked(dir)
		}
		unlock()
		if cleanup != nil {
			cleanup()
		}
	}
	if tmp, err := os.CreateTemp(sessions, ".tmp-cursor-"); err == nil {
		path := tmp.Name()
		_, writeErr := tmp.WriteString(names[(start+count-1)%len(names)])
		closeErr := tmp.Close()
		if writeErr == nil && closeErr == nil {
			_ = os.Rename(path, cursorPath)
		}
		_ = os.Remove(path)
	}
}
