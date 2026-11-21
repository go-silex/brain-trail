package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"path"
	"path/filepath"
	"regexp"
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
	SessionID string `json:"session_id"`
	CWD       string `json:"cwd"`
	Event     string `json:"hook_event_name"`
	AgentID   string `json:"agent_id"`
	ToolName  string `json:"tool_name"`
	ToolUseID string `json:"tool_use_id"`
	Input     struct {
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
		Path         string `json:"path"`
	} `json:"tool_input"`
	Response struct {
		IsError      bool     `json:"is_error"`
		IsErrorCamel bool     `json:"isError"`
		Filenames    []string `json:"filenames"`
	} `json:"-"`
	RawResponse json.RawMessage `json:"tool_response"`
	MCPServer   struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	} `json:"mcp_server"`
}

func coworkTask(cwd string) string {
	parts := strings.Split(path.Clean(strings.ReplaceAll(cwd, `\`, "/")), "/")
	found := false
	for _, part := range parts {
		if found && strings.HasPrefix(part, "local_") && len(part) > len("local_") {
			return part
		}
		if part == "local-agent-mode-sessions" {
			found = true
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
		if len(p.RawResponse) > 0 {
			_ = json.Unmarshal(p.RawResponse, &p.Response)
		}
		if p.Response.IsError || p.Response.IsErrorCamel {
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
			kind := ""
			switch p.ToolName {
			case "Read", "NotebookRead":
				kind = "read"
			case "Write", "Edit", "MultiEdit", "NotebookEdit":
				kind = "write"
			}
			if kind != "" {
				f := p.Input.FilePath
				if f == "" {
					f = p.Input.NotebookPath
				}
				if len(f) <= 4096 && coworkAbsolute(f) {
					r.Files = []coworkFile{{P: filepath.Clean(f), K: kind}}
				}
			}
			if p.ToolName == "Glob" || p.ToolName == "Grep" {
				base := p.Input.Path
				if !coworkAbsolute(base) {
					base = p.CWD
				}
				seen := map[string]bool{}
				for _, f := range p.Response.Filenames {
					if f == "" {
						continue
					}
					if !coworkAbsolute(f) {
						if !coworkAbsolute(base) {
							continue
						}
						f = filepath.Join(base, f)
					}
					f = filepath.Clean(f)
					if len(f) > 4096 || seen[f] {
						continue
					}
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
	data, err := io.ReadAll(io.LimitReader(in, coworkInputLimit+1))
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
	for err == nil && len(encoded) > 8192 && len(r.Seen) > 0 {
		r.Seen = r.Seen[:len(r.Seen)-1]
		encoded, err = json.Marshal(r)
	}
	if err != nil || len(encoded) > 8192 {
		return
	}
	_ = writeCoworkReceipt(root, p.SessionID, coworkTask(p.CWD), key, encoded, r.Ev, now)
}
