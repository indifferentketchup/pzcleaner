# pzcleaner

A desktop app version of [pzcleaner](https://pzcleaner.indifferentketchup.com).
It opens a save on a game server over SFTP, so a rented or dedicated
server's save can be reset without downloading and re-uploading it, or a
save folder on the computer it runs on.

The window shows the pzcleaner page itself: the same map, delete and keep
boxes, protections and options. The page reads the save through a stand-in
for the browser's folder handle (`site/desktop.js`). Indexing the chunk
files, the delete, the restore and emptying the backup run in Go
(`remote.go`, `execute.go`, `store.go`, one code path for SFTP and local
folders), listing up to 256 folders and moving or deleting up to 512 files
at once. On a rented server 28 ms away, a 1,030,592-chunk save indexes in
about 3 seconds and 51,000 files move in about 3 seconds.

Deleted files go to `pzcleaner-backup/<save name>/<date_time>/` in the
Zomboid folder, beside `Saves` (for example `/server-data/pzcleaner-backup/`
on a rented server), unless the backup option is unticked. "Put the latest
batch back" and "Empty the trash" work on that folder.

Stop the game server before deleting.

## Download

Builds are on the [releases page](https://github.com/indifferentketchup/pzcleaner/releases):
`pzcleaner-windows-amd64.exe`, `pzcleaner-x86_64.AppImage` for Linux (make it
executable, then run it) and `pzcleaner-macos.zip` (unsigned: right-click the
app and choose Open the first time). Pushing a `v*` tag builds them with
GitHub Actions (`.github/workflows/release.yml`).

## Run

- Linux: needs WebKitGTK 4.1. On Arch and CachyOS: `sudo pacman -S webkit2gtk-4.1`.
  On Debian and Ubuntu: `sudo apt install libwebkit2gtk-4.1-0`.
- Windows 10 and 11: needs the WebView2 runtime, which ships with them.
- macOS: has to be built on a Mac (Wails needs cgo and Xcode there). The
  app adds the standard app and Edit menus on macOS so copy and paste work.

It logs in with the SFTP host, port, user and password from the server
host's panel. No SSH keys or SSH setup are needed, and servers that only
accept keys are not supported. The first connection to a server shows its
host key fingerprint and remembers it once trusted, in `pzcleaner-gui/known_hosts`
under the user config folder (`~/.config` on Linux, `%AppData%` on Windows,
`~/Library/Application Support` on macOS). The password is never stored.

## Build

Go 1.27 and [Wails v2](https://wails.io) (as a Go module, the `wails` CLI
is not needed).

```bash
CGO_ENABLED=1 go build -tags desktop,production,webkit2_41 -trimpath -ldflags="-s -w" -o output/pzcleaner-gui-linux-amd64 .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags desktop,production -trimpath -ldflags="-s -w -H windowsgui" -o output/pzcleaner-gui-windows-amd64.exe .
```

The Linux build needs `libwebkit2gtk-4.1-dev` (Debian) or `webkit2gtk-4.1` (Arch).

## Updating the page

`site/` is a copy of the pzcleaner site from ib-gametools, apart from
`site/desktop.js`. Refresh it with:

```bash
./sync-site.sh /opt/ib-gametools/projectzomboid/pzchunkcleaner
```

The script adds the `desktop.js` script tag to `index.html`, rewords the
page where it talks about the browser or the trash location, and points `scanChunks`, `executePlan` and `restoreTrash`
in `js/save.js` at the Go side. It stops
with an error if those no longer match, which means the site changed
shape and the script needs a look.
