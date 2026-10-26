package main

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	_ "modernc.org/sqlite"
)

const (
	listWorkers    = 256
	fileWorkers    = 512
	trashDir       = "_pzcleaner_trash"
	vehiclesBackup = "vehicles.db.pzcleaner-bak"
)

var cellKinds = map[string]bool{"zpop": true, "apop": true, "chunkdata": true}

type ExecuteRequest struct {
	Chunks    [][2]int `json:"chunks"`
	Cells     [][2]int `json:"cells"`
	CellKinds []string `json:"cellKinds"`
	Vehicles  bool     `json:"vehicles"`
	Trash     bool     `json:"trash"`
}

type ExecuteResult struct {
	CellFiles  int     `json:"cellFiles"`
	VehicleIDs []int64 `json:"vehicleIds"`
	Stamp      string  `json:"stamp"`
}

type job struct {
	s     store
	root  string
	batch string
	done  atomic.Int64
}

func (a *App) reportProgress(done *atomic.Int64, total int, stop chan struct{}) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			wailsruntime.EventsEmit(a.ctx, "progress", done.Load(), total)
		case <-stop:
			wailsruntime.EventsEmit(a.ctx, "progress", done.Load(), total)
			return
		}
	}
}

func (j *job) remote(parts ...string) string {
	return path.Join(append([]string{j.root}, parts...)...)
}

func (j *job) discard(parts ...string) (bool, error) {
	var err error
	if j.batch == "" {
		err = j.s.Remove(j.remote(parts...))
	} else {
		err = j.s.Rename(j.remote(parts...), path.Join(append([]string{j.batch}, parts...)...))
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (a *App) Execute(req ExecuteRequest) (ExecuteResult, error) {
	s, root, err := a.session("")
	if err != nil {
		return ExecuteResult{}, err
	}
	for _, kind := range req.CellKinds {
		if !cellKinds[kind] {
			return ExecuteResult{}, fmt.Errorf("Error: unknown cell file kind %q", kind)
		}
	}
	j := &job{s: s, root: root}
	var result ExecuteResult
	if req.Trash {
		result.Stamp = time.Now().Format("2006-01-02_15-04-05")
		_, j.batch, _ = a.session(path.Join(trashDir, result.Stamp))
		if err := s.MkdirAll(j.batch); err != nil {
			return result, named(err)
		}
	}
	stop := make(chan struct{})
	defer close(stop)
	go a.reportProgress(&j.done, len(req.Chunks)+len(req.Cells)*len(req.CellKinds), stop)
	if req.Vehicles {
		result.VehicleIDs, err = j.deleteVehicles(req.Chunks)
		if err != nil {
			return result, named(err)
		}
	}
	if err := j.deleteChunks(req.Chunks); err != nil {
		return result, named(err)
	}
	result.CellFiles, err = j.deleteCellFiles(req.Cells, req.CellKinds)
	return result, named(err)
}

func (j *job) deleteChunks(chunks [][2]int) error {
	seen := map[int]bool{}
	var columns []int
	for _, c := range chunks {
		if !seen[c[0]] {
			seen[c[0]] = true
			columns = append(columns, c[0])
		}
	}
	if j.batch != "" {
		err := runPool(columns, fileWorkers, func(x int) error {
			return j.s.MkdirAll(path.Join(j.batch, "map", strconv.Itoa(x)))
		})
		if err != nil {
			return err
		}
	}
	err := runPool(chunks, fileWorkers, func(c [2]int) error {
		_, err := j.discard("map", strconv.Itoa(c[0]), strconv.Itoa(c[1])+".bin")
		j.done.Add(1)
		return err
	})
	if err != nil {
		return err
	}
	runPool(columns, fileWorkers, func(x int) error {
		j.s.Remove(j.remote("map", strconv.Itoa(x)))
		return nil
	})
	return nil
}

func (j *job) deleteCellFiles(cells [][2]int, kinds []string) (int, error) {
	var removed atomic.Int64
	for _, kind := range kinds {
		if j.batch != "" {
			if err := j.s.MkdirAll(path.Join(j.batch, kind)); err != nil {
				return 0, err
			}
		}
		err := runPool(cells, fileWorkers, func(c [2]int) error {
			gone, err := j.discard(kind, fmt.Sprintf("%s_%d_%d.bin", kind, c[0], c[1]))
			if gone {
				removed.Add(1)
			}
			j.done.Add(1)
			return err
		})
		if err != nil {
			return int(removed.Load()), err
		}
	}
	return int(removed.Load()), nil
}

func (j *job) deleteVehicles(chunks [][2]int) ([]int64, error) {
	journal, err := j.s.Stat(j.remote("vehicles.db-journal"))
	if err == nil && journal.Size > 0 {
		return nil, errors.New("vehicles.db has an unfinished write journal next to it. Start and stop the game once so it settles, then try again")
	}
	dir, err := os.MkdirTemp("", "pzcleaner-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	local := filepath.Join(dir, "vehicles.db")
	if err := j.download("vehicles.db", local); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	doomed := map[[2]int]bool{}
	for _, c := range chunks {
		doomed[c] = true
	}
	ids, err := editVehicles(local, doomed)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	fresh := j.remote("vehicles.db.pzcleaner-new")
	if err := j.upload(local, fresh); err != nil {
		return nil, err
	}
	backup := j.remote(vehiclesBackup)
	if j.batch != "" {
		backup = path.Join(j.batch, "vehicles.db")
	}
	if err := j.s.Replace(j.remote("vehicles.db"), backup); err != nil {
		return nil, err
	}
	return ids, j.s.Rename(fresh, j.remote("vehicles.db"))
}

func (j *job) download(name, local string) error {
	src, err := j.s.Open(j.remote(name))
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.Create(local)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

func (j *job) upload(local, remote string) error {
	src, err := os.Open(local)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := j.s.Create(remote)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

func editVehicles(local string, doomed map[[2]int]bool) ([]int64, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(local))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var table string
	err = db.QueryRow("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vehicles'").Scan(&table)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := db.Query("SELECT id, wx, wy FROM vehicles")
	if err != nil {
		return nil, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		var wx, wy int
		if err := rows.Scan(&id, &wx, &wy); err != nil {
			rows.Close()
			return nil, err
		}
		if doomed[[2]int{wx, wy}] {
			ids = append(ids, id)
		}
	}
	if err := rows.Close(); err != nil || len(ids) == 0 {
		return nil, err
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, err := tx.Exec("DELETE FROM vehicles WHERE id = ?", id); err != nil {
			tx.Rollback()
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	var check string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&check); err != nil {
		return nil, err
	}
	if check != "ok" {
		return nil, errors.New("vehicles.db failed its integrity check after the edit, so it was left as it was")
	}
	return ids, nil
}

func (a *App) Restore(stamp string) (int, error) {
	s, batch, err := a.session(path.Join(trashDir, stamp))
	if err != nil {
		return 0, err
	}
	_, root, _ := a.session("")
	_, backup, _ := a.session(trashDir)
	files, levels, err := walk(s, batch)
	if err != nil {
		return 0, named(err)
	}
	for _, level := range levels[1:] {
		err := runPool(level, fileWorkers, func(dir string) error {
			return s.MkdirAll(root + strings.TrimPrefix(dir, batch))
		})
		if err != nil {
			return 0, named(err)
		}
	}
	var done atomic.Int64
	stop := make(chan struct{})
	go a.reportProgress(&done, len(files), stop)
	err = runPool(files, fileWorkers, func(file string) error {
		err := s.Replace(file, root+strings.TrimPrefix(file, batch))
		done.Add(1)
		return err
	})
	close(stop)
	if err != nil {
		return 0, named(err)
	}
	if err := removeTree(s, batch); err != nil {
		return len(files), named(err)
	}
	if err := s.Remove(batch); err != nil {
		return len(files), named(err)
	}
	if left, err := s.ReadDir(backup); err == nil && len(left) == 0 {
		s.Remove(backup)
	}
	return len(files), nil
}
