package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"sync"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type store interface {
	ReadDir(dir string) ([]Entry, error)
	Stat(name string) (Entry, error)
	Open(name string) (io.ReadCloser, error)
	Create(name string) (io.WriteCloser, error)
	Remove(name string) error
	Rename(from, to string) error
	Replace(from, to string) error
	MkdirAll(dir string) error
	Close() error
}

type remoteStore struct {
	conn   *ssh.Client
	client *sftp.Client
}

func (r *remoteStore) ReadDir(dir string) ([]Entry, error) {
	infos, err := r.client.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(infos))
	for _, info := range infos {
		entries = append(entries, Entry{Name: info.Name(), Dir: info.IsDir(), Size: info.Size()})
	}
	return entries, nil
}

func (r *remoteStore) Stat(name string) (Entry, error) {
	info, err := r.client.Stat(name)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Name: path.Base(name), Dir: info.IsDir(), Size: info.Size()}, nil
}

func (r *remoteStore) Open(name string) (io.ReadCloser, error) {
	return r.client.Open(name)
}

func (r *remoteStore) Create(name string) (io.WriteCloser, error) {
	return r.client.Create(name)
}

func (r *remoteStore) Remove(name string) error {
	return r.client.Remove(name)
}

func (r *remoteStore) Rename(from, to string) error {
	return r.client.Rename(from, to)
}

func (r *remoteStore) Replace(from, to string) error {
	if _, ok := r.client.HasExtension("posix-rename@openssh.com"); ok {
		return r.client.PosixRename(from, to)
	}
	if err := r.client.Remove(to); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return r.client.Rename(from, to)
}

func (r *remoteStore) MkdirAll(dir string) error {
	return r.client.MkdirAll(dir)
}

func (r *remoteStore) Close() error {
	r.client.Close()
	return r.conn.Close()
}

type localStore struct{}

func (localStore) ReadDir(dir string) ([]Entry, error) {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(items))
	for _, item := range items {
		entries = append(entries, Entry{Name: item.Name(), Dir: item.IsDir()})
	}
	return entries, nil
}

func (localStore) Stat(name string) (Entry, error) {
	info, err := os.Stat(name)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Name: path.Base(name), Dir: info.IsDir(), Size: info.Size()}, nil
}

func (localStore) Open(name string) (io.ReadCloser, error) {
	return os.Open(name)
}

func (localStore) Create(name string) (io.WriteCloser, error) {
	return os.Create(name)
}

func (localStore) Remove(name string) error {
	return os.Remove(name)
}

func (localStore) Rename(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return fs.ErrExist
	}
	return os.Rename(from, to)
}

func (localStore) Replace(from, to string) error {
	return os.Rename(from, to)
}

func (localStore) MkdirAll(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

func (localStore) Close() error {
	return nil
}

func runPool[T any](items []T, workers int, task func(T) error) error {
	var (
		mu    sync.Mutex
		wg    sync.WaitGroup
		next  int
		first error
	)
	for range min(workers, len(items)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if first != nil || next >= len(items) {
					mu.Unlock()
					return
				}
				item := items[next]
				next++
				mu.Unlock()
				if err := task(item); err != nil {
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
					return
				}
			}
		}()
	}
	wg.Wait()
	return first
}

func walk(s store, root string) ([]string, [][]string, error) {
	var (
		mu     sync.Mutex
		files  []string
		levels = [][]string{{root}}
	)
	for level := levels[0]; len(level) > 0; level = levels[len(levels)-1] {
		var next []string
		err := runPool(level, listWorkers, func(dir string) error {
			entries, err := s.ReadDir(dir)
			if err != nil {
				return err
			}
			mu.Lock()
			defer mu.Unlock()
			for _, entry := range entries {
				full := path.Join(dir, entry.Name)
				if entry.Dir {
					next = append(next, full)
				} else {
					files = append(files, full)
				}
			}
			return nil
		})
		if err != nil {
			return nil, nil, err
		}
		if len(next) == 0 {
			break
		}
		levels = append(levels, next)
	}
	return files, levels, nil
}

func removeTree(s store, dir string) error {
	files, levels, err := walk(s, dir)
	if err != nil {
		return err
	}
	err = runPool(files, fileWorkers, func(file string) error {
		err := s.Remove(file)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	})
	if err != nil {
		return err
	}
	for i := len(levels) - 1; i > 0; i-- {
		if err := runPool(levels[i], fileWorkers, s.Remove); err != nil {
			return err
		}
	}
	return nil
}
