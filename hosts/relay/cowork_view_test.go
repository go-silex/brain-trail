package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoworkViewer(t *testing.T) {
	root := t.TempDir()
	assets := t.TempDir()
	for _, name := range []string{"index.html", "app.js", "app.css"} {
		if err := os.WriteFile(filepath.Join(assets, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	dir := filepath.Join(root, "sessions", coworkSessionKey("task_1"))
	if err := os.MkdirAll(filepath.Join(dir, "r"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("session.json", `{"v":1,"id":"task_1","task":"local_abc","started":10}`)
	write("r/a.json", `{"v":1,"at":20,"ev":"tool","tool":"Read","ok":true,"agent":false,"files":[{"p":"/a","k":"read"}]}`)
	write("r/b.json", `{"v":1,"at":15,"ev":"tool","tool":"Glob","ok":true,"agent":false,"seen":["/a","/b"],"mcp":{"server":"Drive","tool":"list"}}`)
	s := &relay{host: "127.0.0.1:1234", token: "secret", assets: assets, launch: "once", launchExpiry: time.Now().Add(time.Minute)}
	v := &coworkViewer{relay: s, root: root, session: "task_1"}
	request := func(method, path, host, origin string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "http://127.0.0.1:1234"+path, nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		v.serveHTTP(w, r)
		return w
	}
	host := s.host
	for _, tc := range []struct {
		method, path, host, origin string
		status                     int
	}{
		{"GET", "/s/secret/", "evil", "", 403},
		{"GET", "/s/secret/", host, "http://evil", 403},
		{"GET", "/s/wrong/", host, "", 404},
		{"POST", "/s/secret/cowork/sessions", host, "", 405},
		{"GET", "/s/secret/unknown", host, "", 404},
		{"GET", "/s/secret/cowork/receipts?session=..%2Ftask_1", host, "", 404},
		{"GET", "/s/secret/cowork/receipts?session=task_1&after=-1", host, "", 400},
		{"GET", "/s/secret/app.js", host, "", 200},
	} {
		if w := request(tc.method, tc.path, tc.host, tc.origin); w.Code != tc.status {
			t.Errorf("%s %s: got %d want %d", tc.method, tc.path, w.Code, tc.status)
		}
	}
	launch := request("GET", "/launch/once", host, "")
	if launch.Code != 303 || launch.Header().Get("Location") != "/s/secret/?host=cowork&session=task_1" {
		t.Fatalf("launch: %d %q", launch.Code, launch.Header().Get("Location"))
	}
	if got := request("GET", "/launch/once", host, "").Code; got != 404 {
		t.Fatalf("reused launch: %d", got)
	}
	w := request("GET", "/s/secret/cowork/sessions", host, "")
	var listing struct {
		Sessions []coworkViewSession `json:"sessions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listing); err != nil || len(listing.Sessions) != 1 {
		t.Fatalf("listing: %s %v", w.Body.String(), err)
	}
	item := listing.Sessions[0]
	if item.ID != "task_1" || item.Started != 10 || item.Calls != 2 || item.Last == 0 {
		t.Fatalf("summary: %+v", item)
	}
	w = request("GET", "/s/secret/cowork/receipts?session=task_1&after=1", host, "")
	var page struct {
		Receipts []struct {
			N    int    `json:"n"`
			Tool string `json:"tool"`
		} `json:"receipts"`
		Next      int  `json:"next"`
		Ended     bool `json:"ended"`
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Receipts) != 1 || page.Receipts[0].N != 2 || page.Receipts[0].Tool != "Glob" || page.Next != 2 {
		t.Fatalf("page: %s %v", w.Body.String(), err)
	}
	write("r/0.json", `{"v":1,"at":5,"ev":"start"}`)
	write("ended", "")
	write("truncated", "")
	w = request("GET", "/s/secret/cowork/receipts?session=task_1&after=2", host, "")
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Receipts) != 1 || page.Receipts[0].N != 3 || !page.Ended || !page.Truncated {
		t.Fatalf("discovery: %s %v", w.Body.String(), err)
	}
	if w.Header().Get("Content-Security-Policy") == "" || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("missing security headers: %v", w.Header())
	}
}

func TestCoworkViewerPagination(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sessions", coworkSessionKey("s"))
	if err := os.MkdirAll(filepath.Join(dir, "r"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.json"), []byte(`{"v":1,"id":"s","started":1,"task":"local_x"}`), 0600); err != nil {
		t.Fatal(err)
	}
	for i := range 1001 {
		if err := os.WriteFile(filepath.Join(dir, "r", fmt.Sprintf("%04d.json", i)), []byte(`{"v":1,"at":1,"ev":"start"}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	v := &coworkViewer{relay: &relay{host: "127.0.0.1:1234", token: "t"}, root: root}
	for _, tc := range []struct {
		after, count, next int
		more               bool
	}{{0, 1000, 1000, true}, {1000, 1, 1001, false}, {1001, 0, 1001, false}} {
		r := httptest.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:1234/s/t/cowork/receipts?session=s&after=%d", tc.after), nil)
		w := httptest.NewRecorder()
		v.serveHTTP(w, r)
		var page struct {
			Receipts []json.RawMessage `json:"receipts"`
			Next     int               `json:"next"`
			More     bool              `json:"more"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Receipts) != tc.count || page.Next != tc.next || page.More != tc.more {
			t.Fatalf("after %d: %s %v", tc.after, w.Body.String(), err)
		}
	}
}

func TestCoworkViewerByteBudgetAndRecreation(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sessions", coworkSessionKey("s"))
	if err := os.MkdirAll(filepath.Join(dir, "r"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("session.json", `{"v":1,"id":"s","started":1}`)
	for i := range 400 {
		write(filepath.Join("r", fmt.Sprintf("%04d.json", i)), fmt.Sprintf(`{"v":1,"at":1,"ev":"tool","tool":%q}`, strings.Repeat("x", 5000)))
	}
	write("r/.tmp-ignore.json", `{"v":1,"ev":"start"}`)
	write("r/oversize.json", strings.Repeat("x", 8193))
	write("ended", "")
	v := &coworkViewer{relay: &relay{host: "127.0.0.1:1234", token: "t"}, root: root}
	get := func(after int) (int, struct {
		Receipts []json.RawMessage `json:"receipts"`
		Next     int               `json:"next"`
		More     bool              `json:"more"`
		Ended    bool              `json:"ended"`
	}) {
		t.Helper()
		r := httptest.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:1234/s/t/cowork/receipts?session=s&after=%d", after), nil)
		w := httptest.NewRecorder()
		v.serveHTTP(w, r)
		var page struct {
			Receipts []json.RawMessage `json:"receipts"`
			Next     int               `json:"next"`
			More     bool              `json:"more"`
			Ended    bool              `json:"ended"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return w.Body.Len(), page
	}
	size, first := get(0)
	if size > 1536*1024 || !first.More || !first.Ended || first.Next == 0 || first.Next >= 400 {
		t.Fatalf("first page: size=%d next=%d more=%v ended=%v", size, first.Next, first.More, first.Ended)
	}
	_, second := get(first.Next)
	if second.More || second.Next != 400 {
		t.Fatalf("second page: %+v", second)
	}
	if err := os.RemoveAll(filepath.Join(dir, "r")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "r"), 0700); err != nil {
		t.Fatal(err)
	}
	write("session.json", `{"v":1,"id":"s","started":2}`)
	write("r/new.json", `{"v":1,"at":2,"ev":"start"}`)
	_, recreated := get(0)
	if len(recreated.Receipts) != 1 || recreated.Next != 1 || recreated.More {
		t.Fatalf("recreated: %+v", recreated)
	}
}

func TestCoworkViewerActivityRequiresAuthentication(t *testing.T) {
	s := &relay{host: "127.0.0.1:1234", token: "t", launch: "code", launchExpiry: time.Now().Add(time.Minute), generation: 1, launchBound: true, launchGeneration: 1}
	v := &coworkViewer{relay: s, root: t.TempDir(), activity: make(chan struct{}, 1)}
	request := func(path string) int {
		w := httptest.NewRecorder()
		v.serveHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:1234"+path, nil))
		return w.Code
	}
	request("/launch/wrong")
	request("/s/wrong/cowork/sessions")
	if len(v.activity) != 0 {
		t.Fatal("unauthenticated request counted as activity")
	}
	if request("/launch/code") != 303 || len(v.activity) != 1 {
		t.Fatal("authenticated launch not counted")
	}
	<-v.activity
	request("/s/t/cowork/sessions")
	if len(v.activity) != 1 {
		t.Fatal("authenticated token not counted")
	}
}

func TestCoworkViewerSelectsSummariesWithoutReadingReceipts(t *testing.T) {
	root := t.TempDir()
	for i := range 101 {
		id := fmt.Sprintf("s%03d", i)
		dir := filepath.Join(root, "sessions", coworkSessionKey(id))
		if err := os.MkdirAll(filepath.Join(dir, "r"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "session.json"), []byte(fmt.Sprintf(`{"v":1,"id":%q,"started":1}`, id)), 0600); err != nil {
			t.Fatal(err)
		}
		active := filepath.Join(dir, "active")
		if err := os.WriteFile(active, nil, 0600); err != nil {
			t.Fatal(err)
		}
		when := time.Unix(int64(i+1), 0)
		if err := os.Chtimes(active, when, when); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "r", "bad.json"), []byte("not JSON"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	v := &coworkViewer{root: root}
	sessions := v.sessions()
	if len(sessions) != 100 || sessions[0].ID != "s100" || sessions[99].ID != "s001" || sessions[0].Calls != 1 || len(v.cache) != 0 {
		t.Fatalf("unexpected summaries: count=%d cache=%d", len(sessions), len(v.cache))
	}
}
