package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type coworkIndexedReceipt struct {
	coworkReceipt
	N int `json:"n"`
}

type coworkViewSession struct {
	ID         string `json:"id"`
	Task       string `json:"task"`
	Started    int64  `json:"started"`
	Last       int64  `json:"last"`
	Ended      bool   `json:"ended"`
	Tools      int    `json:"tools"`
	Files      int    `json:"files"`
	Connectors int    `json:"connectors"`
}

type coworkViewer struct {
	relay    *relay
	root     string
	session  string
	mu       sync.Mutex
	indexed  map[string]map[string]int
	receipts map[string][]coworkIndexedReceipt
	activity chan struct{}
}

func coworkValidID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func (v *coworkViewer) loadSession(id string) (coworkSession, bool) {
	var s coworkSession
	if !coworkValidID(id) {
		return s, false
	}
	b, err := os.ReadFile(filepath.Join(v.root, "sessions", id, "session.json"))
	if err != nil || len(b) > 8192 || json.Unmarshal(b, &s) != nil || s.V != 1 || s.ID != id {
		return s, false
	}
	return s, true
}

func coworkMarker(dir, name string) bool {
	st, err := os.Stat(filepath.Join(dir, name))
	return err == nil && st.Mode().IsRegular()
}

// discover assigns sequence numbers once, independent of receipt timestamps.
func (v *coworkViewer) discover(id string) []coworkIndexedReceipt {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.indexed == nil {
		v.indexed = make(map[string]map[string]int)
		v.receipts = make(map[string][]coworkIndexedReceipt)
	}
	if v.indexed[id] == nil {
		v.indexed[id] = make(map[string]int)
	}
	dir := filepath.Join(v.root, "sessions", id, "r")
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || v.indexed[id][name] != 0 {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		var receipt coworkReceipt
		if err != nil || len(b) > 8192 || json.Unmarshal(b, &receipt) != nil || receipt.V != 1 {
			continue
		}
		n := len(v.receipts[id]) + 1
		v.indexed[id][name] = n
		v.receipts[id] = append(v.receipts[id], coworkIndexedReceipt{coworkReceipt: receipt, N: n})
	}
	return append([]coworkIndexedReceipt(nil), v.receipts[id]...)
}

func (v *coworkViewer) sessions() []coworkViewSession {
	result := make([]coworkViewSession, 0)
	entries, _ := os.ReadDir(filepath.Join(v.root, "sessions"))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		s, ok := v.loadSession(id)
		if !ok {
			continue
		}
		item := coworkViewSession{ID: id, Task: s.Task, Started: s.Started, Last: s.Started, Ended: coworkMarker(filepath.Join(v.root, "sessions", id), "ended")}
		files, connectors := make(map[string]bool), make(map[string]bool)
		for _, r := range v.discover(id) {
			if r.At > item.Last {
				item.Last = r.At
			}
			if r.Ev == "tool" {
				item.Tools++
			}
			for _, f := range r.Files {
				files[f.P] = true
			}
			for _, p := range r.Seen {
				files[p] = true
			}
			if r.MCP != nil && r.MCP.Server != "" {
				connectors[r.MCP.Server] = true
			}
		}
		item.Files, item.Connectors = len(files), len(connectors)
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Last == result[j].Last {
			return result[i].ID < result[j].ID
		}
		return result[i].Last > result[j].Last
	})
	if len(result) > 100 {
		result = result[:100]
	}
	return result
}

func (v *coworkViewer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	headers(w)
	if r.Host != v.relay.host || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+v.relay.host) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if v.activity != nil {
		select {
		case v.activity <- struct{}{}:
		default:
		}
	}
	if strings.HasPrefix(r.URL.Path, "/launch/") && r.Method == http.MethodGet {
		code := strings.TrimPrefix(r.URL.Path, "/launch/")
		s := v.relay
		s.mu.Lock()
		ok := s.launch != "" && time.Now().Before(s.launchExpiry) && subtle.ConstantTimeCompare([]byte(code), []byte(s.launch)) == 1
		if ok {
			s.clearLaunchLocked()
		}
		s.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		query := url.Values{"host": {"cowork"}}
		if _, exists := v.loadSession(v.session); exists {
			query.Set("session", v.session)
		}
		http.Redirect(w, r, "/s/"+s.token+"/?"+query.Encode(), http.StatusSeeOther)
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/s/")
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	segment, path, ok := strings.Cut(rest, "/")
	if !ok || subtle.ConstantTimeCompare([]byte(segment), []byte(v.relay.token)) != 1 {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	switch path {
	case "", "app.js", "app.css":
		name := path
		if name == "" {
			name = "index.html"
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		} else if name == "app.js" {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		} else {
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		}
		http.ServeFile(w, r, filepath.Join(v.relay.assets, name))
	case "cowork/sessions":
		jsonOut(w, map[string]any{"sessions": v.sessions()})
	case "cowork/receipts":
		id := r.URL.Query().Get("session")
		if _, ok := v.loadSession(id); !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		after := 0
		if value := r.URL.Query().Get("after"); value != "" {
			var err error
			after, err = strconv.Atoi(value)
			if err != nil || after < 0 {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		}
		all := v.discover(id)
		result := make([]coworkIndexedReceipt, 0)
		next := after
		for _, item := range all {
			if item.N > after && len(result) < 1000 {
				result = append(result, item)
				next = item.N
			}
		}
		dir := filepath.Join(v.root, "sessions", id)
		jsonOut(w, map[string]any{"session": id, "receipts": result, "next": next, "ended": coworkMarker(dir, "ended"), "truncated": coworkMarker(dir, "truncated")})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func coworkView(assets, session, root string) error {
	if !filepath.IsAbs(assets) {
		return errors.New("assets must be absolute")
	}
	for _, name := range []string{"index.html", "app.js", "app.css"} {
		if st, err := os.Stat(filepath.Join(assets, name)); err != nil || !st.Mode().IsRegular() {
			return errors.New("missing browser assets")
		}
	}
	dir, err := privateTempDir()
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	token, err := secret()
	if err != nil {
		return err
	}
	code, err := secret()
	if err != nil {
		return err
	}
	s := &relay{host: listener.Addr().String(), token: token, assets: assets, dir: dir, launch: code, launchExpiry: time.Now().Add(120 * time.Second), out: make(chan []byte, 64), outputFailure: make(chan struct{}, 1)}
	defer func() { s.mu.Lock(); s.clearLaunchLocked(); s.mu.Unlock() }()
	launchFile := filepath.Join(dir, "open.html")
	data := []byte(`<!doctype html><meta http-equiv="refresh" content="0;url=http://` + s.host + `/launch/` + code + `"><title>Opening Brain Trail</title>`)
	f, err := os.OpenFile(launchFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	s.launchFile = launchFile
	_, err = f.Write(data)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	s.launchTimer = time.AfterFunc(time.Until(s.launchExpiry), func() {
		s.mu.Lock()
		if s.launch == code {
			s.clearLaunchLocked()
		}
		s.mu.Unlock()
	})
	v := &coworkViewer{relay: s, root: root, session: session, activity: make(chan struct{}, 1)}
	server := boundedServer(http.HandlerFunc(v.serveHTTP))
	defer server.Close()
	done := make(chan error, 1)
	go func() { done <- server.Serve(&limitedListener{Listener: listener, slots: make(chan struct{}, 64)}) }()
	if _, err = s.openBrowser(launchFile, "", 0, code); err != nil {
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	timer := time.NewTimer(30 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-signals:
			return nil
		case err := <-done:
			return err
		case <-timer.C:
			return nil
		case <-v.activity:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(30 * time.Minute)
		}
	}
}
