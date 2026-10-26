export const CHUNK_SQUARES = 8;
export const CELL_CHUNKS = 32;

const BIAS = 32768;
const SPAN = 65536;

export function packXY(x, y) {
    return (x + BIAS) * SPAN + (y + BIAS);
}

export function unpackX(key) {
    return Math.floor(key / SPAN) - BIAS;
}

export function unpackY(key) {
    return (key % SPAN) - BIAS;
}

export function rectContains(rect, x, y) {
    return x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
}

export function chunkRectBetween(a, b) {
    return {
        x0: Math.floor(Math.min(a.x, b.x) / CHUNK_SQUARES),
        y0: Math.floor(Math.min(a.y, b.y) / CHUNK_SQUARES),
        x1: Math.floor(Math.max(a.x, b.x) / CHUNK_SQUARES) + 1,
        y1: Math.floor(Math.max(a.y, b.y) / CHUNK_SQUARES) + 1,
    };
}

export function squaresToChunkRect(x, y, w, h, padChunks) {
    return {
        x0: Math.floor(x / CHUNK_SQUARES) - padChunks,
        y0: Math.floor(y / CHUNK_SQUARES) - padChunks,
        x1: Math.ceil((x + w) / CHUNK_SQUARES) + padChunks,
        y1: Math.ceil((y + h) / CHUNK_SQUARES) + padChunks,
    };
}
