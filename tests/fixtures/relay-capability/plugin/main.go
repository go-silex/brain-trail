// Disposable capability evidence only; not a production bridge.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unicode/utf16"
)

type acknowledgement struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Value  string `json:"value"`
}

// Escape non-ASCII as JSON Unicode escapes, including surrogate pairs.
func asciiJSON(s string) string {
	b, _ := json.Marshal(s)
	out := ""
	for _, r := range string(b) {
		if r < 128 {
			out += string(r)
		} else if r <= 0xffff {
			out += fmt.Sprintf("\\u%04x", r)
		} else {
			a, b := utf16.EncodeRune(r)
			out += fmt.Sprintf("\\u%04x\\u%04x", a, b)
		}
	}
	return out
}
func frame(fields map[string]string) error {
	body := "{"
	first := true
	for k, v := range fields {
		if !first {
			body += ","
		}
		first = false
		body += asciiJSON(k) + ":" + asciiJSON(v)
	}
	body += "}"
	if len(body) > 4096 {
		return fmt.Errorf("frame too long")
	}
	wire := fmt.Sprintf("%04d:%s", len(body), body)
	if _, err := io.WriteString(os.Stdout, wire[:2]); err != nil {
		return err
	}
	time.Sleep(25 * time.Millisecond)
	_, err := io.WriteString(os.Stdout, wire[2:])
	return err
}

func main() {
	dir, err := privateTempDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "c")
	if len(socket) > 100 {
		fmt.Fprintf(os.Stderr, "socket path exceeds 100 bytes (%d): %s\n", len(socket), socket)
		return
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	defer listener.Close()
	var mu sync.Mutex
	count := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/ack", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" {
			http.Error(w, "method", 405)
			return
		}
		var a acknowledgement
		if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 2048)).Decode(&a); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if count == 0 && a.ID == "valid" && a.Status == "saved" && a.Value == "é😀" {
			count++
			_, _ = io.WriteString(w, "ok")
			go func() {
				time.Sleep(25 * time.Millisecond)
				if err := frame(map[string]string{"type": "command", "id": "stale", "generation": "old-generation", "value": "replaced"}); err != nil {
					fmt.Fprintln(os.Stderr, err)
				}
			}()
		} else if count == 1 && a.ID == "stale" && a.Status == "refused-generation" && a.Value == "é😀" {
			count++
			_, _ = io.WriteString(w, "ok")
		} else {
			http.Error(w, "unexpected acknowledgement", 400)
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	if err := frame(map[string]string{"type": "hello", "socketPath": socket, "pid": strconv.Itoa(os.Getpid())}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	time.Sleep(100 * time.Millisecond)
	if err := frame(map[string]string{"type": "command", "id": "valid", "generation": "probe-generation-1", "value": "é😀"}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	time.Sleep(120 * time.Second)
	_ = server.Close()
}
