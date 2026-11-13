package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const fileHandleLifetime = 10 * time.Minute
const fileHandleLimit = 8
const fileReadLimit = 160004
const fileCharacterLimit = 40001

var errFileChanged = errors.New("held file or workspace changed")

type FilePrepared struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Inside bool   `json:"inside"`
}

type FileRead struct {
	Text string `json:"text"`
}

type heldFile struct {
	file          *os.File
	workspace     *os.Root
	workspaceDir  *os.File
	parent        *os.Root
	workspacePath string
	requestedRoot string
	requestedPath string
	path          string
	info          os.FileInfo
	workspaceInfo os.FileInfo
	expires       time.Time
	timer         *time.Timer
}

type FileAuthority struct {
	mu      sync.Mutex
	handles map[string]*heldFile
	closed  bool
}

func NewFileAuthority() *FileAuthority { return &FileAuthority{handles: make(map[string]*heldFile)} }

func (h *heldFile) close() {
	if h.timer != nil {
		h.timer.Stop()
	}
	h.file.Close()
	h.parent.Close()
	h.workspaceDir.Close()
	h.workspace.Close()
}

// Prepare opens the workspace and file through directory capabilities. The
// displayed path comes from the held descriptor, never directly from input.
func (a *FileAuthority) Prepare(root, path string) (FilePrepared, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return FilePrepared{}, errors.New("file authority closed")
	}
	if len(a.handles) >= fileHandleLimit {
		return FilePrepared{}, errors.New("too many held files")
	}
	if !filepath.IsAbs(root) || !filepath.IsAbs(path) {
		return FilePrepared{}, errors.New("file paths must be absolute")
	}
	workspace, err := os.OpenRoot(root)
	if err != nil {
		return FilePrepared{}, err
	}
	workspaceDir, err := workspace.Open(".")
	if err != nil {
		workspace.Close()
		return FilePrepared{}, err
	}
	workspaceInfo, err := workspaceDir.Stat()
	if err != nil {
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, err
	}
	workspacePath, err := fileDescriptorPath(workspaceDir)
	if err != nil {
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, err
	}
	parent, err := os.OpenRoot(filepath.Dir(resolved))
	if err != nil {
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, err
	}
	name := filepath.Base(resolved)
	before, err := parent.Lstat(name)
	if err != nil {
		parent.Close()
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, err
	}
	if !before.Mode().IsRegular() {
		parent.Close()
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, errors.New("not a regular file")
	}
	file, err := openHeldFile(parent, name)
	if err != nil {
		parent.Close()
		workspaceDir.Close()
		workspace.Close()
		return FilePrepared{}, err
	}
	h := &heldFile{file: file, parent: parent, workspace: workspace, workspaceDir: workspaceDir, workspacePath: workspacePath, requestedRoot: root, requestedPath: path, workspaceInfo: workspaceInfo}
	defer func() {
		if h != nil {
			h.close()
		}
	}()
	h.info, err = file.Stat()
	if err != nil {
		return FilePrepared{}, err
	}
	if !h.info.Mode().IsRegular() {
		return FilePrepared{}, errors.New("not a regular file")
	}
	if !os.SameFile(before, h.info) {
		return FilePrepared{}, errFileChanged
	}
	h.path, err = fileDescriptorPath(file)
	if err != nil {
		return FilePrepared{}, err
	}
	if !sameFilePath(h.path, resolved) {
		return FilePrepared{}, errFileChanged
	}
	if err = h.verify(); err != nil {
		return FilePrepared{}, err
	}
	var token [32]byte
	if _, err = rand.Read(token[:]); err != nil {
		return FilePrepared{}, err
	}
	id := base64.RawURLEncoding.EncodeToString(token[:])
	rel, relErr := filepath.Rel(workspacePath, h.path)
	inside := relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	h.expires = time.Now().Add(fileHandleLifetime)
	a.handles[id] = h
	h.timer = time.AfterFunc(fileHandleLifetime, func() { a.Release(id) })
	result := FilePrepared{ID: id, Path: h.path, Inside: inside}
	h = nil
	return result, nil
}

func (h *heldFile) verify() error {
	rootPath, err := fileDescriptorPath(h.workspaceDir)
	if err != nil {
		return err
	}
	if !sameFilePath(rootPath, h.workspacePath) {
		return errFileChanged
	}
	for _, path := range []string{h.workspacePath, h.requestedRoot} {
		current, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !os.SameFile(current, h.workspaceInfo) {
			return errFileChanged
		}
	}
	filePath, err := fileDescriptorPath(h.file)
	if err != nil {
		return err
	}
	if !sameFilePath(filePath, h.path) {
		return errFileChanged
	}
	info, err := h.file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !os.SameFile(info, h.info) {
		return errFileChanged
	}
	for _, path := range []string{h.path, h.requestedPath} {
		current, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !os.SameFile(current, h.info) {
			return errFileChanged
		}
	}
	return nil
}

func (a *FileAuthority) Read(id string) (FileRead, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	h, ok := a.handles[id]
	if !ok {
		return FileRead{}, errors.New("unknown or expired file handle")
	}
	if !time.Now().Before(h.expires) {
		delete(a.handles, id)
		h.close()
		return FileRead{}, errors.New("unknown or expired file handle")
	}
	if err := h.verify(); err != nil {
		return FileRead{}, err
	}
	data := make([]byte, fileReadLimit)
	n, err := h.file.ReadAt(data, 0)
	if err != nil && err != io.EOF {
		return FileRead{}, err
	}
	text := strings.ToValidUTF8(string(data[:n]), "\uFFFD")
	count := 0
	for i := range text {
		if count == fileCharacterLimit {
			text = text[:i]
			break
		}
		count++
	}
	return FileRead{Text: text}, nil
}

func (a *FileAuthority) Verify(id string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	h, ok := a.handles[id]
	if !ok {
		return "", errors.New("unknown or expired file handle")
	}
	if !time.Now().Before(h.expires) {
		delete(a.handles, id)
		h.close()
		return "", errors.New("unknown or expired file handle")
	}
	if err := h.verify(); err != nil {
		return "", err
	}
	return h.path, nil
}

func (a *FileAuthority) Release(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if h, ok := a.handles[id]; ok {
		delete(a.handles, id)
		h.close()
	}
}

func (a *FileAuthority) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	for id, h := range a.handles {
		delete(a.handles, id)
		h.close()
	}
}
