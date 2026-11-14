// Command crossaccount is a hosted-runner-only production relay isolation proof.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type request struct {
	Directory     string `json:"directory"`
	Socket        string `json:"socket"`
	ControlFile   string `json:"controlFile"`
	ControlSocket string `json:"controlSocket"`
	Nonce         string `json:"nonce"`
	Owner         string `json:"owner,omitempty"`
}

type report struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}
type phaseError struct {
	phase string
	err   error
}

func (e *phaseError) Error() string { return e.phase }
func (e *phaseError) Unwrap() error { return e.err }
func phase(name string, err error) error {
	if err == nil {
		return nil
	}
	return &phaseError{phase: name, err: err}
}

// Diagnostics contain only fixed phase labels and numeric OS errors, not paths or nonces.
func diagnostic(err error) string {
	var names []string
	for {
		p, ok := err.(*phaseError)
		if !ok {
			break
		}
		names = append(names, p.phase)
		err = p.err
	}
	var remote *remoteDiagnostic
	if errors.As(err, &remote) {
		names = append(names, remote.value)
		return strings.Join(names, "-")
	}
	var errno syscall.Errno
	var netErr net.Error
	var serviceCode serviceExitCode
	switch {
	case errors.As(err, &serviceCode) && (serviceCode == 1001 || serviceCode == 1002 || serviceCode == 1003):
		names = append(names, fmt.Sprintf("service-%d", serviceCode))
	case errors.As(err, &errno):
		names = append(names, fmt.Sprintf("os-%d", uint32(errno)))
	case errors.Is(err, os.ErrDeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()):
		names = append(names, "timeout")
	case errors.Is(err, os.ErrPermission):
		names = append(names, "permission")
	case errors.Is(err, os.ErrNotExist):
		names = append(names, "not-found")
	default:
		names = append(names, "other")
	}
	if len(names) == 1 {
		return "unknown/" + names[0]
	}
	return strings.Join(names[:len(names)-1], "-") + "/" + names[len(names)-1]
}

type serviceExitCode uint32

func (serviceExitCode) Error() string { return "service report failure" }

type remoteDiagnostic struct{ value string }

func (e *remoteDiagnostic) Error() string { return "service probe failed" }
func safeRemote(s string) bool {
	if len(s) == 0 || len(s) > 256 || strings.Count(s, "/") != 1 || strings.HasPrefix(s, "/") || strings.HasSuffix(s, "/") {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '/') {
			return false
		}
	}
	return true
}

func hosted() bool {
	return os.Getenv("GITHUB_ACTIONS") == "true" && os.Getenv("RUNNER_ENVIRONMENT") == "github-hosted" && os.Getenv("RUNNER_TEMP") != ""
}

func main() {
	if processEntry() {
		return
	}
	if hosted() && len(os.Args) == 4 && os.Args[1] == "--owner" {
		if !filepath.IsAbs(os.Args[2]) || filepath.Clean(filepath.Dir(os.Args[3])) != filepath.Clean(os.Args[2]) || filepath.Base(os.Args[3]) != "relay.sock" {
			os.Exit(1)
		}
		if _, err := os.ReadDir(os.Args[2]); err != nil {
			os.Exit(1)
		}
		c, err := net.DialTimeout("unix", os.Args[3], 3*time.Second)
		if err != nil {
			os.Exit(1)
		}
		_ = c.Close()
		return
	}
	if hosted() && len(os.Args) == 4 && os.Args[1] == "--closed" {
		if !filepath.IsAbs(os.Args[2]) || filepath.Clean(filepath.Dir(os.Args[3])) != filepath.Clean(os.Args[2]) || filepath.Base(os.Args[3]) != "relay.sock" {
			os.Exit(1)
		}
		c, err := net.DialTimeout("unix", os.Args[3], 3*time.Second)
		if err == nil {
			_ = c.Close()
			os.Exit(1)
		}
		if !isClosed(err) {
			os.Exit(1)
		}
		return
	}
	if serviceEntry() {
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "--child" {
		if !hosted() {
			os.Exit(1)
		}
		var r request
		if json.Unmarshal([]byte(os.Args[2]), &r) != nil {
			os.Exit(1)
		}
		err := probe(r)
		out := report{OK: err == nil}
		if err != nil {
			out.Error = err.Error()
		}
		_ = json.NewEncoder(os.Stdout).Encode(out)
		if err != nil {
			os.Exit(1)
		}
		return
	}
	if !hosted() || len(os.Args) != 4 || os.Args[1] != "--hosted" {
		fmt.Fprintln(os.Stderr, "cross-account proof requires an explicit GitHub-hosted invocation")
		os.Exit(1)
	}
	if err := run(os.Args[2], os.Args[3]); err != nil {
		detail := diagnostic(err)
		name, class, ok := strings.Cut(detail, "/")
		if !ok {
			name, class = "unknown", "other"
		}
		fmt.Fprintf(os.Stderr, "cross-account-phase=%s error-class=%s\n", name, class)
		os.Exit(1)
	}
}

func run(dir, socket string) (result error) {
	if !filepath.IsAbs(dir) || !filepath.IsAbs(socket) || filepath.Clean(filepath.Dir(socket)) != filepath.Clean(dir) || filepath.Base(socket) != "relay.sock" {
		return errors.New("invalid relay fixture paths")
	}
	parent := filepath.Dir(dir)
	root := filepath.Dir(parent)
	if err := managerGuard(); err != nil {
		return phase("manager-guard", err)
	}
	if !strings.HasPrefix(filepath.Base(root), "btr-proof-") || (filepath.Base(parent) != "tmp" && filepath.Base(parent) != "local") {
		return errors.New("relay is outside the expected disposable fixture")
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return err
	}
	nonce := hex.EncodeToString(b[:])
	stage, err := os.MkdirTemp(parent, "c-")
	if err != nil {
		return phase("stage-create", err)
	}
	defer func() {
		if err := os.RemoveAll(stage); err != nil && result == nil {
			resource := "other"
			var pathErr *os.PathError
			if errors.As(err, &pathErr) {
				switch filepath.Clean(pathErr.Path) {
				case filepath.Clean(stage):
					resource = "directory"
				case filepath.Join(stage, "probe.exe"):
					resource = "executable"
				case filepath.Join(stage, "probe"):
					resource = "executable"
				case filepath.Join(stage, "control"):
					resource = "control-file"
				case filepath.Join(stage, "s"):
					resource = "control-socket"
				case filepath.Join(stage, "report.json"):
					resource = "report"
				case filepath.Join(stage, "report.json.tmp"):
					resource = "report-temp"
				}
			}
			result = phase("stage-remove-"+resource, err)
		}
	}()
	if err = prepareStage(stage); err != nil {
		return phase("stage-permissions", err)
	}
	file := filepath.Join(stage, "control")
	if err = os.WriteFile(file, []byte(nonce), 0644); err != nil {
		return phase("control-file-create", err)
	}
	control := filepath.Join(stage, "s")
	listener, err := net.Listen("unix", control)
	if err != nil {
		return phase("control-socket-listen", err)
	}
	defer listener.Close()
	if err = prepareSocket(control); err != nil {
		return phase("control-socket-permissions", err)
	}
	served := make(chan error, 1)
	go func() {
		_ = listener.(*net.UnixListener).SetDeadline(time.Now().Add(20 * time.Second))
		c, e := listener.Accept()
		if e != nil {
			served <- e
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		_, e = io.WriteString(c, nonce)
		served <- e
	}()
	r := request{Directory: dir, Socket: socket, ControlFile: file, ControlSocket: control, Nonce: nonce}
	if err = execute(stage, r); err != nil {
		return phase("execute", err)
	}
	if err = <-served; err != nil {
		return phase("control-socket-accept", err)
	}
	return nil
}

func probe(r request) error {
	if err := verifyIdentity(r); err != nil {
		return phase("identity", err)
	}
	b, err := os.ReadFile(r.ControlFile)
	if err != nil {
		return phase("control-file-read", err)
	}
	if string(b) != r.Nonce {
		return phase("control-file-nonce", errors.New("mismatch"))
	}
	c, err := net.DialTimeout("unix", r.ControlSocket, 3*time.Second)
	if err != nil {
		return phase("control-socket-dial", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	b, err = io.ReadAll(io.LimitReader(c, 100))
	_ = c.Close()
	if err != nil {
		return phase("control-socket-read", err)
	}
	if string(b) != r.Nonce {
		return phase("control-socket-nonce", errors.New("mismatch"))
	}
	_, err = os.ReadDir(r.Directory)
	if err == nil {
		return phase("private-directory-accepted", errors.New("unexpected success"))
	}
	if !isPermission(err) {
		return phase("private-directory", err)
	}
	c, err = net.DialTimeout("unix", r.Socket, 3*time.Second)
	if err == nil {
		c.Close()
		return phase("private-socket-accepted", errors.New("unexpected success"))
	}
	if !isPermission(err) {
		return phase("private-socket", err)
	}
	return nil
}
