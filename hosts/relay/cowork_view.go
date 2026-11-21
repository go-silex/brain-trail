package main

import (
	"container/list"
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
	ID        string `json:"id"`
	Started   int64  `json:"started"`
	Last      int64  `json:"last"`
	Ended     bool   `json:"ended"`
	Truncated bool   `json:"truncated"`
	Calls     int    `json:"calls"`
}

const coworkViewCacheEntries = 16
const coworkViewCacheBytes = 2 << 20

type coworkViewCache struct {
	started  int64
	instance int64
	indexed  map[string]bool
	names    []string
	bytes    int
	dirInfo  os.FileInfo
	element  *list.Element
}

type coworkViewer struct {
	relay           *relay
	root            string
	session         string
	mu              sync.Mutex
	cache           map[string]*coworkViewCache
	lru             list.List
	cacheBytes      int
	nextInstance    int64
	activity        chan struct{}
	beforeDiscovery func()
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
	b, err := coworkReadRegular(filepath.Join(v.root, "sessions", coworkSessionKey(id), "session.json"), 8192)
	if err != nil || json.Unmarshal(b, &s) != nil || s.V != 1 || s.ID != id {
		return s, false
	}
	return s, true
}

func coworkMarker(dir, name string) bool {
	st, err := os.Stat(filepath.Join(dir, name))
	return err == nil && st.Mode().IsRegular()
}

// Sequence numbers are stable for the lifetime of a cached instance.
func (v *coworkViewer) forgetCache(id string) {
	if c := v.cache[id]; c != nil {
		v.cacheBytes -= c.bytes
		v.lru.Remove(c.element)
		delete(v.cache, id)
	}
}

func (v *coworkViewer) discover(id string, started int64) ([]string, error) {
	if v.cache == nil {
		v.cache = make(map[string]*coworkViewCache)
	}
	cache := v.cache[id]
	if cache != nil && cache.started != started {
		v.forgetCache(id)
		cache = nil
	}
	if cache == nil {
		now := time.Now().UnixMilli()
		if now <= v.nextInstance {
			now = v.nextInstance + 1
		}
		v.nextInstance = now
		cache = &coworkViewCache{started: started, instance: now, indexed: make(map[string]bool), bytes: len(id) + 128}
		cache.element = v.lru.PushFront(id)
		v.cache[id] = cache
		v.cacheBytes += cache.bytes
	} else {
		v.lru.MoveToFront(cache.element)
	}
	defer func() {
		for len(v.cache) > coworkViewCacheEntries || v.cacheBytes > coworkViewCacheBytes {
			v.forgetCache(v.lru.Back().Value.(string))
		}
	}()
	scanStart := time.Now()
	dir := filepath.Join(v.root, "sessions", coworkSessionKey(id), "r")
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		cache.dirInfo = nil
		return cache.names, nil
	}
	if cache.dirInfo != nil && os.SameFile(cache.dirInfo, info) && cache.dirInfo.ModTime().Equal(info.ModTime()) {
		return cache.names, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	cache.dirInfo = nil
	allRead := true
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".tmp-") || !strings.HasSuffix(name, ".json") || cache.indexed[name] {
			continue
		}
		b, err := coworkReadRegular(filepath.Join(dir, name), 8192)
		var receipt coworkReceipt
		if err != nil || json.Unmarshal(b, &receipt) != nil || receipt.V != 1 {
			allRead = false
			continue
		}
		n := len(name) + 128
		if cache.bytes+n > coworkViewCacheBytes {
			v.forgetCache(id)
			return nil, errors.New("receipt index exceeds cache budget")
		}
		cache.indexed[name] = true
		cache.names = append(cache.names, name)
		cache.bytes += n
		v.cacheBytes += n
	}
	if allRead && !info.ModTime().After(scanStart.Add(-2*time.Second)) {
		cache.dirInfo = info
	}
	return cache.names, nil
}

// discoverSession validates the instance again after enumeration, while v.mu is held.
func (v *coworkViewer) discoverSession(id string, session coworkSession) (coworkSession, []string, bool, bool, bool, int) {
	changed := false
	dir := filepath.Join(v.root, "sessions", coworkSessionKey(id))
	for range 3 {
		ended, truncated := coworkMarker(dir, "ended"), coworkMarker(dir, "truncated")
		all, err := v.discover(id, session.Started)
		if err != nil {
			return session, nil, false, false, changed, http.StatusServiceUnavailable
		}
		current, exists := v.loadSession(id)
		if !exists {
			v.forgetCache(id)
			return session, nil, false, false, changed, http.StatusNotFound
		}
		if current.Started == session.Started {
			return current, all, ended, truncated, changed, 0
		}
		v.forgetCache(id)
		session = current
		changed = true
	}
	return session, nil, false, false, changed, http.StatusServiceUnavailable
}

func (v *coworkViewer) sessions() []coworkViewSession {
	type candidate struct {
		key  string
		last int64
	}
	root := filepath.Join(v.root, "sessions")
	entries, _ := os.ReadDir(root)
	candidates := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		st, err := os.Stat(filepath.Join(dir, "active"))
		if err != nil || !st.Mode().IsRegular() {
			st, err = os.Stat(filepath.Join(dir, "session.json"))
		}
		if err == nil && st.Mode().IsRegular() {
			candidates = append(candidates, candidate{entry.Name(), st.ModTime().UnixMilli()})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].last == candidates[j].last {
			return candidates[i].key < candidates[j].key
		}
		return candidates[i].last > candidates[j].last
	})
	if len(candidates) > 100 {
		candidates = candidates[:100]
	}
	result := make([]coworkViewSession, 0, len(candidates))
	for _, candidate := range candidates {
		dir := filepath.Join(root, candidate.key)
		b, err := coworkReadRegular(filepath.Join(dir, "session.json"), 8192)
		var s coworkSession
		if err != nil || json.Unmarshal(b, &s) != nil || s.V != 1 || !coworkValidID(s.ID) || coworkSessionKey(s.ID) != candidate.key {
			continue
		}
		item := coworkViewSession{ID: s.ID, Started: s.Started, Last: candidate.last, Ended: coworkMarker(dir, "ended"), Truncated: coworkMarker(dir, "truncated")}
		receipts, _ := os.ReadDir(filepath.Join(dir, "r"))
		for _, entry := range receipts {
			if !entry.IsDir() && !strings.HasPrefix(entry.Name(), ".tmp-") && !strings.HasPrefix(entry.Name(), "_") && strings.HasSuffix(entry.Name(), ".json") {
				item.Calls++
			}
		}
		result = append(result, item)
	}
	return result
}

func (v *coworkViewer) noteActivity() {
	if v.activity != nil {
		select {
		case v.activity <- struct{}{}:
		default:
		}
	}
}

func (v *coworkViewer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	headers(w)
	if r.Host != v.relay.host || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+v.relay.host) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/launch/") && r.Method == http.MethodGet {
		code := strings.TrimPrefix(r.URL.Path, "/launch/")
		s := v.relay
		s.mu.Lock()
		ok := s.launch != "" && time.Now().Before(s.launchExpiry) && (!s.launchBound || (s.launchGeneration == s.generation && !s.generationEnded)) && subtle.ConstantTimeCompare([]byte(code), []byte(s.launch)) == 1
		if ok {
			s.clearLaunchLocked()
		}
		s.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		v.noteActivity()
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
	v.noteActivity()
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
		session, ok := v.loadSession(id)
		if !ok {
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
		if v.beforeDiscovery != nil {
			v.beforeDiscovery()
		}
		v.mu.Lock()
		session, all, ended, truncated, changed, status := v.discoverSession(id, session)
		if status != 0 {
			v.mu.Unlock()
			w.WriteHeader(status)
			return
		}
		instance := v.cache[id].instance
		if changed {
			v.mu.Unlock()
			jsonOut(w, map[string]any{"session": id, "instance": instance, "receipts": []coworkIndexedReceipt{}, "next": after, "ended": ended, "truncated": truncated, "more": false})
			return
		}
		start := after
		if start > len(all) {
			start = len(all)
		}
		end, size := start, 512
		result := make([]coworkIndexedReceipt, 0)
		dir := filepath.Join(v.root, "sessions", coworkSessionKey(id), "r")
		for end < len(all) && len(result) < 1000 {
			b, err := coworkReadRegular(filepath.Join(dir, all[end]), 8192)
			var receipt coworkReceipt
			if err != nil || json.Unmarshal(b, &receipt) != nil || receipt.V != 1 {
				v.mu.Unlock()
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			indexed := coworkIndexedReceipt{coworkReceipt: receipt, N: end + 1}
			b, err = ascii(indexed)
			if err != nil || size+len(b)+1 > 1536*1024 {
				break
			}
			size += len(b) + 1
			result = append(result, indexed)
			end++
		}
		current, exists := v.loadSession(id)
		if !exists || current.Started != session.Started {
			v.forgetCache(id)
			v.mu.Unlock()
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		more := end < len(all)
		next := after
		if end > start {
			next = end
		}
		v.mu.Unlock()
		jsonOut(w, map[string]any{"session": id, "instance": instance, "receipts": result, "next": next, "ended": ended, "truncated": truncated, "more": more})
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
	var err error
	root, err = coworkCanonicalRoot(root)
	if err != nil {
		return err
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
	// Match the generation-bound launch invariant enforced by open_windows.go.
	s := &relay{host: listener.Addr().String(), token: token, assets: assets, dir: dir, launch: code, launchExpiry: time.Now().Add(120 * time.Second), generation: 1, launchBound: true, launchGeneration: 1, out: make(chan []byte, 64), outputFailure: make(chan struct{}, 1)}
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
	if _, err = s.openBrowser(launchFile, "", 1, code); err != nil {
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
