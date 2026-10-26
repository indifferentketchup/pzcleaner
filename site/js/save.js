import { readLivingPlayers, readVehicles, removeVehicles, writeBytes } from './db.js';
import { CELL_CHUNKS, packXY, unpackX, unpackY, rectContains } from './format.js';
import { parseSafehouses } from './meta.js';

const TRASH_DIR = '_pzcleaner_trash';
const VEHICLES_BACKUP = 'vehicles.db.pzcleaner-bak';
const CHUNK = /^(-?\d+)\.bin$/;
const DIR_NAME = /^-?\d+$/;
const SCAN_WORKERS = 64;
const DELETE_WORKERS = 16;
const FILE_WORKERS = 32;

async function getDirectory(parent, name) {
    try {
        return await parent.getDirectoryHandle(name);
    } catch (error) {
        if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') {
            return null;
        }
        throw error;
    }
}

async function runPool(items, workers, task) {
    let next = 0;
    async function drain() {
        while (next < items.length) {
            const index = next++;
            await task(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, drain));
}

async function listColumns(mapDir) {
    const columns = [];
    for await (const [name, handle] of mapDir.entries()) {
        if (handle.kind === 'directory' && DIR_NAME.test(name)) {
            columns.push({ x: Number(name), handle });
        }
    }
    return columns;
}

async function scanChunksInBrowser(mapDir, chunks, onProgress) {
    const columns = await listColumns(mapDir);
    let done = 0;
    await runPool(columns, SCAN_WORKERS, async function (column) {
        for await (const name of column.handle.keys()) {
            const match = CHUNK.exec(name);
            if (match) {
                chunks.add(packXY(column.x, Number(match[1])));
            }
        }
        done++;
        onProgress(done, columns.length);
    });
}

async function readSafehouses(root) {
    const file = await (await root.getFileHandle('map_meta.bin')).getFile();
    return parseSafehouses(await file.arrayBuffer());
}

async function readListOrError(read, root) {
    try {
        return { list: await read(root), error: null };
    } catch (error) {
        return { list: [], error };
    }
}

function boundsOf(chunks) {
    if (chunks.size === 0) {
        return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const key of chunks) {
        const x = unpackX(key);
        const y = unpackY(key);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

async function listTrash(root) {
    const trash = await getDirectory(root, TRASH_DIR);
    if (!trash) {
        return [];
    }
    const stamps = [];
    for await (const [name, handle] of trash.entries()) {
        if (handle.kind === 'directory') {
            stamps.push(name);
        }
    }
    return stamps.sort();
}

export async function openSave(root, onProgress) {
    const chunks = new Set();
    const mapDir = await getDirectory(root, 'map');
    if (mapDir) {
        await scanChunks(mapDir, chunks, onProgress);
    }
    const trash = await listTrash(root);
    if (chunks.size === 0 && trash.length === 0) {
        throw new Error(
            'No Build 42 chunk files in that folder. Pick the save folder itself, the one holding map_meta.bin and a map folder.',
        );
    }
    return {
        root,
        mapDir,
        chunks,
        bounds: boundsOf(chunks),
        safehouses: await readListOrError(readSafehouses, root),
        players: await readListOrError(readLivingPlayers, root),
        vehicles: await readListOrError(readVehicles, root),
        trash,
    };
}

function isSelected(selection, x, y) {
    for (const rect of selection.protectedRects) {
        if (rectContains(rect, x, y)) {
            return false;
        }
    }
    const inside = selection.rects.some(function (rect) {
        return rectContains(rect, x, y);
    });
    if (selection.inverted) {
        return !inside;
    }
    return inside;
}

export function buildPlan(save, selection, options) {
    const chunks = new Set();
    const touchedCells = new Set();
    const keptCells = new Set();
    if (selection.rects.length > 0) {
        for (const key of save.chunks) {
            const x = unpackX(key);
            const y = unpackY(key);
            const cell = packXY(Math.floor(x / CELL_CHUNKS), Math.floor(y / CELL_CHUNKS));
            if (isSelected(selection, x, y)) {
                chunks.add(key);
                touchedCells.add(cell);
            } else {
                keptCells.add(cell);
            }
        }
    }
    const clearedCells = [...touchedCells].filter(function (cell) {
        return !keptCells.has(cell);
    });
    let vehicleCount = 0;
    if (options.vehicles) {
        for (const vehicle of save.vehicles.list) {
            if (chunks.has(packXY(vehicle.wx, vehicle.wy))) {
                vehicleCount++;
            }
        }
    }
    return { chunks, clearedCells, cellKinds: options.cellKinds, vehicleCount };
}

async function removeIfPresent(dir, name, recursive) {
    try {
        await dir.removeEntry(name, { recursive });
        return true;
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return false;
        }
        throw error;
    }
}

async function hasFile(dir, name) {
    try {
        await dir.getFileHandle(name);
        return true;
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return false;
        }
        throw error;
    }
}

async function moveEntry(fromDir, name, toDir, overwrite) {
    let handle;
    try {
        handle = await fromDir.getFileHandle(name);
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return false;
        }
        throw error;
    }
    if (overwrite) {
        await removeIfPresent(toDir, name);
    }
    if (typeof handle.move === 'function') {
        try {
            await handle.move(toDir, name);
            return true;
        } catch {
            if (!(await hasFile(fromDir, name))) {
                return false;
            }
        }
    }
    try {
        const file = await handle.getFile();
        await writeBytes(toDir, name, await file.arrayBuffer());
        await fromDir.removeEntry(name);
        return true;
    } catch (error) {
        if (error.name === 'NotFoundError' && !(await hasFile(fromDir, name))) {
            return false;
        }
        throw error;
    }
}

function padTwo(value) {
    return String(value).padStart(2, '0');
}

function stampNow() {
    const now = new Date();
    const day = `${now.getFullYear()}-${padTwo(now.getMonth() + 1)}-${padTwo(now.getDate())}`;
    return `${day}_${padTwo(now.getHours())}-${padTwo(now.getMinutes())}-${padTwo(now.getSeconds())}`;
}

class Trash {
    constructor(root, stamp) {
        this.root = root;
        this.stamp = stamp;
        this.dirs = new Map();
    }

    dir(parts) {
        const key = parts.join('/');
        if (!this.dirs.has(key)) {
            this.dirs.set(key, this.open([TRASH_DIR, this.stamp, ...parts]));
        }
        return this.dirs.get(key);
    }

    async open(parts) {
        let dir = this.root;
        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, { create: true });
        }
        return dir;
    }

    async take(fromDir, name, parts) {
        return moveEntry(fromDir, name, await this.dir(parts), false);
    }
}

function discard(trash, dir, name, parts) {
    if (trash) {
        return trash.take(dir, name, parts);
    }
    return removeIfPresent(dir, name);
}

async function holdsOnlyChunks(dir) {
    for await (const name of dir.keys()) {
        if (!CHUNK.test(name)) {
            return false;
        }
    }
    return true;
}

async function deleteChunks(save, keys, trash, tick) {
    const columns = new Map();
    for (const key of keys) {
        const x = unpackX(key);
        if (!columns.has(x)) {
            columns.set(x, []);
        }
        columns.get(x).push(key);
    }
    const saved = new Map();
    for (const key of save.chunks) {
        const x = unpackX(key);
        saved.set(x, (saved.get(x) || 0) + 1);
    }
    if (trash) {
        await trash.dir(['map']);
    }
    const files = [];
    await runPool([...columns], SCAN_WORKERS, async function ([x, columnKeys]) {
        const dir = await getDirectory(save.mapDir, String(x));
        if (dir && !trash && columnKeys.length === saved.get(x) && (await holdsOnlyChunks(dir))) {
            await removeIfPresent(save.mapDir, String(x), true);
            for (const key of columnKeys) {
                save.chunks.delete(key);
            }
            tick(columnKeys.length);
            return;
        }
        for (const key of columnKeys) {
            files.push({ dir, key, x });
        }
    });
    await runPool(files, FILE_WORKERS, async function ({ dir, key, x }) {
        if (dir) {
            await discard(trash, dir, `${unpackY(key)}.bin`, ['map', String(x)]);
        }
        save.chunks.delete(key);
        tick(1);
    });
}

async function deleteCellFiles(save, plan, trash, tick) {
    let removed = 0;
    for (const kind of plan.cellKinds) {
        const dir = await getDirectory(save.root, kind);
        await runPool(plan.clearedCells, DELETE_WORKERS, async function (cell) {
            const name = `${kind}_${unpackX(cell)}_${unpackY(cell)}.bin`;
            if (dir && (await discard(trash, dir, name, [kind]))) {
                removed++;
            }
            tick(1);
        });
    }
    return removed;
}

async function deleteVehicles(save, plan, trash) {
    if (plan.vehicleCount === 0) {
        return 0;
    }
    const ids = await removeVehicles(save.root, plan.chunks, async function (original) {
        if (trash) {
            await writeBytes(await trash.dir([]), 'vehicles.db', original);
        } else {
            await writeBytes(save.root, VEHICLES_BACKUP, original);
        }
    });
    const gone = new Set(ids);
    save.vehicles.list = save.vehicles.list.filter(function (vehicle) {
        return !gone.has(vehicle.id);
    });
    return ids.length;
}

async function executePlanInBrowser(save, plan, useTrash, onProgress) {
    let trash = null;
    if (useTrash) {
        trash = new Trash(save.root, stampNow());
    }
    const total = plan.chunks.size + plan.clearedCells.length * plan.cellKinds.length;
    let done = 0;
    let reported = 0;
    function tick(count) {
        done += count;
        if (done - reported >= 200 || done === total) {
            reported = done;
            onProgress(done, total);
        }
    }
    const vehicles = await deleteVehicles(save, plan, trash);
    await deleteChunks(save, plan.chunks, trash, tick);
    const cellFiles = await deleteCellFiles(save, plan, trash, tick);
    save.bounds = boundsOf(save.chunks);
    let trashStamp = null;
    if (trash) {
        save.trash = await listTrash(save.root);
        trashStamp = trash.stamp;
    }
    return { chunks: plan.chunks.size, cellFiles, vehicles, trashStamp };
}

async function restoreTree(fromDir, toDir, tick) {
    const entries = [];
    for await (const entry of fromDir.entries()) {
        entries.push(entry);
    }
    const files = [];
    for (const [name, handle] of entries) {
        if (handle.kind === 'directory') {
            await restoreTree(handle, await toDir.getDirectoryHandle(name, { create: true }), tick);
        } else {
            files.push(name);
        }
    }
    await runPool(files, FILE_WORKERS, async function (name) {
        await moveEntry(fromDir, name, toDir, true);
        tick();
    });
}

async function restoreTrashInBrowser(root, stamp, onProgress) {
    const trash = await root.getDirectoryHandle(TRASH_DIR);
    const batch = await trash.getDirectoryHandle(stamp);
    let done = 0;
    await restoreTree(batch, root, function () {
        done++;
        if (done % 200 === 0) {
            onProgress(done);
        }
    });
    await trash.removeEntry(stamp, { recursive: true });
    if ((await listTrash(root)).length === 0) {
        await root.removeEntry(TRASH_DIR, { recursive: true });
    }
    return done;
}

export async function emptyTrash(root) {
    await root.removeEntry(TRASH_DIR, { recursive: true });
}

async function scanChunks(mapDir, chunks, onProgress) {
    return window.pzDesktop.scanChunks(mapDir, chunks, onProgress, packXY);
}

export async function executePlan(save, plan, useTrash, onProgress) {
    return window.pzDesktop.executePlan(save, plan, useTrash, onProgress, { boundsOf, listTrash, unpackX, unpackY });
}

export async function restoreTrash(root, stamp, onProgress) {
    return window.pzDesktop.restoreTrash(stamp, onProgress);
}
