const MIN_VERSION = 194;

class Reader {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.pos = 0;
        this.decoder = new TextDecoder();
    }

    int32() {
        const value = this.view.getInt32(this.pos);
        this.pos += 4;
        return value;
    }

    skip(count) {
        this.pos += count;
        if (this.pos > this.view.byteLength) {
            throw new RangeError('map_meta.bin ended early');
        }
    }

    string() {
        const length = this.view.getUint16(this.pos);
        this.pos += 2;
        const bytes = new Uint8Array(this.view.buffer, this.pos, length);
        this.pos += length;
        return this.decoder.decode(bytes);
    }

    strings() {
        const count = this.int32();
        const out = [];
        for (let i = 0; i < count; i++) {
            out.push(this.string());
        }
        return out;
    }
}

function skipCells(reader, version) {
    const minX = reader.int32();
    const minY = reader.int32();
    const maxX = reader.int32();
    const maxY = reader.int32();
    const cells = (maxX - minX + 1) * (maxY - minY + 1);
    let buildingBytes = 19;
    if (version >= 201) {
        buildingBytes = 23;
    }
    for (let i = 0; i < cells; i++) {
        reader.skip(reader.int32() * 10);
        reader.skip(reader.int32() * buildingBytes);
    }
}

function readSafehouse(reader, version) {
    const x = reader.int32();
    const y = reader.int32();
    const w = reader.int32();
    const h = reader.int32();
    const owner = reader.string();
    if (version >= 216) {
        reader.skip(4);
    }
    const players = reader.strings();
    reader.skip(8);
    const title = reader.string();
    if (version >= 223) {
        reader.skip(8);
        reader.string();
    }
    reader.strings();
    return { x, y, w, h, owner, players, title };
}

export function parseSafehouses(buffer) {
    const reader = new Reader(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== 'META') {
        throw new Error('map_meta.bin does not start with its meta header');
    }
    reader.skip(4);
    const version = reader.int32();
    if (version < MIN_VERSION) {
        throw new Error(`map_meta.bin is world version ${version}, older than this tool reads`);
    }
    skipCells(reader, version);
    const count = reader.int32();
    const safehouses = [];
    for (let i = 0; i < count; i++) {
        safehouses.push(readSafehouse(reader, version));
    }
    return safehouses;
}
