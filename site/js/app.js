import { askConfirm, byId, setStatus, show, showError } from './dom.js';
import {
    CELL_CHUNKS,
    CHUNK_SQUARES,
    chunkRectBetween,
    rectContains,
    squaresToChunkRect,
} from './format.js';
import { MAP_H, MAP_W, MapView } from './mapview.js';
import { buildPlan, emptyTrash, executePlan, openSave, restoreTrash } from './save.js';
import { count, formatNumber, formatStamp, joinList } from './text.js';

const KEEP_STORE = 'pzcleaner.keep:';

const state = {
    save: null,
    rects: [],
    keeps: [],
    plan: null,
    busy: false,
};

const map = new MapView(byId('map'), addRect, showHover);

function paddingFrom(id) {
    return Math.max(0, Math.min(50, Number(byId(id).value) || 0));
}

function safehouseBoxes() {
    if (!byId('opt-safehouses').checked) {
        return [];
    }
    const padding = paddingFrom('opt-padding');
    return state.save.safehouses.list.map(function (house) {
        return {
            title: house.title,
            owner: house.owner,
            members: house.players.length,
            rect: squaresToChunkRect(house.x, house.y, house.w, house.h, padding),
        };
    });
}

function playerRects() {
    if (!byId('opt-players').checked) {
        return [];
    }
    const padding = paddingFrom('opt-player-padding');
    return state.save.players.list.map(function (player) {
        return squaresToChunkRect(player.x, player.y, 1, 1, padding);
    });
}

function currentView() {
    const safehouses = safehouseBoxes();
    const players = playerRects();
    const keepRects = state.keeps.map(function (keep) {
        return keep.rect;
    });
    const safehouseRects = safehouses.map(function (house) {
        return house.rect;
    });
    const selection = {
        rects: state.rects,
        inverted: byId('opt-invert').checked,
        protectedRects: [...safehouseRects, ...players, ...keepRects],
    };
    return { selection, overlays: { safehouses, keepRects, playerRects: players } };
}

function planOptions() {
    const cellKinds = [];
    for (const input of document.querySelectorAll('[data-cell-kind]')) {
        if (input.checked) {
            cellKinds.push(input.dataset.cellKind);
        }
    }
    return { cellKinds, vehicles: byId('opt-vehicles').checked };
}

function hoverSubject(x, y) {
    const chunkX = Math.floor(x / CHUNK_SQUARES);
    const chunkY = Math.floor(y / CHUNK_SQUARES);
    const house = safehouseBoxes().find(function (entry) {
        return rectContains(entry.rect, chunkX, chunkY);
    });
    if (!house) {
        return '';
    }
    return `${house.title}, owner ${house.owner}, ${count(house.members, 'member')}`;
}

function showHover(worldX, worldY) {
    const x = Math.floor(worldX);
    const y = Math.floor(worldY);
    const chunkX = Math.floor(x / CHUNK_SQUARES);
    const chunkY = Math.floor(y / CHUNK_SQUARES);
    const cellX = Math.floor(chunkX / CELL_CHUNKS);
    const cellY = Math.floor(chunkY / CELL_CHUNKS);
    const parts = [`x ${x}, y ${y}`, `chunk ${chunkX},${chunkY}`, `cell ${cellX},${cellY}`];
    const subject = hoverSubject(worldX, worldY);
    if (subject) {
        parts.push(subject);
    }
    byId('hover').textContent = parts.join(' · ');
}

function describeRect(rect) {
    const x0 = rect.x0 * CHUNK_SQUARES;
    const x1 = rect.x1 * CHUNK_SQUARES - 1;
    const y0 = rect.y0 * CHUNK_SQUARES;
    const y1 = rect.y1 * CHUNK_SQUARES - 1;
    return `x ${x0} to ${x1}, y ${y0} to ${y1}`;
}

function removeButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost small';
    button.textContent = 'Remove';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
}

function renderLists() {
    byId('box-list').replaceChildren();
    state.rects.forEach(function (rect, index) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `delete: ${describeRect(rect)}`;
        item.append(
            label,
            removeButton(`Remove delete box ${describeRect(rect)}`, function () {
                state.rects.splice(index, 1);
                refresh();
            }),
        );
        byId('box-list').append(item);
    });
    byId('keep-list').replaceChildren();
    state.keeps.forEach(function (keep, index) {
        const item = document.createElement('li');
        const what = document.createElement('span');
        what.className = 'box-what';
        const name = document.createElement('input');
        name.className = 'field small';
        name.value = keep.name;
        name.setAttribute('aria-label', `Name for keep box ${describeRect(keep.rect)}`);
        name.addEventListener('change', function () {
            keep.name = name.value;
            storeKeeps();
        });
        const where = document.createElement('span');
        where.textContent = `keep: ${describeRect(keep.rect)}`;
        what.append(name, where);
        item.append(
            what,
            removeButton(`Remove keep box ${keep.name}`, function () {
                state.keeps.splice(index, 1);
                storeKeeps();
                refresh();
            }),
        );
        byId('keep-list').append(item);
    });
}

function keepKey() {
    return `${KEEP_STORE}${state.save.root.name}`;
}

function storeKeeps() {
    localStorage.setItem(keepKey(), JSON.stringify(state.keeps));
}

function loadKeeps() {
    try {
        const stored = JSON.parse(localStorage.getItem(keepKey()) || '[]');
        return stored.filter(function (keep) {
            return (
                keep && keep.rect && Number.isFinite(keep.rect.x0) && typeof keep.name === 'string'
            );
        });
    } catch {
        return [];
    }
}

function planParts(plan, trashed) {
    const cellFiles = plan.clearedCells.length * plan.cellKinds.length;
    const parts = [
        `${count(plan.chunks.size, 'chunk')} out of ${formatNumber(state.save.chunks.size)}`,
    ];
    if (cellFiles > 0) {
        const cells = count(plan.clearedCells.length, 'cell');
        parts.push(`up to ${count(cellFiles, 'cellFile')} for the ${cells} left empty`);
    }
    if (plan.vehicleCount > 0) {
        parts.push(count(plan.vehicleCount, 'vehicle'));
    }
    if (trashed) {
        return `This moves to the trash ${joinList(parts)}.`;
    }
    return `This deletes ${joinList(parts)}.`;
}

function unreadProtection() {
    const save = state.save;
    if (byId('opt-safehouses').checked && save.safehouses.error) {
        return `map_meta.bin could not be read (${save.safehouses.error.message}), so the safehouses can't be protected. Untick "Claimed safehouses" to delete without that protection.`;
    }
    if (byId('opt-players').checked && save.players.error) {
        return `players.db could not be read (${save.players.error.message}), so the players can't be protected. Untick "Where living players last stood" to delete without that protection.`;
    }
    return '';
}

function summaryText(plan) {
    if (state.rects.length === 0) {
        return 'Draw a delete box on the map to choose what to reset.';
    }
    if (plan.chunks.size === 0) {
        return 'Nothing to delete: no saved chunks fall inside that selection.';
    }
    return planParts(plan, !byId('opt-forever').checked);
}

function renderTrash() {
    const batches = state.save.trash;
    show(byId('trash'), batches.length > 0);
    if (batches.length === 0) {
        return;
    }
    const latest = formatStamp(batches.at(-1));
    byId('trash-text').textContent =
        `The trash folder holds ${count(batches.length, 'batch')}. The latest is from ${latest}.`;
    byId('btn-restore').disabled = state.busy;
    byId('btn-empty').disabled = state.busy;
}

function refresh() {
    renderTrash();
    if (byId('opt-forever').checked) {
        byId('btn-delete').textContent = 'Delete files';
    } else {
        byId('btn-delete').textContent = 'Move files to trash';
    }
    if (state.save.chunks.size === 0) {
        byId('summary').textContent = 'This save has no chunk files left.';
        byId('btn-delete').disabled = true;
        return;
    }
    const { selection, overlays } = currentView();
    state.plan = buildPlan(state.save, selection, planOptions());
    map.setSelection(selection, state.plan.chunks, overlays);
    renderLists();
    const problem = unreadProtection();
    if (problem) {
        byId('summary').textContent = problem;
        byId('btn-delete').disabled = true;
        return;
    }
    byId('summary').textContent = summaryText(state.plan);
    byId('btn-delete').disabled = state.busy || state.plan.chunks.size === 0;
}

function addRect(rect, tool) {
    if (tool === 'keep') {
        state.keeps.push({ name: `Keep box ${state.keeps.length + 1}`, rect });
        storeKeeps();
    } else {
        state.rects.push(rect);
    }
    refresh();
}

function sourceFact(source, noun) {
    if (source.error) {
        return `could not be read (${source.error.message})`;
    }
    return count(source.list.length, noun);
}

function renderFacts() {
    const save = state.save;
    const rows = [
        ['format', 'Build 42'],
        ['saved chunks', formatNumber(save.chunks.size)],
        ['explored area', describeRect(save.bounds)],
        ['safehouses', sourceFact(save.safehouses, 'safehouse')],
        ['players', sourceFact(save.players, 'player')],
        ['vehicles', sourceFact(save.vehicles, 'vehicle')],
    ];
    byId('facts').replaceChildren();
    for (const [term, detail] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = detail;
        byId('facts').append(dt, dd);
    }
}

function showSave() {
    const hasChunks = state.save.chunks.size > 0;
    show(byId('workspace'), hasChunks);
    show(byId('commit'), true);
    if (hasChunks) {
        renderFacts();
        map.resize();
        map.setSave(state.save);
    }
    refresh();
}

async function loadSave(root) {
    byId('btn-open').disabled = true;
    setStatus(byId('scan-status'), 'reading the folder', true);
    try {
        state.save = await openSave(root, function (done, total) {
            const progress = `${formatNumber(done)} of ${formatNumber(total)}`;
            setStatus(byId('scan-status'), `reading map folders, ${progress}`, true);
        });
    } catch (error) {
        setStatus(byId('scan-status'), '', false);
        showError(byId('open-error'), error.message);
        byId('btn-open').disabled = false;
        return;
    }
    byId('btn-open').disabled = false;
    state.rects = [];
    state.keeps = loadKeeps();
    setStatus(
        byId('scan-status'),
        `${root.name}: ${count(state.save.chunks.size, 'chunk')}`,
        false,
    );
    showSave();
}

async function chooseFolder() {
    showError(byId('open-error'), '');
    let root;
    try {
        root = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (error) {
        if (error.name !== 'AbortError') {
            showError(byId('open-error'), `Could not open the folder: ${error.message}`);
        }
        return;
    }
    setStatus(byId('delete-status'), '', false);
    setStatus(byId('trash-status'), '', false);
    await loadSave(root);
}

function confirmDelete(plan, useTrash) {
    const where = `"${state.save.root.name}"`;
    if (useTrash) {
        return askConfirm(
            'Move these files to the trash?',
            `${planParts(plan, true)} Folder: ${where}.`,
            'You can put them back from the trash until you empty it. Make sure the server is stopped.',
            'Move to trash',
        );
    }
    return askConfirm(
        'Delete these files?',
        `${planParts(plan, false)} Folder: ${where}.`,
        "This can't be undone from here. Make sure the server is stopped and you have a backup.",
        'Delete',
    );
}

function setBusy(busy) {
    state.busy = busy;
    for (const id of ['btn-open', 'btn-delete', 'btn-restore', 'btn-empty']) {
        byId(id).disabled = busy;
    }
}

function resultText(result) {
    const parts = [count(result.chunks, 'chunk'), count(result.cellFiles, 'cellFile')];
    if (result.vehicles > 0) {
        parts.push(count(result.vehicles, 'vehicle'));
    }
    if (result.trashStamp) {
        return `moved to the trash: ${joinList(parts)}`;
    }
    return `deleted: ${joinList(parts)}`;
}

async function runDelete() {
    const plan = state.plan;
    const useTrash = !byId('opt-forever').checked;
    if (!plan || plan.chunks.size === 0 || !(await confirmDelete(plan, useTrash))) {
        return;
    }
    showError(byId('delete-error'), '');
    setStatus(byId('trash-status'), '', false);
    setBusy(true);
    try {
        const result = await executePlan(state.save, plan, useTrash, function (done, total) {
            const progress = `${formatNumber(done)} of ${formatNumber(total)}`;
            setStatus(byId('delete-status'), `working, ${progress}`, true);
        });
        setStatus(byId('delete-status'), resultText(result), false);
        state.rects = [];
    } catch (error) {
        setStatus(byId('delete-status'), '', false);
        showError(
            byId('delete-error'),
            `Stopped: ${error.message} Anything already removed stays removed. Open the folder again to see what is left.`,
        );
    }
    setBusy(false);
    showSave();
}

async function runRestore() {
    const stamp = state.save.trash.at(-1);
    const ok = await askConfirm(
        'Put the latest batch back?',
        `Everything in the trash batch from ${formatStamp(stamp)} moves back into "${state.save.root.name}".`,
        'Files with the same name are replaced, including vehicles.db if that batch holds one. Make sure the server is stopped.',
        'Put back',
    );
    if (!ok) {
        return;
    }
    setBusy(true);
    showError(byId('delete-error'), '');
    setStatus(byId('delete-status'), '', false);
    try {
        const moved = await restoreTrash(state.save.root, stamp, function (done) {
            setStatus(byId('trash-status'), `putting back, ${formatNumber(done)}`, true);
        });
        setStatus(byId('trash-status'), `put back ${count(moved, 'file')}`, false);
    } catch (error) {
        setStatus(byId('trash-status'), '', false);
        showError(byId('delete-error'), `Restore stopped: ${error.message}`);
    }
    setBusy(false);
    await loadSave(state.save.root);
}

async function runEmpty() {
    const ok = await askConfirm(
        'Empty the trash for good?',
        `${count(state.save.trash.length, 'batch')} in "${state.save.root.name}" will be deleted.`,
        "This can't be undone.",
        'Empty trash',
    );
    if (!ok) {
        return;
    }
    setBusy(true);
    showError(byId('delete-error'), '');
    try {
        await emptyTrash(state.save.root);
        state.save.trash = [];
        setStatus(byId('trash-status'), '', false);
    } catch (error) {
        showError(byId('delete-error'), `Could not empty the trash: ${error.message}`);
    }
    setBusy(false);
    refresh();
}

function addRectFromForm(event) {
    event.preventDefault();
    const from = { x: Number(byId('box-x0').value), y: Number(byId('box-y0').value) };
    const to = { x: Number(byId('box-x1').value), y: Number(byId('box-y1').value) };
    addRect(chunkRectBetween(from, to), 'select');
    event.target.reset();
}

function boxWholeMap() {
    const { x0, y0, x1, y1 } = state.save.bounds;
    const rect = {
        x0: Math.min(0, x0),
        y0: Math.min(0, y0),
        x1: Math.max(MAP_W / CHUNK_SQUARES, x1),
        y1: Math.max(MAP_H / CHUNK_SQUARES, y1),
    };
    addRect(rect, 'select');
}

function setTool(tool) {
    map.setTool(tool);
    for (const name of ['select', 'keep', 'pan']) {
        const button = byId(`tool-${name}`);
        const active = name === tool;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('btn-secondary', active);
        button.classList.toggle('btn-ghost', !active);
    }
}

function init() {
    byId('menu-open').addEventListener('click', function () {
        show(byId('mobile-menu'), true);
    });
    for (const id of ['menu-close', 'menu-overlay']) {
        byId(id).addEventListener('click', function () {
            show(byId('mobile-menu'), false);
        });
    }
    if (typeof window.showDirectoryPicker !== 'function') {
        show(byId('unsupported'), true);
        byId('btn-open').disabled = true;
        return;
    }
    byId('btn-open').addEventListener('click', chooseFolder);
    byId('btn-delete').addEventListener('click', runDelete);
    byId('btn-restore').addEventListener('click', runRestore);
    byId('btn-empty').addEventListener('click', runEmpty);
    byId('btn-everything').addEventListener('click', boxWholeMap);
    byId('box-form').addEventListener('submit', addRectFromForm);
    for (const tool of ['select', 'keep', 'pan']) {
        byId(`tool-${tool}`).addEventListener('click', function () {
            setTool(tool);
        });
    }
    byId('zoom-in').addEventListener('click', function () {
        map.zoomBy(1.5);
    });
    byId('zoom-out').addEventListener('click', function () {
        map.zoomBy(1 / 1.5);
    });
    byId('zoom-fit').addEventListener('click', function () {
        map.fit();
    });
    for (const answer of ['cancel', 'ok']) {
        byId(`confirm-${answer}`).addEventListener('click', function () {
            byId('confirm').close(answer);
        });
    }
    for (const input of document.querySelectorAll('.options input')) {
        input.addEventListener('change', refresh);
    }
}

init();
