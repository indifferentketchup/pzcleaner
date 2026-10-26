package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const (
	dialTimeout    = 20 * time.Second
	keepAliveEvery = 15 * time.Second
	backupFolder   = "pzcleaner-backup"
)

type App struct {
	ctx    context.Context
	mu     sync.Mutex
	store  store
	root   string
	backup string
}

var (
	chunkName  = regexp.MustCompile(`^(-?\d+)\.bin$`)
	columnName = regexp.MustCompile(`^-?\d+$`)
)

type ConnectRequest struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	Path     string `json:"path"`
	Trust    string `json:"trust"`
}

type ConnectResult struct {
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	KeyType     string `json:"keyType"`
}

type Entry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size"`
}

type unknownHost struct {
	fingerprint string
	keyType     string
}

func (u *unknownHost) Error() string {
	return "unknown host"
}

func knownHostsFile() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	file := filepath.Join(dir, "pzcleaner-gui", "known_hosts")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return "", err
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_RDONLY, 0o600)
	if err != nil {
		return "", err
	}
	return file, f.Close()
}

func hostKeyCheck(trust string) (ssh.HostKeyCallback, error) {
	file, err := knownHostsFile()
	if err != nil {
		return nil, err
	}
	check, err := knownhosts.New(file)
	if err != nil {
		return nil, err
	}
	return func(host string, remote net.Addr, key ssh.PublicKey) error {
		err := check(host, remote, key)
		var keyErr *knownhosts.KeyError
		if !errors.As(err, &keyErr) {
			return err
		}
		if len(keyErr.Want) > 0 {
			return fmt.Errorf("the server's identity changed since the last connection. If your host reinstalled or moved the server, delete %s and connect again", file)
		}
		fingerprint := ssh.FingerprintSHA256(key)
		if trust != fingerprint {
			return &unknownHost{fingerprint: fingerprint, keyType: key.Type()}
		}
		out, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = fmt.Fprintln(out, knownhosts.Line([]string{knownhosts.Normalize(host)}, key))
		return err
	}, nil
}

func authMethods(password string) []ssh.AuthMethod {
	return []ssh.AuthMethod{
		ssh.Password(password),
		ssh.KeyboardInteractive(func(name, instruction string, questions []string, echos []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i := range answers {
				answers[i] = password
			}
			return answers, nil
		}),
	}
}

func keepAlive(conn *ssh.Client) {
	for {
		time.Sleep(keepAliveEvery)
		reply := make(chan error, 1)
		go func() {
			_, _, err := conn.SendRequest("keepalive@openssh.com", true, nil)
			reply <- err
		}()
		select {
		case err := <-reply:
			if err != nil {
				return
			}
		case <-time.After(keepAliveEvery):
			conn.Close()
			return
		}
	}
}

func (a *App) Connect(req ConnectRequest) (ConnectResult, error) {
	root := strings.TrimRight(strings.TrimSpace(req.Path), "/")
	if req.Host == "" || req.User == "" || req.Password == "" || root == "" {
		return ConnectResult{}, errors.New("fill in the host, the user, the password and the save folder path")
	}
	if req.Port == 0 {
		req.Port = 22
	}
	hostKeys, err := hostKeyCheck(req.Trust)
	if err != nil {
		return ConnectResult{}, err
	}
	conn, err := ssh.Dial("tcp", net.JoinHostPort(strings.TrimSpace(req.Host), strconv.Itoa(req.Port)), &ssh.ClientConfig{
		User:            req.User,
		Auth:            authMethods(req.Password),
		HostKeyCallback: hostKeys,
		Timeout:         dialTimeout,
	})
	var unknown *unknownHost
	if errors.As(err, &unknown) {
		return ConnectResult{Fingerprint: unknown.fingerprint, KeyType: unknown.keyType}, nil
	}
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return ConnectResult{}, fmt.Errorf("could not reach %s on port %d. Check the host and port in your host's panel (%w)", req.Host, req.Port, err)
	}
	if err != nil && strings.Contains(err.Error(), "unable to authenticate") {
		return ConnectResult{}, errors.New("the server did not accept that user and password")
	}
	if err != nil {
		return ConnectResult{}, err
	}
	client, err := sftp.NewClient(conn)
	if err != nil {
		conn.Close()
		return ConnectResult{}, fmt.Errorf("the server did not start an sftp session: %w", err)
	}
	remote := &remoteStore{conn: conn, client: client}
	if err := checkSaveFolder(remote, root); err != nil {
		remote.Close()
		return ConnectResult{}, err
	}
	go keepAlive(conn)
	return a.open(remote, root), nil
}

func (a *App) OpenLocal() (ConnectResult, error) {
	dir, err := wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Choose the save folder, the one holding map_meta.bin and a map folder",
	})
	if err != nil || dir == "" {
		return ConnectResult{}, err
	}
	root := filepath.ToSlash(filepath.Clean(dir))
	if err := checkSaveFolder(localStore{}, root); err != nil {
		return ConnectResult{}, err
	}
	return a.open(localStore{}, root), nil
}

func checkSaveFolder(s store, root string) error {
	entry, err := s.Stat(root)
	if err == nil && !entry.Dir {
		err = errors.New("that path is a file, not a folder")
	}
	if err != nil {
		return fmt.Errorf("could not open the save folder %s: %w", root, err)
	}
	return nil
}

func backupDir(root string) string {
	saves := path.Dir(path.Dir(root))
	if path.Base(saves) == "Saves" {
		return path.Join(path.Dir(saves), backupFolder, path.Base(root))
	}
	return path.Join(path.Dir(root), backupFolder, path.Base(root))
}

func (a *App) open(s store, root string) ConnectResult {
	a.Disconnect()
	a.mu.Lock()
	a.store, a.root, a.backup = s, root, backupDir(root)
	a.mu.Unlock()
	return ConnectResult{Name: path.Base(root)}
}

func (a *App) Disconnect() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.store != nil {
		a.store.Close()
	}
	a.store, a.root, a.backup = nil, "", ""
}

func (a *App) session(rel string) (store, string, error) {
	a.mu.Lock()
	s, root, backup := a.store, a.root, a.backup
	a.mu.Unlock()
	if s == nil {
		return nil, "", errors.New("NotConnectedError: no save is open")
	}
	if rel == "" {
		return s, root, nil
	}
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.Contains(part, "\\") {
			return nil, "", fmt.Errorf("TypeError: bad path %q", rel)
		}
	}
	if parts[0] == trashDir {
		return s, path.Join(append([]string{backup}, parts[1:]...)...), nil
	}
	return s, path.Join(root, rel), nil
}

func named(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("NotFoundError: %w", err)
	}
	return fmt.Errorf("Error: %w", err)
}

func (a *App) List(rel string) ([]Entry, error) {
	s, full, err := a.session(rel)
	if err != nil {
		return nil, err
	}
	entries, err := s.ReadDir(full)
	return entries, named(err)
}

func (a *App) Stat(rel string) (Entry, error) {
	s, full, err := a.session(rel)
	if err != nil {
		return Entry{}, err
	}
	entry, err := s.Stat(full)
	return entry, named(err)
}

func (a *App) Read(rel string) ([]byte, error) {
	s, full, err := a.session(rel)
	if err != nil {
		return nil, err
	}
	f, err := s.Open(full)
	if err != nil {
		return nil, named(err)
	}
	defer f.Close()
	var data bytes.Buffer
	_, err = io.Copy(&data, f)
	return data.Bytes(), named(err)
}

func (a *App) Write(rel string, data []byte) error {
	s, full, err := a.session(rel)
	if err != nil {
		return err
	}
	f, err := s.Create(full)
	if err != nil {
		return named(err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return named(err)
	}
	return named(f.Close())
}

func (a *App) Mkdir(rel string) error {
	s, full, err := a.session(rel)
	if err != nil {
		return err
	}
	return named(s.MkdirAll(full))
}

func (a *App) Rename(from, to string) error {
	s, fullFrom, err := a.session(from)
	if err != nil {
		return err
	}
	_, fullTo, err := a.session(to)
	if err != nil {
		return err
	}
	return named(s.Rename(fullFrom, fullTo))
}

func (a *App) Remove(rel string, recursive bool) error {
	s, full, err := a.session(rel)
	if err != nil {
		return err
	}
	entry, err := s.Stat(full)
	if err != nil {
		return named(err)
	}
	if entry.Dir && recursive {
		if err := removeTree(s, full); err != nil {
			return named(err)
		}
	}
	err = s.Remove(full)
	if err != nil && entry.Dir && !recursive {
		if entries, listErr := s.ReadDir(full); listErr == nil && len(entries) > 0 {
			return fmt.Errorf("InvalidModificationError: %s is not empty", rel)
		}
	}
	return named(err)
}

func (a *App) Index(rel string) ([]int, error) {
	s, full, err := a.session(rel)
	if err != nil {
		return nil, err
	}
	entries, err := s.ReadDir(full)
	if err != nil {
		return nil, named(err)
	}
	var columns []int
	for _, entry := range entries {
		if entry.Dir && columnName.MatchString(entry.Name) {
			x, _ := strconv.Atoi(entry.Name)
			columns = append(columns, x)
		}
	}
	var (
		mu   sync.Mutex
		flat []int
		done atomic.Int64
		stop = make(chan struct{})
	)
	go a.reportProgress(&done, len(columns), stop)
	err = runPool(columns, listWorkers, func(x int) error {
		names, err := s.ReadDir(path.Join(full, strconv.Itoa(x)))
		if err != nil {
			return err
		}
		found := make([]int, 0, 2*len(names))
		for _, entry := range names {
			if m := chunkName.FindStringSubmatch(entry.Name); m != nil {
				y, _ := strconv.Atoi(m[1])
				found = append(found, x, y)
			}
		}
		mu.Lock()
		flat = append(flat, found...)
		mu.Unlock()
		done.Add(1)
		return nil
	})
	close(stop)
	return flat, named(err)
}
