package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

const mcpRelayReplyLimit = 2 * 1024 * 1024
const mcpRelayTimeout = 15 * time.Second

type mcpRelayClient struct {
	address RelayAddress
	http    *http.Client
}

type mcpRelayResult[T any] struct {
	Value   T
	Refusal string
}

func mcpRelayTokenValid(token Token) bool {
	s := string(token)
	if len(s) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == s
}

// Only the relay's private, canonical AF_UNIX endpoint is eligible for IPC.
func mcpRelaySocketValid(socket string) error {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket || filepath.Base(socket) != "relay.sock" {
		return errors.New("invalid relay socket")
	}
	dir := filepath.Dir(socket)
	if !strings.HasPrefix(filepath.Base(dir), "btr-") || len(filepath.Base(dir)) <= len("btr-") {
		return errors.New("invalid relay directory")
	}
	canonical, err := filepath.EvalSymlinks(socket)
	if err != nil {
		return fmt.Errorf("resolve relay socket: %w", err)
	}
	if canonical != socket {
		return errors.New("noncanonical relay socket")
	}
	_, err = privacyEvidence(dir, socket)
	return err
}

func newMCPRelayClient(address RelayAddress) (*mcpRelayClient, error) {
	if !mcpRelayTokenValid(address.RelayID) {
		return nil, errors.New("invalid relay identifier")
	}
	if err := mcpRelaySocketValid(address.Socket); err != nil {
		return nil, err
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 16 * 1024,
		ResponseHeaderTimeout:  mcpRelayTimeout,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			if err := mcpRelaySocketValid(address.Socket); err != nil {
				return nil, err
			}
			return (&net.Dialer{Timeout: mcpRelayTimeout}).DialContext(ctx, "unix", address.Socket)
		},
	}
	return &mcpRelayClient{address: address, http: &http.Client{
		Transport:     transport,
		Timeout:       mcpRelayTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (c *mcpRelayClient) close() { c.http.CloseIdleConnections() }

// Refusals are protocol results; malformed replies and transport failures are errors.
// The caller validates the operation-specific contents of successful values.
func mcpRelayCall[T any](ctx context.Context, client *mcpRelayClient, path string, bearer Token, request any) (mcpRelayResult[T], error) {
	var result mcpRelayResult[T]
	switch path {
	case "/a/claim", "/a/lease", "/a/pull", "/a/pull-next", "/a/command", "/a/release":
	default:
		return result, errors.New("invalid relay operation")
	}
	if bearer != "" && !mcpRelayTokenValid(bearer) {
		return result, errors.New("invalid grant credential")
	}
	if path == "/a/claim" && bearer != "" {
		return result, errors.New("claim must not use a bearer")
	}
	if path != "/a/claim" && path != "/a/release" && bearer == "" {
		return result, errors.New("missing grant credential")
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return result, err
	}
	if len(payload) > hostLimit {
		return result, errors.New("relay request too large")
	}
	ctx, cancel := context.WithTimeout(ctx, mcpRelayTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://relay"+path, bytes.NewReader(payload))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+string(bearer))
	}
	resp, err := client.http.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, mcpRelayReplyLimit+1))
	if err != nil {
		return result, err
	}
	if len(body) > mcpRelayReplyLimit {
		return result, errors.New("relay reply too large")
	}
	var branch struct {
		OK *bool `json:"ok"`
	}
	if err := json.Unmarshal(body, &branch); err != nil || branch.OK == nil {
		return result, errors.New("invalid relay reply")
	}
	if *branch.OK {
		var reply WireSuccess[T]
		if err := decodeAppJSON(body, &reply); err != nil || reply.V != 1 || !reply.OK || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return result, errors.New("invalid relay success")
		}
		result.Value = reply.Value
		return result, nil
	}
	var reply WireFailure
	if err := decodeAppJSON(body, &reply); err != nil || reply.V != 1 || reply.OK {
		return result, errors.New("invalid relay refusal")
	}
	switch reply.Error {
	case "stale-generation", "invalid", "forbidden", "unsupported", "launch-failed", "busy", "timeout", "too-large", "disconnected":
		result.Refusal = reply.Error
		return result, nil
	default:
		return result, fmt.Errorf("invalid relay refusal")
	}
}
