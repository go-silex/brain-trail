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

func discoverCoworkNames(t *testing.T, v *coworkViewer, id string, started int64) []string {
	t.Helper()
	names, err := v.discover(id, started)
	if err != nil {
		t.Fatal(err)
	}
	return names
}

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
	write("r/_start.json", `{"v":1,"at":10,"ev":"start"}`)
	write("r/_end.json", `{"v":1,"at":11,"ev":"end"}`)
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
	w = request("GET", "/s/secret/cowork/receipts?session=task_1&after=3", host, "")
	var page struct {
		Receipts []struct {
			N    int    `json:"n"`
			Tool string `json:"tool"`
		} `json:"receipts"`
		Instance  int64 `json:"instance"`
		Next      int   `json:"next"`
		Ended     bool  `json:"ended"`
		Truncated bool  `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Receipts) != 1 || page.Receipts[0].N != 4 || page.Receipts[0].Tool != "Glob" || page.Next != 4 || page.Instance == 0 {
		t.Fatalf("page: %s %v", w.Body.String(), err)
	}
	write("r/_later.json", `{"v":1,"at":5,"ev":"start"}`)
	write("ended", "")
	write("truncated", "")
	w = request("GET", "/s/secret/cowork/receipts?session=task_1&after=4", host, "")
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Receipts) != 1 || page.Receipts[0].N != 5 || !page.Ended || !page.Truncated {
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
		write(filepath.Join("r", fmt.Sprintf("%04d.json", i)), fmt.Sprintf(`{"v":1,"at":1,"ev":"tool","tool":"Glob","seen":[%q,%q,%q]}`, "/projets/"+strings.Repeat("é", 600)+"/a.go", "/docs/"+strings.Repeat("界", 400)+"/b.md", "/src/"+strings.Repeat("ø", 600)+"/c.ts"))
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
		Instance int64             `json:"instance"`
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
			Instance int64             `json:"instance"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return w.Body.Len(), page
	}
	size, first := get(0)
	if size > 1536*1024 || !first.More || !first.Ended || first.Next == 0 || first.Next >= 400 || first.Instance == 0 {
		t.Fatalf("first page: size=%d next=%d more=%v ended=%v", size, first.Next, first.More, first.Ended)
	}
	last := first
	for last.More {
		size, page := get(last.Next)
		if size > 1536*1024 || page.Next <= last.Next {
			t.Fatalf("page: size=%d next=%d previous=%d", size, page.Next, last.Next)
		}
		last = page
	}
	if last.Next != 400 {
		t.Fatalf("last page: %+v", last)
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
	if len(recreated.Receipts) != 1 || recreated.Next != 1 || recreated.More || recreated.Instance == first.Instance {
		t.Fatalf("recreated: %+v", recreated)
	}
}

func TestCoworkViewerDiscoveryDirectoryCache(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sessions", coworkSessionKey("s"), "r")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(dir, "pending.json")
	if err := os.Mkdir(name, 0700); err != nil {
		t.Fatal(err)
	}
	when := time.Unix(1000, 0)
	if err := os.Chtimes(dir, when, when); err != nil {
		t.Fatal(err)
	}
	v := &coworkViewer{root: root}
	if got := discoverCoworkNames(t, v, "s", 1); len(got) != 0 {
		t.Fatalf("invalid receipt discovered: %v", got)
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(`{"v":1,"ev":"start"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(dir, when, when); err != nil {
		t.Fatal(err)
	}
	if got := discoverCoworkNames(t, v, "s", 1); len(got) != 1 {
		t.Fatalf("unreadable receipt was not retried: %v", got)
	}
	later := when.Add(time.Second)
	if err := os.Chtimes(dir, later, later); err != nil {
		t.Fatal(err)
	}
	if got := discoverCoworkNames(t, v, "s", 1); len(got) != 1 {
		t.Fatalf("changed mtime not discovered: %v", got)
	}
	if err := os.Rename(dir, dir+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.json"), []byte(`{"v":1,"ev":"end"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(dir, later, later); err != nil {
		t.Fatal(err)
	}
	if got := discoverCoworkNames(t, v, "s", 1); len(got) != 2 {
		t.Fatalf("replacement directory not discovered: %v", got)
	}
}

func TestCoworkViewerRecentEqualMtimeRetries(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sessions", coworkSessionKey("s"), "r")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	when := time.Now()
	if err := os.Chtimes(dir, when, when); err != nil {
		t.Fatal(err)
	}
	v := &coworkViewer{root: root}
	if got := discoverCoworkNames(t, v, "s", 1); len(got) != 0 {
		t.Fatalf("unexpected initial receipts: %v", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.json"), []byte(`{"v":1,"ev":"start"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(dir, when, when); err != nil {
		t.Fatal(err)
	}
	if got := discoverCoworkNames(t, v, "s", 1); len(got) != 1 {
		t.Fatalf("equal recent mtime hid new receipt: %v", got)
	}
}

func TestCoworkViewerInstanceChangesDuringDiscovery(t *testing.T) {
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
	write("r/a.json", `{"v":1,"ev":"start"}`)
	v := &coworkViewer{root: root}
	old, ok := v.loadSession("s")
	if !ok || len(discoverCoworkNames(t, v, "s", old.Started)) != 1 {
		t.Fatal("failed to seed old instance")
	}
	write("session.json", `{"v":1,"id":"s","started":2}`)
	write("r/a.json", `{"v":1,"ev":"end"}`)
	current, receipts, _, _, changed, status := v.discoverSession("s", old)
	if status != 0 || !changed || current.Started != 2 || len(receipts) != 1 || receipts[0] != "a.json" {
		t.Fatalf("instance race: session=%+v receipts=%+v changed=%v status=%d", current, receipts, changed, status)
	}
}

func TestCoworkViewerHandlerInstanceChangesDuringDiscovery(t *testing.T) {
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
	write("r/a.json", `{"v":1,"ev":"start"}`)
	v := &coworkViewer{relay: &relay{host: "127.0.0.1:1234", token: "t"}, root: root}
	r := httptest.NewRequest("GET", "http://127.0.0.1:1234/s/t/cowork/receipts?session=s&after=8", nil)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	loaded := make(chan struct{})
	resume := make(chan struct{})
	released := false
	v.beforeDiscovery = func() {
		close(loaded)
		<-resume
	}
	go func() {
		defer close(done)
		v.serveHTTP(w, r)
	}()
	defer func() {
		if !released {
			close(resume)
			<-done
		}
	}()
	select {
	case <-loaded:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not reach discovery")
	}
	write("session.json", `{"v":1,"id":"s","started":2}`)
	write("r/a.json", `{"v":1,"ev":"end"}`)
	close(resume)
	released = true
	<-done
	v.beforeDiscovery = nil
	var page struct {
		Instance int64             `json:"instance"`
		Receipts []json.RawMessage `json:"receipts"`
		Next     int               `json:"next"`
		More     bool              `json:"more"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != 200 || page.Instance == 0 || page.Receipts == nil || len(page.Receipts) != 0 || page.Next != 8 || page.More {
		t.Fatalf("instance race page: status=%d body=%s error=%v", w.Code, w.Body.String(), err)
	}
	instance := page.Instance
	restart := httptest.NewRecorder()
	v.serveHTTP(restart, httptest.NewRequest("GET", "http://127.0.0.1:1234/s/t/cowork/receipts?session=s&after=0", nil))
	if err := json.Unmarshal(restart.Body.Bytes(), &page); err != nil || restart.Code != 200 || page.Instance != instance || len(page.Receipts) != 1 || page.Next != 1 || page.More {
		t.Fatalf("restart page: status=%d body=%s error=%v", restart.Code, restart.Body.String(), err)
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

func TestCoworkViewerLRUInstancesAndOnDemandBodies(t *testing.T) {
	root := t.TempDir()
	v := &coworkViewer{relay: &relay{host: "127.0.0.1:1234", token: "t"}, root: root}
	write := func(id, name, body string) {
		t.Helper()
		dir := filepath.Join(root, "sessions", coworkSessionKey(id))
		if err := os.MkdirAll(filepath.Join(dir, "r"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	type page struct {
		Instance int64                  `json:"instance"`
		Next     int                    `json:"next"`
		Receipts []coworkIndexedReceipt `json:"receipts"`
	}
	get := func(id string, after int) page {
		t.Helper()
		w := httptest.NewRecorder()
		v.serveHTTP(w, httptest.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:1234/s/t/cowork/receipts?session=%s&after=%d", id, after), nil))
		var p page
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &p) != nil {
			t.Fatalf("page %s: status %d body %s", id, w.Code, w.Body.String())
		}
		if len(v.cache) > coworkViewCacheEntries || v.cacheBytes > coworkViewCacheBytes {
			t.Fatalf("cache exceeds limits: %d entries, %d bytes", len(v.cache), v.cacheBytes)
		}
		return p
	}
	write("s", "session.json", `{"v":1,"id":"s","started":1}`)
	write("s", "r/z.json", `{"v":1,"ev":"start"}`)
	first := get("s", 0)
	write("s", "r/a.json", `{"v":1,"ev":"end"}`)
	second := get("s", 1)
	if second.Instance != first.Instance || len(second.Receipts) != 1 || second.Receipts[0].N != 2 || second.Receipts[0].Ev != "end" {
		t.Fatalf("new receipt changed existing sequence: %+v", second)
	}
	write("s", "r/z.json", `{"v":1,"ev":"tool","tool":"Read"}`)
	revisit := get("s", 0)
	if revisit.Instance != first.Instance || len(revisit.Receipts) != 2 || revisit.Receipts[0].Tool != "Read" || revisit.Receipts[0].N != 1 {
		t.Fatalf("body was not read on demand: %+v", revisit)
	}
	for i := range coworkViewCacheEntries {
		id := fmt.Sprintf("other%d", i)
		write(id, "session.json", fmt.Sprintf(`{"v":1,"id":%q,"started":1}`, id))
		write(id, "r/one.json", `{"v":1,"ev":"start"}`)
		if i == coworkViewCacheEntries-1 {
			v.cache["s"].lastUsed = time.Now().Add(-coworkViewIdle - time.Second)
		}
		get(id, 0)
	}
	v.cache["other0"].lastUsed = time.Now().Add(-coworkViewIdle - time.Second)
	rebuilt := get("s", 0)
	if rebuilt.Instance == first.Instance || len(rebuilt.Receipts) != 2 || rebuilt.Receipts[0].Ev != "end" || rebuilt.Receipts[0].N != 1 || rebuilt.Receipts[1].N != 2 {
		t.Fatalf("evicted task did not get a fresh instance: %+v", rebuilt)
	}
	if again := get("s", 1); again.Instance != rebuilt.Instance || len(again.Receipts) != 1 || again.Receipts[0].N != 2 {
		t.Fatalf("rebuilt cursor not stable: %+v", again)
	}
}

func TestCoworkViewerProtectsActiveFullIndexes(t *testing.T) {
	root := t.TempDir()
	v := &coworkViewer{relay: &relay{host: "127.0.0.1:1234", token: "t"}, root: root}
	for i := range 5 {
		id := fmt.Sprintf("task%d", i)
		dir := filepath.Join(root, "sessions", coworkSessionKey(id))
		if err := os.MkdirAll(filepath.Join(dir, "r"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "session.json"), []byte(fmt.Sprintf(`{"v":1,"id":%q,"started":1}`, id)), 0600); err != nil {
			t.Fatal(err)
		}
		for n := range 5000 {
			if err := os.WriteFile(filepath.Join(dir, "r", fmt.Sprintf("%04d.json", n)), []byte(`{"v":1,"at":1,"ev":"start"}`), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	type page struct {
		Instance int64                  `json:"instance"`
		Next     int                    `json:"next"`
		More     bool                   `json:"more"`
		Receipts []coworkIndexedReceipt `json:"receipts"`
	}
	get := func(id string, after int) (int, page) {
		t.Helper()
		w := httptest.NewRecorder()
		v.serveHTTP(w, httptest.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:1234/s/t/cowork/receipts?session=%s&after=%d", id, after), nil))
		var p page
		if w.Code == 200 {
			if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
				t.Fatal(err)
			}
		}
		return w.Code, p
	}
	var instances [4]int64
	var offsets [4]int
	for round := range 5 {
		for i := range 4 {
			status, p := get(fmt.Sprintf("task%d", i), offsets[i])
			if status != 200 || len(p.Receipts) != 1000 || p.Next != offsets[i]+1000 || p.More != (round < 4) {
				t.Fatalf("task %d round %d: status %d page %+v", i, round, status, p)
			}
			if round == 0 {
				instances[i] = p.Instance
			}
			if p.Instance == 0 || p.Instance != instances[i] {
				t.Fatalf("task %d instance changed: %d to %d", i, instances[i], p.Instance)
			}
			offsets[i] = p.Next
		}
		if status, _ := get("task4", 0); status != 503 {
			t.Fatalf("active cache admitted fifth task: status %d", status)
		}
	}
	if len(v.cache) != 4 || v.cacheBytes > coworkViewCacheBytes {
		t.Fatalf("cache limits: %d entries, %d bytes", len(v.cache), v.cacheBytes)
	}
	v.cache["task0"].lastUsed = time.Now().Add(-coworkViewIdle - time.Second)
	if status, p := get("task4", 0); status != 200 || p.Instance == 0 {
		t.Fatalf("idle cache entry not evicted: status %d page %+v", status, p)
	}
	if v.cache["task0"] != nil {
		t.Fatal("idle LRU entry retained")
	}
	for i := 1; i < 4; i++ {
		status, p := get(fmt.Sprintf("task%d", i), offsets[i])
		if status != 200 || p.Instance != instances[i] || p.More || p.Next != 5000 {
			t.Fatalf("hot task %d changed after eviction: status %d page %+v", i, status, p)
		}
	}
}
