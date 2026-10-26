#!/bin/sh
set -eu
src=${1:-/opt/ib-gametools/projectzomboid/pzchunkcleaner}
cd "$(dirname "$0")/site"
for dir in css js vendor img brand tokens; do
    rm -rf "$dir"
    cp -r "$src/$dir" "$dir"
done
sed 's#<script type="module" src="js/app.js"></script>#<script src="desktop.js"></script>\n&#' "$src/index.html" > index.html
grep -q 'src="desktop.js"' index.html
sed -i -f - index.html <<'SED'
s#files move to a trash folder, <code>_pzcleaner_trash</code> in the save folder, so#files move to a trash folder, <code>pzcleaner-backup</code> in the Zomboid folder beside <code>Saves</code>, so#
s#Pick the folder that holds <code>map_meta.bin</code>. Your browser asks for permission to edit it. The files are read and deleted on your computer, nothing is uploaded.#Log in with your server's SFTP details, or pick a save folder on this computer. It's the folder that holds <code>map_meta.bin</code>.#
s#remembered in this browser for a save folder#remembered on this computer for a save folder#
s#Download <code>Zomboid/Saves/Multiplayer/\&lt;server name\&gt;</code> with your host's file manager or SFTP, clean it here, then upload it back over the original.#Open a save and log in with the SFTP details from your host's panel. The save is <code>Zomboid/Saves/Multiplayer/\&lt;server name\&gt;</code>, and on some hosts the Zomboid folder has another name, such as <code>server-data</code>.#
SED
for text in 'Delete for good (faster)' '<code>pzcleaner-backup</code> in the Zomboid folder' "Log in with your server's SFTP details" 'remembered on this computer' 'log in with the SFTP details from your host'; do
    grep -q "$text" index.html
done
sed -i 's/^export async function executePlan(/async function executePlanInBrowser(/; s/^export async function restoreTrash(/async function restoreTrashInBrowser(/; s/^async function scanChunks(/async function scanChunksInBrowser(/' js/save.js
grep -q '^async function executePlanInBrowser(save, plan, useTrash, onProgress)' js/save.js
grep -q '^async function scanChunksInBrowser(mapDir, chunks, onProgress)' js/save.js
grep -q '^async function restoreTrashInBrowser(root, stamp, onProgress)' js/save.js
cat >> js/save.js <<'JS'

async function scanChunks(mapDir, chunks, onProgress) {
    return window.pzDesktop.scanChunks(mapDir, chunks, onProgress, packXY);
}

export async function executePlan(save, plan, useTrash, onProgress) {
    return window.pzDesktop.executePlan(save, plan, useTrash, onProgress, { boundsOf, listTrash, unpackX, unpackY });
}

export async function restoreTrash(root, stamp, onProgress) {
    return window.pzDesktop.restoreTrash(stamp, onProgress);
}
JS
