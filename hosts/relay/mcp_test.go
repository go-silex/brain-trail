package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPAssetIntegrity(t *testing.T) {
	dir := t.TempDir()
	build := strings.Repeat("a", 64)
	html := "<!doctype html><html><body><script>const build='" + build + "'</script></body></html>"
	digest := sha256.Sum256([]byte(html))
	manifest := Manifest{V1: V1{V: 1}, WireRevision: 1, UIBuildID: Hex64(build), AssetDigest: Hex64(hex.EncodeToString(digest[:]))}
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	write("mcp-app-manifest.json", data)
	write("mcp-app.html", []byte(html))
	if _, _, err := loadMCPAssets(dir); err != nil {
		t.Fatal(err)
	}
	write("mcp-app.html", []byte(html+"tampered"))
	if _, _, err := loadMCPAssets(dir); err == nil {
		t.Fatal("accepted a mismatched digest")
	}
}

func TestMCPPrivateReplyDoesNotExposePayload(t *testing.T) {
	result := mcpPrivateResult(map[string]string{"secret": "private-marker"}, "")
	public, err := json.Marshal(result.Content)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(public), "private-marker") || result.StructuredContent != nil {
		t.Fatal("private payload exposed publicly")
	}
	if _, ok := result.Meta["brainTrail"]; !ok {
		t.Fatal("missing private result")
	}
}

func TestMCPResultEnvelopes(t *testing.T) {
	tests := []struct {
		name      string
		private   bool
		refusal   string
		wantError bool
		wantText  string
	}{
		{name: "private success", private: true, wantText: "Brain Trail request processed."},
		{name: "private refusal", private: true, refusal: "forbidden", wantText: "Brain Trail request processed."},
		{name: "public success", wantText: "attached"},
		{name: "public refusal", refusal: "forbidden", wantError: true, wantText: "refused"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value := map[string]string{"secret": "private-marker"}
			result := mcpPublicResult(value, tt.refusal)
			if tt.private {
				result = mcpPrivateResult(value, tt.refusal)
			}
			data, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				IsError bool `json:"isError"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
				Meta              map[string]json.RawMessage `json:"_meta"`
				StructuredContent json.RawMessage            `json:"structuredContent"`
			}
			if err := json.Unmarshal(data, &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.IsError != tt.wantError {
				t.Fatalf("isError = %v, want %v", envelope.IsError, tt.wantError)
			}
			if len(envelope.Content) != 1 || envelope.Content[0].Type != "text" || envelope.Content[0].Text != tt.wantText {
				t.Fatalf("unexpected public content: %+v", envelope.Content)
			}
			reply := envelope.StructuredContent
			if tt.private {
				if len(envelope.StructuredContent) != 0 {
					t.Fatal("private result exposed structured content")
				}
				reply = envelope.Meta["brainTrail"]
			} else if _, ok := envelope.Meta["brainTrail"]; ok {
				t.Fatal("public result unexpectedly contains private metadata")
			}
			var wire struct {
				V     int               `json:"v"`
				OK    bool              `json:"ok"`
				Error string            `json:"error"`
				Value map[string]string `json:"value"`
			}
			if err := json.Unmarshal(reply, &wire); err != nil {
				t.Fatalf("missing or invalid reply: %v", err)
			}
			if wire.V != 1 || wire.OK != (tt.refusal == "") || wire.Error != tt.refusal {
				t.Fatalf("unexpected wire reply: %+v", wire)
			}
			if tt.refusal == "" && wire.Value["secret"] != "private-marker" {
				t.Fatalf("missing success value: %+v", wire)
			}
			if tt.refusal != "" && wire.Value != nil {
				t.Fatalf("refusal exposed success value: %+v", wire)
			}
		})
	}
}
