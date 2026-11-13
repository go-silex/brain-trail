package main

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
)

const hostLimit = 4194304
const frameLimit = 256 * 1024
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Brain Trail</title><link rel="stylesheet" href="app.css"></head><body><main id="app"></main><div id="status" role="status" aria-live="polite"></div><div id="toast" role="status" aria-live="polite"></div><script type="module" src="app.js"></script></body></html>`
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

type relay struct {
	mu                                  sync.Mutex
	launchMu                            sync.Mutex
	hostToken, token, host, assets, dir string
	launch                              string
	launchExpiry                        time.Time
	generation, revision                int64
	layout, snapshot                    []byte
	ready, initializing                 bool
	seq                                 uint64
	clients                             map[chan []byte]struct{}
	pending                             map[string]chan json.RawMessage
	out                                 chan []byte
	outputFailure                       chan struct{}
	files                               *FileAuthority
	observers                           int
}
type limitedListener struct {
	net.Listener
	slots chan struct{}
}
type limitedConn struct {
	net.Conn
	once  sync.Once
	slots chan struct{}
}

func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { <-c.slots })
	return err
}
func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &limitedConn{Conn: c, slots: l.slots}, nil
		default:
			c.Close()
		}
	}
}
func boundedServer(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
}
func refusal(w http.ResponseWriter, status int, kind string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": kind})
}
func secret() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func validLaunchIdentity(id string, generation *int64) bool {
	if len(id) != 43 || generation == nil || *generation < 0 || *generation > 9007199254740991 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(id)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == id
}
func ascii(v any) ([]byte, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	var s strings.Builder
	for _, r := range string(b) {
		if r < 128 {
			s.WriteByte(byte(r))
		} else if r <= 0xffff {
			fmt.Fprintf(&s, "\\u%04x", r)
		} else {
			a, z := utf16.EncodeRune(r)
			fmt.Fprintf(&s, "\\u%04x\\u%04x", a, z)
		}
	}
	return []byte(s.String()), nil
}
func (s *relay) frame(v any) bool {
	b, e := ascii(v)
	if e != nil || len(b) > frameLimit {
		return false
	}
	b = append(b, '\n')
	select {
	case s.out <- b:
		return true
	default:
		return false
	}
}

// startLaunch owns the only Wait call for each successfully started child.
func (s *relay) startLaunch(command *exec.Cmd, id string, generation int64) (string, error) {
	return s.startLaunchForCode(command, id, generation, "")
}

func (s *relay) startLaunchForCode(command *exec.Cmd, id string, generation int64, launchCode string) (string, error) {
	s.mu.Lock()
	if s.observers >= 32 {
		s.mu.Unlock()
		return "", errors.New("too many active launches")
	}
	s.observers++
	s.mu.Unlock()
	if err := command.Start(); err != nil {
		s.mu.Lock()
		s.observers--
		s.mu.Unlock()
		return "", err
	}
	go func() {
		err := command.Wait()
		code := 0
		if err != nil {
			code = -1
			if command.ProcessState != nil {
				code = command.ProcessState.ExitCode()
			}
		}
		if !s.frame(map[string]any{"t": "launch-exit", "id": id, "generation": generation, "code": code}) {
			select {
			case s.outputFailure <- struct{}{}:
			default:
			}
		}
		s.mu.Lock()
		if code != 0 && launchCode != "" && s.launch == launchCode {
			s.launch = ""
		}
		s.observers--
		s.mu.Unlock()
	}()
	return "spawned", nil
}
func (s *relay) broadcast(b []byte) {
	for ch := range s.clients {
		select {
		case ch <- b:
		default:
			close(ch)
			delete(s.clients, ch)
		}
	}
}
func headers(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Security-Policy", csp)
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
}
func body(r *http.Request, max int64) ([]byte, error) {
	b, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > max {
		return nil, errors.New("too-large")
	}
	if !json.Valid(b) {
		return nil, errors.New("invalid")
	}
	return b, nil
}
func jsonOut(w http.ResponseWriter, v any) {
	b, e := ascii(v)
	if e != nil || len(b) > 2*1024*1024 {
		http.Error(w, "too-large", 413)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}
func fail(w http.ResponseWriter, e error) {
	kind := "forbidden"
	if errors.Is(e, os.ErrNotExist) {
		kind = "missing"
	} else if errors.Is(e, errUnsupportedApp) {
		kind = "unsupported"
	}
	jsonOut(w, map[string]any{"ok": false, "error": kind})
}
func (s *relay) hostHandler(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.hostToken)) != 1 {
		w.WriteHeader(401)
		return
	}
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(10 * time.Second))
	b, e := body(r, hostLimit)
	_ = rc.SetReadDeadline(time.Time{})
	if e != nil {
		if e.Error() == "too-large" {
			refusal(w, 413, "too-large")
		} else {
			refusal(w, 400, "invalid")
		}
		return
	}
	switch r.URL.Path {
	case "/h/event":
		var ev struct {
			V          int    `json:"v"`
			Kind       string `json:"kind"`
			Generation int64  `json:"generation"`
			Revision   int64  `json:"revision"`
		}
		if json.Unmarshal(b, &ev) != nil || ev.V != 1 || ev.Generation < 0 || (ev.Kind != "layout" && ev.Kind != "snapshot" && ev.Kind != "ended") {
			w.WriteHeader(400)
			return
		}
		s.mu.Lock()
		if ev.Generation < s.generation || (ev.Generation == s.generation && ev.Kind == "snapshot" && ev.Revision < s.revision) {
			s.mu.Unlock()
			w.WriteHeader(409)
			return
		}
		if ev.Generation > s.generation {
			s.generation = ev.Generation
			s.revision = 0
			s.layout = nil
			s.snapshot = nil
			s.ready = false
		}
		switch ev.Kind {
		case "layout":
			s.layout = append([]byte(nil), b...)
		case "snapshot":
			s.revision = ev.Revision
			s.snapshot = append([]byte(nil), b...)
			s.ready = !s.initializing
		case "ended":
			s.layout = nil
			s.snapshot = nil
			s.ready = false
		default:
			s.mu.Unlock()
			w.WriteHeader(400)
			return
		}
		s.broadcast(b)
		s.mu.Unlock()
		jsonOut(w, map[string]bool{"ok": true})
	case "/h/ready":
		var q struct {
			Seq uint64 `json:"seq"`
		}
		if json.Unmarshal(b, &q) != nil {
			w.WriteHeader(400)
			return
		}
		s.mu.Lock()
		ok := q.Seq == s.seq && len(s.snapshot) > 0 && len(s.clients) > 0
		if ok {
			s.initializing = false
			s.ready = true
		}
		s.mu.Unlock()
		jsonOut(w, map[string]bool{"ok": ok})
	case "/h/apps":
		jsonOut(w, map[string]any{"apps": appNames()})
	case "/h/reply":
		var q struct {
			ID   string          `json:"id"`
			Body json.RawMessage `json:"body"`
		}
		if json.Unmarshal(b, &q) != nil || len(q.Body) == 0 {
			w.WriteHeader(400)
			return
		}
		s.mu.Lock()
		ch := s.pending[q.ID]
		delete(s.pending, q.ID)
		s.mu.Unlock()
		if ch != nil {
			select {
			case ch <- q.Body:
			default:
			}
		}
		jsonOut(w, map[string]bool{"ok": true})
	case "/h/launch":
		var q struct {
			Open       bool   `json:"open"`
			ID         string `json:"id"`
			Generation *int64 `json:"generation"`
		}
		if json.Unmarshal(b, &q) != nil || (q.Open && !validLaunchIdentity(q.ID, q.Generation)) {
			w.WriteHeader(400)
			return
		}
		s.launchMu.Lock()
		defer s.launchMu.Unlock()
		s.mu.Lock()
		busy := s.launch != "" && time.Now().Before(s.launchExpiry)
		s.mu.Unlock()
		if busy {
			jsonOut(w, map[string]any{"ok": false, "error": "busy"})
			return
		}
		code, err := secret()
		if err != nil {
			w.WriteHeader(500)
			return
		}
		s.mu.Lock()
		s.launch = code
		s.launchExpiry = time.Now().Add(120 * time.Second)
		s.mu.Unlock()
		u := "http://" + s.host + "/launch/" + code
		data := []byte(`<!doctype html><meta http-equiv="refresh" content="0;url=` + u + `"><title>Opening Brain Trail</title>`)
		p := filepath.Join(s.dir, "open.html")
		if err = os.WriteFile(p, data, 0600); err != nil {
			s.mu.Lock()
			if s.launch == code {
				s.launch = ""
			}
			s.mu.Unlock()
			w.WriteHeader(500)
			return
		}
		if q.Open {
			status, err := s.openPath(p, "", q.ID, *q.Generation, code)
			if err != nil {
				s.mu.Lock()
				if s.launch == code {
					s.launch = ""
				}
				s.mu.Unlock()
				jsonOut(w, map[string]any{"ok": false, "error": "launch-failed"})
				return
			}
			jsonOut(w, map[string]any{"ok": true, "status": status})
			return
		}
		jsonOut(w, map[string]bool{"ok": true})
	case "/h/file/prepare":
		var q struct {
			Root string `json:"root"`
			Path string `json:"path"`
		}
		if json.Unmarshal(b, &q) != nil {
			w.WriteHeader(400)
			return
		}
		v, err := s.files.Prepare(q.Root, q.Path)
		if err != nil {
			fail(w, err)
			return
		}
		jsonOut(w, v)
	case "/h/file/read":
		var q struct {
			ID string `json:"id"`
		}
		json.Unmarshal(b, &q)
		v, err := s.files.Read(q.ID)
		if err != nil {
			fail(w, err)
			return
		}
		jsonOut(w, v)
	case "/h/file/verify":
		var q struct {
			ID string `json:"id"`
		}
		json.Unmarshal(b, &q)
		_, err := s.files.Verify(q.ID)
		if err != nil {
			fail(w, err)
			return
		}
		jsonOut(w, map[string]bool{"ok": true})
	case "/h/file/release":
		var q struct {
			ID string `json:"id"`
		}
		json.Unmarshal(b, &q)
		s.files.Release(q.ID)
		jsonOut(w, map[string]bool{"ok": true})
	case "/h/file/open":
		var q struct {
			ID         string `json:"id"`
			App        string `json:"app"`
			LaunchID   string `json:"launchId"`
			Generation *int64 `json:"generation"`
		}
		if json.Unmarshal(b, &q) != nil || q.ID == "" || !validLaunchIdentity(q.LaunchID, q.Generation) {
			w.WriteHeader(400)
			return
		}
		p, err := s.files.Verify(q.ID)
		if err != nil {
			fail(w, err)
			return
		}
		status, err := s.openPath(p, q.App, q.LaunchID, *q.Generation, "")
		if err != nil {
			jsonOut(w, map[string]any{"ok": false, "error": "launch-failed"})
			return
		}
		jsonOut(w, map[string]any{"ok": true, "status": status})
	default:
		w.WriteHeader(404)
	}
}
func (s *relay) browserHandler(w http.ResponseWriter, r *http.Request) {
	headers(w)
	if r.Host != s.host {
		w.WriteHeader(403)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/launch/") && r.Method == "GET" {
		code := strings.TrimPrefix(r.URL.Path, "/launch/")
		s.mu.Lock()
		ok := s.launch != "" && time.Now().Before(s.launchExpiry) && subtle.ConstantTimeCompare([]byte(code), []byte(s.launch)) == 1
		if ok {
			s.launch = ""
		}
		s.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		http.Redirect(w, r, "/s/"+s.token+"/", http.StatusSeeOther)
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/s/")
	if !ok {
		w.WriteHeader(404)
		return
	}
	segment, p, ok := strings.Cut(rest, "/")
	if !ok || subtle.ConstantTimeCompare([]byte(segment), []byte(s.token)) != 1 {
		w.WriteHeader(404)
		return
	}
	if r.Method == "POST" {
		if r.Header.Get("Origin") != "http://"+s.host {
			w.WriteHeader(403)
			return
		}
		if p != "command" {
			w.WriteHeader(404)
			return
		}
		if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			w.WriteHeader(415)
			return
		}
		rc := http.NewResponseController(w)
		_ = rc.SetReadDeadline(time.Now().Add(10 * time.Second))
		b, err := body(r, 65536)
		_ = rc.SetReadDeadline(time.Time{})
		if err != nil {
			if err.Error() == "too-large" {
				refusal(w, 413, "too-large")
			} else {
				refusal(w, 400, "invalid")
			}
			return
		}
		id, err := secret()
		if err != nil {
			w.WriteHeader(500)
			return
		}
		ch := make(chan json.RawMessage, 1)
		s.mu.Lock()
		if !s.ready {
			s.mu.Unlock()
			jsonOut(w, map[string]any{"ok": false, "error": "disconnected"})
			return
		}
		if len(s.pending) >= 16 {
			s.mu.Unlock()
			jsonOut(w, map[string]any{"ok": false, "error": "busy"})
			return
		}
		s.pending[id] = ch
		s.mu.Unlock()
		if !s.frame(map[string]any{"t": "cmd", "id": id, "body": json.RawMessage(b)}) {
			s.mu.Lock()
			delete(s.pending, id)
			s.mu.Unlock()
			jsonOut(w, map[string]any{"ok": false, "error": "busy"})
			return
		}
		defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
		select {
		case reply := <-ch:
			w.Header().Set("Content-Type", "application/json")
			w.Write(reply)
		case <-time.After(10 * time.Minute):
			jsonOut(w, map[string]any{"ok": false, "error": "timeout"})
		case <-r.Context().Done():
		}
		return
	}
	if r.Method != "GET" {
		w.WriteHeader(405)
		return
	}
	switch p {
	case "":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, page)
	case "app.js", "app.css":
		ct := "text/javascript; charset=utf-8"
		if p == "app.css" {
			ct = "text/css; charset=utf-8"
		}
		w.Header().Set("Content-Type", ct)
		http.ServeFile(w, r, filepath.Join(s.assets, p))
	case "events":
		fl, ok := w.(http.Flusher)
		if !ok {
			w.WriteHeader(500)
			return
		}
		ch := make(chan []byte, 16)
		s.mu.Lock()
		if len(s.clients) >= 16 {
			s.mu.Unlock()
			w.WriteHeader(503)
			return
		}
		s.ready = false
		s.initializing = true
		s.seq++
		s.layout = nil
		s.snapshot = nil
		s.clients[ch] = struct{}{}
		n := len(s.clients)
		sent := s.frame(map[string]any{"t": "clients", "n": n, "seq": s.seq})
		if !sent {
			delete(s.clients, ch)
		}
		s.mu.Unlock()
		if !sent {
			w.WriteHeader(503)
			return
		}
		defer func() {
			s.mu.Lock()
			if _, ok := s.clients[ch]; ok {
				delete(s.clients, ch)
			}
			s.frame(map[string]any{"t": "clients", "n": len(s.clients), "seq": s.seq})
			s.mu.Unlock()
		}()
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("X-Accel-Buffering", "no")
		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		fl.Flush()
		_ = rc.SetWriteDeadline(time.Time{})
		for {
			select {
			case b, ok := <-ch:
				if !ok {
					return
				}
				_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
					return
				}
				if err := rc.Flush(); err != nil {
					return
				}
				_ = rc.SetWriteDeadline(time.Time{})
			case <-r.Context().Done():
				return
			}
		}
	default:
		w.WriteHeader(404)
	}
}
func serve(assets string) error {
	if !filepath.IsAbs(assets) {
		return errors.New("assets must be absolute")
	}
	for _, n := range []string{"app.js", "app.css"} {
		if st, e := os.Stat(filepath.Join(assets, n)); e != nil || !st.Mode().IsRegular() {
			return errors.New("missing browser assets")
		}
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	type boot struct {
		V         int    `json:"v"`
		HostToken string `json:"hostToken"`
	}
	input := make(chan []byte, 1)
	go func() { b, _ := io.ReadAll(io.LimitReader(os.Stdin, 1025)); input <- b }()
	var b []byte
	select {
	case b = <-input:
	case <-signals:
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("bootstrap timeout")
	}
	var cfg boot
	if len(b) > 1024 || json.Unmarshal(b, &cfg) != nil || cfg.V != 1 {
		return errors.New("invalid bootstrap")
	}
	decoded, e := base64.RawURLEncoding.DecodeString(cfg.HostToken)
	if e != nil || len(decoded) != 32 {
		return errors.New("invalid token")
	}
	dir, e := privateTempDir()
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "relay.sock")
	if len([]byte(sock)) > 100 {
		return errors.New("socket path too long")
	}
	listener, e := net.Listen("unix", sock)
	if e != nil {
		return e
	}
	defer listener.Close()
	if _, e = privacyEvidence(dir, sock); e != nil {
		return e
	}
	tcp, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		return e
	}
	defer tcp.Close()
	token, e := secret()
	if e != nil {
		return e
	}
	s := &relay{hostToken: cfg.HostToken, token: token, host: tcp.Addr().String(), assets: assets, dir: dir, clients: make(map[chan []byte]struct{}), pending: make(map[string]chan json.RawMessage), out: make(chan []byte, 64), outputFailure: make(chan struct{}, 1), files: NewFileAuthority()}
	defer s.files.Close()
	done := make(chan error, 3)
	go func() {
		w := bufio.NewWriter(os.Stdout)
		for b := range s.out {
			if _, e := w.Write(b); e != nil {
				done <- e
				return
			}
			if e := w.Flush(); e != nil {
				done <- e
				return
			}
		}
	}()
	if !s.frame(map[string]any{"t": "hello", "protocol": 1, "socket": sock}) {
		return errors.New("output unavailable")
	}
	hostServer := boundedServer(http.HandlerFunc(s.hostHandler))
	browserServer := boundedServer(http.HandlerFunc(s.browserHandler))
	defer hostServer.Close()
	defer browserServer.Close()
	go func() { done <- hostServer.Serve(&limitedListener{Listener: listener, slots: make(chan struct{}, 64)}) }()
	go func() { done <- browserServer.Serve(&limitedListener{Listener: tcp, slots: make(chan struct{}, 64)}) }()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-signals:
			return nil
		case e := <-done:
			return e
		case <-s.outputFailure:
			return errors.New("launch exit frame not queued")
		case <-ticker.C:
			if !s.frame(map[string]any{"t": "ping"}) {
				return errors.New("output busy")
			}
		}
	}
}
func main() {
	var e error
	if len(os.Args) == 3 && os.Args[1] == "serve" {
		e = serve(os.Args[2])
	} else {
		e = errors.New("usage: brain-trail-relay serve ASSETS")
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
