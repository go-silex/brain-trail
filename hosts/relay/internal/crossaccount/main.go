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

func hosted() bool {
	return os.Getenv("GITHUB_ACTIONS") == "true" && os.Getenv("RUNNER_ENVIRONMENT") == "github-hosted" && os.Getenv("RUNNER_TEMP") != ""
}

func main() {
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
		fmt.Fprintln(os.Stderr, "cross-account proof:", err)
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
		return err
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
		return err
	}
	defer func() {
		if err := os.RemoveAll(stage); err != nil && result == nil {
			result = fmt.Errorf("remove fixture stage: %w", err)
		}
	}()
	if err = prepareStage(stage); err != nil {
		return err
	}
	file := filepath.Join(stage, "control")
	if err = os.WriteFile(file, []byte(nonce), 0644); err != nil {
		return err
	}
	control := filepath.Join(stage, "s")
	listener, err := net.Listen("unix", control)
	if err != nil {
		return fmt.Errorf("control socket: %w", err)
	}
	defer listener.Close()
	if err = prepareSocket(control); err != nil {
		return err
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
		return err
	}
	if err = <-served; err != nil {
		return fmt.Errorf("control connection: %w", err)
	}
	return nil
}

func probe(r request) error {
	if err := verifyIdentity(r); err != nil {
		return err
	}
	b, err := os.ReadFile(r.ControlFile)
	if err != nil || string(b) != r.Nonce {
		return errors.New("control file inaccessible or incorrect")
	}
	c, err := net.DialTimeout("unix", r.ControlSocket, 3*time.Second)
	if err != nil {
		return fmt.Errorf("control socket inaccessible: %w", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	b, err = io.ReadAll(io.LimitReader(c, 100))
	_ = c.Close()
	if err != nil || string(b) != r.Nonce {
		return errors.New("control socket nonce mismatch")
	}
	_, err = os.ReadDir(r.Directory)
	if !isPermission(err) {
		return fmt.Errorf("directory denial was not permission-related: %v", err)
	}
	c, err = net.DialTimeout("unix", r.Socket, 3*time.Second)
	if err == nil {
		c.Close()
		return errors.New("private socket accepted other account")
	}
	if !isPermission(err) {
		return fmt.Errorf("socket denial was not permission-related: %w", err)
	}
	return nil
}
