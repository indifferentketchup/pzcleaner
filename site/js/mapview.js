import { CELL_CHUNKS, CHUNK_SQUARES, chunkRectBetween, unpackX, unpackY } from './format.js';

export const MAP_W = 78 * 256;
export const MAP_H = 63 * 256;
const ZOOM_STEP = 1.2;
const MIN_SCALE = 0.01;
const MAX_SCALE = 16;
const GRID_MIN_CELL_PX = 24;
const MIN_DRAG_PX = 4;

function cssColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

export class MapView {
    constructor(canvas, onBox, onHover) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onBox = onBox;
        this.onHover = onHover;
        this.save = null;
        this.selection = null;
        this.doomed = new Set();
        this.overlays = { safehouses: [], keepRects: [], playerRects: [] };
        this.tool = 'select';
        this.scale = 1;
        this.originX = 0;
        this.originY = 0;
        this.drag = null;
        this.layer = document.createElement('canvas');
        this.background = new Image();
        this.background.src = 'img/worldmap.png';
        this.background.addEventListener('load', this.draw.bind(this));
        this.colors = {
            canvas: cssColor('--bg-inset'),
            grid: cssColor('--border'),
            box: cssColor('--red'),
            guard: cssColor('--info'),
            keep: cssColor('--org-mark'),
            player: cssColor('--warning'),
            kept: rgba(cssColor('--org-mark'), 140),
            doomed: rgba(cssColor('--red'), 200),
        };
        new ResizeObserver(this.resize.bind(this)).observe(canvas);
        canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
        canvas.addEventListener('pointerdown', this.handleDown.bind(this));
        canvas.addEventListener('pointermove', this.handleMove.bind(this));
        canvas.addEventListener('pointerup', this.handleUp.bind(this));
        canvas.addEventListener('pointercancel', this.cancelDrag.bind(this));
        canvas.addEventListener('contextmenu', function (event) {
            event.preventDefault();
        });
    }

    setSave(save) {
        this.save = save;
        this.fit();
    }

    setSelection(selection, doomed, overlays) {
        this.selection = selection;
        this.doomed = doomed;
        this.overlays = overlays;
        this.paintLayer();
        this.draw();
    }

    setTool(tool) {
        this.tool = tool;
        this.canvas.dataset.tool = tool;
    }

    resize() {
        const ratio = window.devicePixelRatio || 1;
        const { width, height } = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.round(width * ratio);
        this.canvas.height = Math.round(height * ratio);
        this.ratio = ratio;
        this.draw();
    }

    fit() {
        if (!this.save || !this.save.bounds) {
            return;
        }
        const { x0, y0, x1, y1 } = this.save.bounds;
        const { width, height } = this.canvas.getBoundingClientRect();
        const worldW = (x1 - x0) * CHUNK_SQUARES;
        const worldH = (y1 - y0) * CHUNK_SQUARES;
        this.scale = Math.min(width / worldW, height / worldH) * 0.92;
        this.originX = x0 * CHUNK_SQUARES - (width / this.scale - worldW) / 2;
        this.originY = y0 * CHUNK_SQUARES - (height / this.scale - worldH) / 2;
        this.draw();
    }

    zoomBy(factor, pivotX, pivotY) {
        let px = pivotX;
        let py = pivotY;
        if (px === undefined) {
            const rect = this.canvas.getBoundingClientRect();
            px = rect.width / 2;
            py = rect.height / 2;
        }
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
        this.originX += px / this.scale - px / next;
        this.originY += py / this.scale - py / next;
        this.scale = next;
        this.draw();
    }

    paintLayer() {
        if (!this.save || !this.save.bounds || !this.selection) {
            this.layer.width = 0;
            return;
        }
        const { x0, y0, x1, y1 } = this.save.bounds;
        const width = x1 - x0;
        const height = y1 - y0;
        this.layer.width = width;
        this.layer.height = height;
        const context = this.layer.getContext('2d');
        const image = context.createImageData(width, height);
        for (const key of this.save.chunks) {
            const x = unpackX(key);
            const y = unpackY(key);
            let color = this.colors.kept;
            if (this.doomed.has(key)) {
                color = this.colors.doomed;
            }
            image.data.set(color, ((y - y0) * width + (x - x0)) * 4);
        }
        context.putImageData(image, 0, 0);
    }

    toScreen(worldX, worldY) {
        return [(worldX - this.originX) * this.scale, (worldY - this.originY) * this.scale];
    }

    toWorld(event) {
        const rect = this.canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        return { px, py, x: this.originX + px / this.scale, y: this.originY + py / this.scale };
    }

    draw() {
        const { ctx, canvas } = this;
        if (!this.ratio) {
            return;
        }
        ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
        ctx.fillStyle = this.colors.canvas;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!this.save) {
            return;
        }
        ctx.imageSmoothingEnabled = this.scale < 0.25;
        if (this.background.complete && this.background.naturalWidth > 0) {
            const [x, y] = this.toScreen(0, 0);
            ctx.drawImage(this.background, x, y, MAP_W * this.scale, MAP_H * this.scale);
        }
        this.drawChunks();
        this.drawGrid();
        this.drawBoxes();
    }

    drawChunks() {
        if (this.layer.width === 0 || !this.save.bounds) {
            return;
        }
        const { x0, y0 } = this.save.bounds;
        const [x, y] = this.toScreen(x0 * CHUNK_SQUARES, y0 * CHUNK_SQUARES);
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.drawImage(
            this.layer,
            x,
            y,
            this.layer.width * CHUNK_SQUARES * this.scale,
            this.layer.height * CHUNK_SQUARES * this.scale,
        );
    }

    drawGrid() {
        const cell = CELL_CHUNKS * CHUNK_SQUARES;
        if (cell * this.scale < GRID_MIN_CELL_PX) {
            return;
        }
        const { ctx } = this;
        const { width, height } = this.canvas.getBoundingClientRect();
        ctx.strokeStyle = this.colors.grid;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (
            let wx = Math.ceil(this.originX / cell) * cell;
            (wx - this.originX) * this.scale < width;
            wx += cell
        ) {
            const sx = Math.round((wx - this.originX) * this.scale) + 0.5;
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, height);
        }
        for (
            let wy = Math.ceil(this.originY / cell) * cell;
            (wy - this.originY) * this.scale < height;
            wy += cell
        ) {
            const sy = Math.round((wy - this.originY) * this.scale) + 0.5;
            ctx.moveTo(0, sy);
            ctx.lineTo(width, sy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    strokeChunkRect(rect, color, dashed) {
        const [x, y] = this.toScreen(rect.x0 * CHUNK_SQUARES, rect.y0 * CHUNK_SQUARES);
        const w = (rect.x1 - rect.x0) * CHUNK_SQUARES * this.scale;
        const h = (rect.y1 - rect.y0) * CHUNK_SQUARES * this.scale;
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        if (dashed) {
            this.ctx.setLineDash([6, 4]);
        }
        this.ctx.strokeRect(x, y, w, h);
        this.ctx.setLineDash([]);
    }

    drawBoxes() {
        if (!this.selection) {
            return;
        }
        for (const rect of this.overlays.playerRects) {
            this.strokeChunkRect(rect, this.colors.player, false);
        }
        for (const house of this.overlays.safehouses) {
            this.strokeChunkRect(house.rect, this.colors.guard, false);
        }
        for (const rect of this.overlays.keepRects) {
            this.strokeChunkRect(rect, this.colors.keep, false);
        }
        for (const rect of this.selection.rects) {
            this.strokeChunkRect(rect, this.colors.box, false);
        }
        if (this.drag && this.drag.rect) {
            let color = this.colors.box;
            if (this.drag.mode === 'keep') {
                color = this.colors.keep;
            }
            this.strokeChunkRect(this.drag.rect, color, true);
        }
    }

    handleWheel(event) {
        if (!this.save) {
            return;
        }
        event.preventDefault();
        const point = this.toWorld(event);
        let factor = 1 / ZOOM_STEP;
        if (event.deltaY < 0) {
            factor = ZOOM_STEP;
        }
        this.zoomBy(factor, point.px, point.py);
    }

    handleDown(event) {
        if (!this.save) {
            return;
        }
        let mode = this.tool;
        if (this.tool === 'pan' || event.button !== 0 || event.shiftKey) {
            mode = 'pan';
        }
        this.drag = { mode, start: this.toWorld(event), rect: null };
        this.canvas.setPointerCapture(event.pointerId);
    }

    handleMove(event) {
        if (!this.save) {
            return;
        }
        const point = this.toWorld(event);
        this.onHover(point.x, point.y);
        if (!this.drag) {
            return;
        }
        if (this.drag.mode === 'pan') {
            this.originX -= event.movementX / this.scale;
            this.originY -= event.movementY / this.scale;
        } else if (
            Math.hypot(point.px - this.drag.start.px, point.py - this.drag.start.py) >= MIN_DRAG_PX
        ) {
            this.drag.rect = chunkRectBetween(this.drag.start, point);
        }
        this.draw();
    }

    handleUp(event) {
        const drag = this.drag;
        this.cancelDrag();
        if (this.canvas.hasPointerCapture(event.pointerId)) {
            this.canvas.releasePointerCapture(event.pointerId);
        }
        if (drag && drag.rect) {
            this.onBox(drag.rect, drag.mode);
        }
    }

    cancelDrag() {
        this.drag = null;
        this.draw();
    }
}
