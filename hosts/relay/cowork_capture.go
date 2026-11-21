package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const coworkInputLimit = 4 << 20

var coworkID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type coworkFile struct {
	P string `json:"p"`
	K string `json:"k"`
}
type coworkMCP struct {
	Server string `json:"server"`
	Tool   string `json:"tool"`
	Source string `json:"source,omitempty"`
}
type coworkReceipt struct {
	V     int          `json:"v"`
	At    int64        `json:"at"`
	Ev    string       `json:"ev"`
	Tool  string       `json:"tool,omitempty"`
	Ok    bool         `json:"ok"`
	Agent bool         `json:"agent"`
	Files []coworkFile `json:"files,omitempty"`
	Seen  []string     `json:"seen,omitempty"`
	MCP   *coworkMCP   `json:"mcp,omitempty"`
}
type coworkPayload struct {
	SessionID   string          `json:"session_id"`
	CWD         string          `json:"cwd"`
	Event       string          `json:"hook_event_name"`
	AgentID     string          `json:"agent_id"`
	ToolName    string          `json:"tool_name"`
	ToolUseID   string          `json:"tool_use_id"`
	RawInput    json.RawMessage `json:"tool_input"`
	RawResponse json.RawMessage `json:"tool_response"`
	MCPServer   struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	} `json:"mcp_server"`
}

func coworkTaskAt(cwd, root string, insensitive bool) string {
	if !filepath.IsAbs(cwd) || !filepath.IsAbs(root) {
		return ""
	}
	cwd, root = filepath.Clean(cwd), filepath.Clean(root)
	match := func(a, b string) bool {
		if insensitive {
			return strings.EqualFold(a, b)
		}
		return a == b
	}
	cwdParts := strings.Split(cwd, string(filepath.Separator))
	rootParts := strings.Split(root, string(filepath.Separator))
	if len(cwdParts) < len(rootParts) {
		return ""
	}
	for i, part := range rootParts {
		if !match(part, cwdParts[i]) {
			return ""
		}
	}
	parts := cwdParts[len(rootParts):]
	if len(parts) < 4 || !match(parts[0], "local-agent-mode-sessions") || parts[1] == "" || parts[2] == "" {
		return ""
	}
	i := 3
	if match(parts[i], "agent") {
		i++
	}
	if i >= len(parts) || len(parts[i]) <= len("local_") || !match(parts[i][:len("local_")], "local_") {
		return ""
	}
	return parts[i]
}

func coworkTask(cwd string) string {
	config, err := os.UserConfigDir()
	if err == nil {
		if task := coworkTaskAt(cwd, filepath.Join(config, "Claude"), runtime.GOOS == "windows" || runtime.GOOS == "darwin"); task != "" {
			return task
		}
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		packages := filepath.Join(base, "Packages")
		rel, err := filepath.Rel(packages, cwd)
		if err == nil {
			parts := strings.Split(rel, string(filepath.Separator))
			if len(parts) >= 5 && parts[0] != "" && parts[0] != ".." && strings.EqualFold(parts[1], "LocalCache") && strings.EqualFold(parts[2], "Roaming") && strings.EqualFold(parts[3], "Claude") {
				return coworkTaskAt(cwd, filepath.Join(packages, parts[0], "LocalCache", "Roaming", "Claude"), true)
			}
		}
	}
	return ""
}
func isLocalCowork(cwd string) bool { return coworkTask(cwd) != "" }
func coworkPrintable(s string) bool {
	if len(s) > 128 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}
func coworkAbsolute(s string) bool { return filepath.IsAbs(s) }
func coworkPathText(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return utf8.ValidString(s)
}

func coworkJSONStringSize(s string) int {
	n := 2
	for len(s) > 0 {
		r, size := utf8.DecodeRuneInString(s)
		switch {
		case r == utf8.RuneError && size == 1:
			n += 6
		case r == '"' || r == '\\':
			n += 2
		case r < 0x20 || r == '<' || r == '>' || r == '&' || r == '\u2028' || r == '\u2029':
			n += 6
		default:
			n += size
		}
		s = s[size:]
	}
	return n
}

func coworkStringField(m map[string]json.RawMessage, field string) string {
	var s string
	_ = json.Unmarshal(m[field], &s)
	return s
}
func projectCowork(p coworkPayload, at int64) (coworkReceipt, string, bool) {
	r := coworkReceipt{V: 1, At: at, Agent: p.AgentID != ""}
	var key string
	switch p.Event {
	case "SessionStart":
		r.Ev = "start"
		r.Ok = true
		key = "start:" + strconvInt(at)
	case "SessionEnd":
		r.Ev = "end"
		r.Ok = true
		key = "end:" + strconvInt(at)
	case "PostToolUse", "PostToolUseFailure":
		if p.ToolName == "" || !coworkPrintable(p.ToolName) || p.ToolUseID == "" {
			return r, "", false
		}
		r.Ev = "tool"
		r.Tool = p.ToolName
		r.Ok = p.Event == "PostToolUse"
		var response map[string]json.RawMessage
		_ = json.Unmarshal(p.RawResponse, &response)
		var isError, isErrorCamel bool
		_ = json.Unmarshal(response["is_error"], &isError)
		_ = json.Unmarshal(response["isError"], &isErrorCamel)
		if isError || isErrorCamel {
			r.Ok = false
		}
		key = "tool:" + p.ToolUseID
		if strings.HasPrefix(p.ToolName, "mcp__") {
			parts := strings.SplitN(strings.TrimPrefix(p.ToolName, "mcp__"), "__", 2)
			if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
				return r, "", false
			}
			server, tool := parts[0], parts[1]
			if p.MCPServer.Name != "" {
				server = p.MCPServer.Name
				// A server name may itself contain "__"; keep the whole suffix after it as the tool.
				if rest, ok := strings.CutPrefix(p.ToolName, "mcp__"+server+"__"); ok && rest != "" {
					tool = rest
				}
			}
			if !coworkPrintable(server) || !coworkPrintable(tool) || !coworkPrintable(p.MCPServer.Source) {
				return r, "", false
			}
			r.MCP = &coworkMCP{Server: server, Tool: tool, Source: p.MCPServer.Source}
		}
		if r.Ok {
			budget := 8192 - 256 - coworkJSONStringSize(r.Tool)
			if r.MCP != nil {
				budget -= coworkJSONStringSize(r.MCP.Server) + coworkJSONStringSize(r.MCP.Tool) + coworkJSONStringSize(r.MCP.Source)
			}
			var input map[string]json.RawMessage
			switch p.ToolName {
			case "Read", "NotebookRead", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep":
				_ = json.Unmarshal(p.RawInput, &input)
			}
			kind := ""
			switch p.ToolName {
			case "Read", "NotebookRead":
				kind = "read"
			case "Write", "Edit", "MultiEdit", "NotebookEdit":
				kind = "write"
			}
			if kind != "" {
				f := coworkStringField(input, "file_path")
				if f == "" {
					f = coworkStringField(input, "notebook_path")
				}
				if len(f) <= 4096 && coworkAbsolute(f) && coworkPathText(f) {
					f = filepath.Clean(f)
					if coworkJSONStringSize(f)+32 <= budget {
						r.Files = []coworkFile{{P: f, K: kind}}
					}
				}
			}
			if p.ToolName == "Glob" || p.ToolName == "Grep" {
				base := coworkStringField(input, "path")
				if !coworkAbsolute(base) {
					base = p.CWD
				}
				baseAbsolute := coworkAbsolute(base)
				seen := map[string]bool{}
				var filenames []json.RawMessage
				_ = json.Unmarshal(response["filenames"], &filenames)
				for _, raw := range filenames {
					var f string
					if json.Unmarshal(raw, &f) != nil || f == "" || !coworkPathText(f) {
						continue
					}
					if !coworkAbsolute(f) {
						if !baseAbsolute || len(base)+len(f)+1 > 4096 {
							continue
						}
						f = filepath.Join(base, f)
					}
					f = filepath.Clean(f)
					if len(f) > 4096 || seen[f] || !coworkPathText(f) {
						continue
					}
					size := coworkJSONStringSize(f) + 1
					if size > budget {
						continue
					}
					budget -= size
					seen[f] = true
					r.Seen = append(r.Seen, f)
					if len(r.Seen) == 200 {
						break
					}
				}
			}
		}
	default:
		return r, "", false
	}
	sum := sha256.Sum256([]byte(key))
	return r, hex.EncodeToString(sum[:16]), true
}
func captureCowork(in io.Reader, root string, now time.Time) {
	captureCoworkWithRoot(in, func() (string, error) { return root, nil }, now)
}

func captureCoworkWithRoot(in io.Reader, resolveRoot func() (string, error), now time.Time) {
	type readResult struct {
		data []byte
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(in, coworkInputLimit+1))
		result <- readResult{data, err}
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var data []byte
	var err error
	select {
	case got := <-result:
		data, err = got.data, got.err
	case <-timer.C:
		return
	}
	if err != nil || len(data) > coworkInputLimit {
		return
	}
	var p coworkPayload
	if json.Unmarshal(data, &p) != nil || !isLocalCowork(p.CWD) || !coworkID.MatchString(p.SessionID) {
		return
	}
	r, key, ok := projectCowork(p, now.UnixMilli())
	if !ok {
		return
	}
	encoded, err := json.Marshal(r)
	// Paths were admitted against the encoded byte budget above.
	if err != nil || len(encoded) > 8192 {
		return
	}
	root, err := resolveRoot()
	if err != nil {
		return
	}
	_ = writeCoworkReceipt(root, p.SessionID, coworkTask(p.CWD), key, encoded, r.Ev, now)
}
