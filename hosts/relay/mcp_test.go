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
