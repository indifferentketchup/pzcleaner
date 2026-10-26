import { packXY } from './format.js';

const SQL_DIR = 'vendor/sqljs';

let sqlPromise = null;

function loadSql() {
    if (!sqlPromise) {
        sqlPromise = new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.src = `${SQL_DIR}/sql-wasm.js`;
            script.addEventListener('load', function () {
                resolve(
                    window.initSqlJs({
                        locateFile: function (file) {
                            return `${SQL_DIR}/${file}`;
                        },
                    }),
                );
            });
            script.addEventListener('error', function () {
                reject(new Error('Could not load the database reader.'));
            });
            document.head.append(script);
        });
    }
    return sqlPromise;
}

async function fileSize(dir, name) {
    try {
        const file = await (await dir.getFileHandle(name)).getFile();
        return file.size;
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return 0;
        }
        throw error;
    }
}

async function readBytes(dir, name) {
    try {
        const file = await (await dir.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return null;
        }
        throw error;
    }
}

export async function writeBytes(dir, name, bytes) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
}

async function withDatabase(root, name, task) {
    const bytes = await readBytes(root, name);
    if (!bytes) {
        return [];
    }
    const SQL = await loadSql();
    const database = new SQL.Database(bytes);
    try {
        return await task(database, bytes);
    } finally {
        database.close();
    }
}

function rows(database, query) {
    const result = database.exec(query);
    if (result.length === 0) {
        return [];
    }
    return result[0].values;
}

function hasTable(database, table) {
    const statement = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    statement.bind([table]);
    const found = statement.step();
    statement.free();
    return found;
}

export async function readLivingPlayers(root) {
    return withDatabase(root, 'players.db', function (database) {
        const players = [];
        for (const table of ['networkPlayers', 'localPlayers']) {
            if (!hasTable(database, table)) {
                continue;
            }
            for (const [x, y, isDead] of rows(database, `SELECT x, y, isDead FROM ${table}`)) {
                if (!isDead) {
                    players.push({ x, y });
                }
            }
        }
        return players;
    });
}

export async function readVehicles(root) {
    return withDatabase(root, 'vehicles.db', function (database) {
        if (!hasTable(database, 'vehicles')) {
            return [];
        }
        return rows(database, 'SELECT id, wx, wy FROM vehicles').map(function ([id, wx, wy]) {
            return { id, wx, wy };
        });
    });
}

export async function removeVehicles(root, doomedChunks, keepOriginal) {
    if ((await fileSize(root, 'vehicles.db-journal')) > 0) {
        throw new Error(
            'vehicles.db has an unfinished write journal next to it. Start and stop the game once so it settles, then try again.',
        );
    }
    return withDatabase(root, 'vehicles.db', async function (database, original) {
        if (!hasTable(database, 'vehicles')) {
            return [];
        }
        const ids = [];
        for (const [id, wx, wy] of rows(database, 'SELECT id, wx, wy FROM vehicles')) {
            if (doomedChunks.has(packXY(wx, wy))) {
                ids.push(id);
            }
        }
        if (ids.length === 0) {
            return ids;
        }
        await keepOriginal(original);
        database.run('BEGIN');
        const statement = database.prepare('DELETE FROM vehicles WHERE id = ?');
        for (const id of ids) {
            statement.run([id]);
        }
        statement.free();
        database.run('COMMIT');
        const check = rows(database, 'PRAGMA integrity_check');
        if (check.length !== 1 || check[0][0] !== 'ok') {
            throw new Error(
                'vehicles.db failed its integrity check after the edit, so it was left as it was.',
            );
        }
        await writeBytes(root, 'vehicles.db', database.export());
        return ids;
    });
}
