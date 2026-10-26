(function () {
    const STORE = 'pzcleaner-connection';
    const FIELDS = ['host', 'port', 'user', 'path'];
    const ERROR_NAME = /^(\w*Error): ([\s\S]*)$/;

    const DIALOG = `
<dialog id="connect" class="confirm" aria-labelledby="connect-h">
  <form id="connect-form">
    <h2 class="h2" id="connect-h">Open a save</h2>
    <p>For a rented server, use the SFTP login from your host's panel. Stop the game server first. The save folder is the one holding map_meta.bin and a map folder.</p>
    <div class="connect-grid">
      <label>Host <input class="field" id="connect-host" required autocomplete="off" spellcheck="false"></label>
      <label>Port <input class="field small" id="connect-port" type="number" min="1" max="65535" value="22"></label>
      <label>User <input class="field" id="connect-user" required autocomplete="off" spellcheck="false"></label>
      <label>Password <input class="field" id="connect-password" type="password" required autocomplete="off"></label>
      <label class="ctl--check connect-wide"><input type="checkbox" class="ctl-check" id="connect-reveal"> Show password</label>
      <label class="connect-wide">Save folder on the server <input class="field" id="connect-path" required autocomplete="off" spellcheck="false" placeholder="/home/pz/Zomboid/Saves/Multiplayer/servertest"></label>
    </div>
    <p id="connect-trust" hidden></p>
    <p id="connect-error" class="status-error" role="alert" hidden></p>
    <div class="confirm-actions">
      <button type="button" id="connect-local" class="btn btn-secondary">Folder on this computer</button>
      <button type="button" id="connect-cancel" class="btn btn-ghost">Cancel</button>
      <button type="submit" id="connect-ok" class="button-primary">Connect</button>
    </div>
  </form>
</dialog>`;

    const STYLE = `
#connect { width: min(44rem, calc(100vw - 2 * var(--page-padding))); }
.connect-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-bottom: var(--sp-4); }
.connect-grid .connect-wide { grid-column: 1 / -1; }
.connect-grid label { display: grid; gap: var(--sp-1); color: var(--text-muted); }
.connect-grid .ctl--check { display: flex; }
#connect-trust { color: var(--text); overflow-wrap: anywhere; }
#connect-error { color: var(--danger); }
#connect-local { margin-right: auto; }
`;

    function byId(id) {
        return document.getElementById(id);
    }

    function toDomError(error) {
        let text = String(error);
        if (error && error.message) {
            text = error.message;
        }
        const match = ERROR_NAME.exec(text);
        if (!match) {
            return new Error(text);
        }
        if (match[1] === 'Error') {
            return new Error(match[2]);
        }
        return new DOMException(match[2], match[1]);
    }

    async function call(method, args) {
        try {
            return await window.go.main.App[method].apply(null, args);
        } catch (error) {
            throw toDomError(error);
        }
    }

    function childPath(parent, name) {
        if (parent === '') {
            return name;
        }
        return `${parent}/${name}`;
    }

    function base64ToBuffer(text) {
        const binary = atob(text || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function bytesToBase64(parts) {
        let binary = '';
        for (const part of parts) {
            for (let i = 0; i < part.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
            }
        }
        return btoa(binary);
    }

    function toBytes(data) {
        if (data instanceof ArrayBuffer) {
            return new Uint8Array(data);
        }
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    function typeMismatch(name) {
        return new DOMException(`${name} is the wrong kind of entry`, 'TypeMismatchError');
    }

    class RemoteFileHandle {
        constructor(path, name) {
            this.kind = 'file';
            this.path = path;
            this.name = name;
        }

        async getFile() {
            const entry = await call('Stat', [this.path]);
            const path = this.path;
            return {
                name: this.name,
                size: entry.size,
                arrayBuffer: async function () {
                    return base64ToBuffer(await call('Read', [path]));
                },
            };
        }

        async createWritable() {
            const parts = [];
            const path = this.path;
            return {
                write: async function (data) {
                    parts.push(toBytes(data));
                },
                close: async function () {
                    await call('Write', [path, bytesToBase64(parts)]);
                },
            };
        }

        async move(dir, name) {
            const target = childPath(dir.path, name);
            await call('Rename', [this.path, target]);
            this.path = target;
            this.name = name;
        }
    }

    class RemoteDirectoryHandle {
        constructor(path, name) {
            this.kind = 'directory';
            this.path = path;
            this.name = name;
        }

        async getDirectoryHandle(name, options) {
            const path = childPath(this.path, name);
            if (options && options.create) {
                await call('Mkdir', [path]);
            }
            const entry = await call('Stat', [path]);
            if (!entry.dir) {
                throw typeMismatch(name);
            }
            return new RemoteDirectoryHandle(path, name);
        }

        async getFileHandle(name, options) {
            const path = childPath(this.path, name);
            let entry;
            try {
                entry = await call('Stat', [path]);
            } catch (error) {
                if (error.name !== 'NotFoundError' || !options || !options.create) {
                    throw error;
                }
                await call('Write', [path, '']);
                entry = { dir: false };
            }
            if (entry.dir) {
                throw typeMismatch(name);
            }
            return new RemoteFileHandle(path, name);
        }

        async removeEntry(name, options) {
            const recursive = Boolean(options && options.recursive);
            await call('Remove', [childPath(this.path, name), recursive]);
        }

        async *entries() {
            for (const entry of await call('List', [this.path])) {
                const path = childPath(this.path, entry.name);
                if (entry.dir) {
                    yield [entry.name, new RemoteDirectoryHandle(path, entry.name)];
                } else {
                    yield [entry.name, new RemoteFileHandle(path, entry.name)];
                }
            }
        }

        async *keys() {
            for (const entry of await call('List', [this.path])) {
                yield entry.name;
            }
        }
    }

    function showMessage(id, text) {
        byId(id).textContent = text;
        byId(id).hidden = text === '';
    }

    function loadFields() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(STORE) || '{}');
        } catch {
            saved = {};
        }
        for (const field of FIELDS) {
            if (typeof saved[field] === 'string' && saved[field] !== '') {
                byId(`connect-${field}`).value = saved[field];
            }
        }
    }

    function saveFields() {
        const saved = {};
        for (const field of FIELDS) {
            saved[field] = byId(`connect-${field}`).value.trim();
        }
        localStorage.setItem(STORE, JSON.stringify(saved));
    }

    function chooseServer() {
        const dialog = byId('connect');
        let trust = '';
        loadFields();
        showMessage('connect-error', '');
        showMessage('connect-trust', '');
        byId('connect-ok').textContent = 'Connect';
        byId('connect-password').value = '';
        byId('connect-password').type = 'password';
        byId('connect-reveal').checked = false;
        return new Promise(function (resolve, reject) {
            function finish() {
                byId('connect-form').removeEventListener('submit', submit);
                byId('connect-local').removeEventListener('click', chooseLocal);
                byId('connect-cancel').removeEventListener('click', cancel);
                dialog.removeEventListener('cancel', cancel);
                byId('connect-password').value = '';
                dialog.close();
            }

            function cancel(event) {
                event.preventDefault();
                finish();
                reject(new DOMException('cancelled', 'AbortError'));
            }

            async function submit(event) {
                event.preventDefault();
                showMessage('connect-error', '');
                showMessage('connect-trust', '');
                byId('connect-ok').disabled = true;
                byId('connect-ok').textContent = 'Connecting…';
                const request = {
                    host: byId('connect-host').value.trim(),
                    port: Number(byId('connect-port').value) || 22,
                    user: byId('connect-user').value.trim(),
                    password: byId('connect-password').value,
                    path: byId('connect-path').value.trim(),
                    trust: trust,
                };
                let result = null;
                try {
                    result = await call('Connect', [request]);
                } catch (error) {
                    showMessage('connect-error', `Could not connect: ${error.message}`);
                }
                byId('connect-ok').disabled = false;
                byId('connect-ok').textContent = 'Connect';
                if (!result) {
                    return;
                }
                if (result.fingerprint) {
                    trust = result.fingerprint;
                    showMessage(
                        'connect-trust',
                        `This is the first connection to ${request.host}. Its ${result.keyType} key fingerprint is ${result.fingerprint}. Check it against your host's panel or support, then trust it.`,
                    );
                    byId('connect-ok').textContent = 'Trust and connect';
                    return;
                }
                saveFields();
                finish();
                resolve(new RemoteDirectoryHandle('', result.name));
            }

            async function chooseLocal() {
                showMessage('connect-error', '');
                let result = null;
                try {
                    result = await call('OpenLocal', []);
                } catch (error) {
                    showMessage('connect-error', `Could not open the folder: ${error.message}`);
                }
                if (result && result.name) {
                    finish();
                    resolve(new RemoteDirectoryHandle('', result.name));
                }
            }

            byId('connect-form').addEventListener('submit', submit);
            byId('connect-local').addEventListener('click', chooseLocal);
            byId('connect-cancel').addEventListener('click', cancel);
            dialog.addEventListener('cancel', cancel);
            dialog.showModal();
            byId('connect-host').focus();
        });
    }

    function packedPairs(keys, helpers) {
        const pairs = [];
        for (const key of keys) {
            pairs.push([helpers.unpackX(key), helpers.unpackY(key)]);
        }
        return pairs;
    }

    async function scanChunks(mapDir, chunks, onProgress, packXY) {
        const stop = window.runtime.EventsOn('progress', onProgress);
        let flat;
        try {
            flat = await call('Index', [mapDir.path]);
        } finally {
            stop();
        }
        for (let i = 0; i < flat.length; i += 2) {
            chunks.add(packXY(flat[i], flat[i + 1]));
        }
    }

    async function executePlan(save, plan, useTrash, onProgress, helpers) {
        const request = {
            chunks: packedPairs(plan.chunks, helpers),
            cells: packedPairs(plan.clearedCells, helpers),
            cellKinds: plan.cellKinds,
            vehicles: plan.vehicleCount > 0,
            trash: useTrash,
        };
        const stop = window.runtime.EventsOn('progress', onProgress);
        let result;
        try {
            result = await call('Execute', [request]);
        } finally {
            stop();
        }
        for (const key of plan.chunks) {
            save.chunks.delete(key);
        }
        save.bounds = helpers.boundsOf(save.chunks);
        const gone = new Set(result.vehicleIds || []);
        save.vehicles.list = save.vehicles.list.filter(function (vehicle) {
            return !gone.has(vehicle.id);
        });
        let trashStamp = null;
        if (useTrash) {
            save.trash = await helpers.listTrash(save.root);
            trashStamp = result.stamp;
        }
        return { chunks: plan.chunks.size, cellFiles: result.cellFiles, vehicles: gone.size, trashStamp };
    }

    async function restoreTrash(stamp, onProgress) {
        const stop = window.runtime.EventsOn('progress', function (done) {
            onProgress(done);
        });
        try {
            return await call('Restore', [stamp]);
        } finally {
            stop();
        }
    }

    function openLinksOutside(event) {
        const link = event.target.closest('a[href^="http"]');
        if (!link) {
            return;
        }
        event.preventDefault();
        window.runtime.BrowserOpenURL(link.href);
    }

    window.showDirectoryPicker = chooseServer;
    window.pzDesktop = { scanChunks: scanChunks, executePlan: executePlan, restoreTrash: restoreTrash };

    document.addEventListener('DOMContentLoaded', function () {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.append(style);
        document.body.insertAdjacentHTML('beforeend', DIALOG);
        byId('connect-reveal').addEventListener('change', function (event) {
            if (event.target.checked) {
                byId('connect-password').type = 'text';
            } else {
                byId('connect-password').type = 'password';
            }
        });
        byId('btn-open').textContent = 'Open a save';
        document.addEventListener('click', openLinksOutside);
    });
})();
