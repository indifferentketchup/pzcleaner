const numberFormat = new Intl.NumberFormat('en-US');
const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const STAMP = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/;

const NOUNS = {
    chunk: ['chunk file', 'chunk files'],
    cellFile: ['per-cell file', 'per-cell files'],
    cell: ['cell', 'cells'],
    safehouse: ['claimed safehouse', 'claimed safehouses'],
    player: ['living player', 'living players'],
    member: ['member', 'members'],
    vehicle: ['vehicle', 'vehicles'],
    batch: ['batch', 'batches'],
    file: ['file', 'files'],
};

export function formatNumber(value) {
    return numberFormat.format(value);
}

export function count(value, noun) {
    if (value === 1) {
        return `${formatNumber(value)} ${NOUNS[noun][0]}`;
    }
    return `${formatNumber(value)} ${NOUNS[noun][1]}`;
}

export function joinList(parts) {
    return listFormat.format(parts);
}

export function formatStamp(stamp) {
    const match = STAMP.exec(stamp);
    if (!match) {
        return stamp;
    }
    return `${match[1]} at ${match[2]}:${match[3]}:${match[4]}`;
}
