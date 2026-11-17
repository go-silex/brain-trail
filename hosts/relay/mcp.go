package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpResourceMIME = "text/html;profile=mcp-app"

var mcpHex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func readMCPAsset(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("invalid app asset")
	}
	return data, nil
}

// loadMCPAssets reads a single immutable resource and refuses mismatched builds.
func loadMCPAssets(assets string) (Manifest, string, error) {
	var manifest Manifest
	if !filepath.IsAbs(assets) {
		return manifest, "", errors.New("invalid assets")
	}
	data, err := readMCPAsset(filepath.Join(assets, "mcp-app-manifest.json"), 4096)
	if err != nil || len(data) > 4096 || decodeAppJSON(data, &manifest) != nil || manifest.V != 1 || manifest.WireRevision != 1 || !mcpHex.MatchString(string(manifest.UIBuildID)) || !mcpHex.MatchString(string(manifest.AssetDigest)) {
		return Manifest{}, "", errors.New("invalid app manifest")
	}
	html, err := readMCPAsset(filepath.Join(assets, "mcp-app.html"), 16*1024*1024)
	if err != nil || len(html) == 0 || len(html) > 16*1024*1024 || !bytes.Contains(html, []byte(manifest.UIBuildID)) {
		return Manifest{}, "", errors.New("invalid app resource")
	}
	digest := sha256.Sum256(html)
	if hex.EncodeToString(digest[:]) != string(manifest.AssetDigest) {
		return Manifest{}, "", errors.New("invalid app digest")
	}
	return manifest, string(html), nil
}

func mcpPrivateResult(value any, refusal string) *mcp.CallToolResult {
	var reply any = WireSuccess[any]{V1: V1{V: 1}, Success: Success[any]{OK: true, Value: value}}
	if refusal != "" {
		reply = WireFailure{V1: V1{V: 1}, Failure: Failure{OK: false, Error: refusal}}
	}
	return &mcp.CallToolResult{Meta: mcp.Meta{"brainTrail": reply}, Content: []mcp.Content{&mcp.TextContent{Text: "Brain Trail request processed."}}, IsError: refusal != ""}
}

func mcpPublicResult(value any, refusal string) *mcp.CallToolResult {
	var reply any = WireSuccess[any]{V1: V1{V: 1}, Success: Success[any]{OK: true, Value: value}}
	text := "attached"
	if refusal != "" {
		reply = WireFailure{V1: V1{V: 1}, Failure: Failure{OK: false, Error: refusal}}
		text = "refused"
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, StructuredContent: reply, IsError: refusal != ""}
}

func mcpDecode[T any](raw json.RawMessage) (T, bool) {
	var value T
	err := decodeAppJSON(raw, &value)
	return value, err == nil
}

func mcpInputSchema(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) != 0 {
		schema["required"] = required
	}
	return schema
}

func serveMCP(assets string) error {
	manifest, html, err := loadMCPAssets(assets)
	if err != nil {
		return err
	}
	views, err := newMCPViews(manifest)
	if err != nil {
		return errors.New("unable to initialize app")
	}
	defer views.close()
	uri := "ui://brain-trail/dashboard/" + string(manifest.AssetDigest) + ".html"
	server := mcp.NewServer(&mcp.Implementation{Name: "brain-trail", Version: "1"}, nil)
	server.AddResource(&mcp.Resource{Name: "Brain Trail", URI: uri, MIMEType: mcpResourceMIME}, func(_ context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		if request.Params.URI != uri {
			return nil, errors.New("resource unavailable")
		}
		csp := map[string]any{"connectDomains": []string{}, "resourceDomains": []string{}, "frameDomains": []string{}}
		content := &mcp.ResourceContents{URI: uri, MIMEType: mcpResourceMIME, Text: html, Meta: mcp.Meta{"ui": map[string]any{"csp": csp}}}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{content}}, nil
	})
	str := map[string]any{"type": "string"}
	integer := map[string]any{"type": "integer"}
	obj := map[string]any{"type": "object"}
	auth := map[string]any{"v": integer, "serverEpoch": str, "viewKey": str, "mountKey": str}
	with := func(extra map[string]any) map[string]any {
		m := make(map[string]any)
		for k, v := range auth {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	type spec struct {
		name   string
		schema map[string]any
		public bool
	}
	specs := []spec{
		{"open_brain_trail", mcpInputSchema(map[string]any{}), true},
		{"brain_trail_complete_native_open", mcpInputSchema(map[string]any{"v": integer, "openId": str, "relay": mcpInputSchema(map[string]any{"socket": str, "relayId": str}, "socket", "relayId")}, "v", "openId", "relay"), true},
		{"brain_trail_mount", mcpInputSchema(map[string]any{"v": integer, "wireRevision": integer, "uiBuildId": str, "assetDigest": str, "serverEpoch": str, "viewKey": str}, "v", "wireRevision", "uiBuildId", "assetDigest", "serverEpoch", "viewKey"), false},
		{"brain_trail_pull", mcpInputSchema(with(map[string]any{"cursor": map[string]any{}}), "v", "serverEpoch", "viewKey", "mountKey", "cursor"), false},
		{"brain_trail_command", mcpInputSchema(with(map[string]any{"request": obj}), "v", "serverEpoch", "viewKey", "mountKey", "request"), false},
		{"brain_trail_pair", mcpInputSchema(with(map[string]any{"envelope": obj}), "v", "serverEpoch", "viewKey", "mountKey", "envelope"), false},
		{"brain_trail_detach", mcpInputSchema(with(nil), "v", "serverEpoch", "viewKey", "mountKey"), false},
		{"brain_trail_unmount", mcpInputSchema(with(nil), "v", "serverEpoch", "viewKey", "mountKey"), false},
		{"brain_trail_reset", mcpInputSchema(map[string]any{"v": integer, "wireRevision": integer, "uiBuildId": str}, "v", "wireRevision", "uiBuildId"), false},
	}
	for _, s := range specs {
		meta := mcp.Meta{}
		if s.name == "open_brain_trail" {
			meta["ui"] = map[string]any{"resourceUri": uri}
		} else if !s.public {
			meta["ui"] = map[string]any{"visibility": []string{"app"}}
		}
		name := s.name
		server.AddTool(&mcp.Tool{Name: name, InputSchema: s.schema, Meta: meta}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			raw := req.Params.Arguments
			if len(raw) == 0 {
				raw = json.RawMessage(`{}`)
			}
			var value any
			refusal := "invalid"
			switch name {
			case "open_brain_trail":
				var empty struct{}
				if decodeAppJSON(raw, &empty) == nil {
					marker, bootstrap, failure := views.open()
					if failure == "" {
						return &mcp.CallToolResult{Meta: mcp.Meta{"brainTrail": bootstrap}, Content: []mcp.Content{&mcp.TextContent{Text: marker}}}, nil
					}
					refusal = failure
				}
			case "brain_trail_complete_native_open":
				if a, ok := mcpDecode[CompleteOpen](raw); ok {
					value, refusal = views.complete(ctx, a)
				}
				return mcpPublicResult(value, refusal), nil
			case "brain_trail_mount":
				if a, ok := mcpDecode[AppMount](raw); ok {
					value, refusal = views.mount(ctx, a)
				}
			case "brain_trail_pull":
				if a, ok := mcpDecode[AppPull](raw); ok {
					value, refusal = views.pull(ctx, a)
				}
			case "brain_trail_command":
				if a, ok := mcpDecode[AppCommandRequest](raw); ok {
					value, refusal = views.command(ctx, a)
				}
			case "brain_trail_pair":
				if a, ok := mcpDecode[AppPair](raw); ok {
					value, refusal = views.pair(ctx, a)
				}
			case "brain_trail_detach":
				if a, ok := mcpDecode[AppDetach](raw); ok {
					value, refusal = views.detach(ctx, a)
				}
			case "brain_trail_unmount":
				if a, ok := mcpDecode[AppUnmount](raw); ok {
					refusal = views.unmount(ctx, a)
				}
			case "brain_trail_reset":
				if a, ok := mcpDecode[AppReset](raw); ok {
					value, refusal = views.reset(a)
				}
			}
			if name == "open_brain_trail" {
				return mcpPublicResult(nil, refusal), nil
			}
			return mcpPrivateResult(value, refusal), nil
		})
	}
	return server.Run(context.Background(), &mcp.StdioTransport{})
}
