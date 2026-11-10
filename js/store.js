/**
 * store.js — Guardado local de las páginas escaneadas.
 *
 * Usa IndexedDB para que, si el teléfono recarga la pestaña o se cierra el
 * navegador, el documento no se pierda. Todo queda en el dispositivo: no hay
 * servidor ni sincronización.
 *
 * Si IndexedDB no está disponible (por ejemplo, navegación privada muy
 * restrictiva), la app sigue funcionando solo en memoria.
 */

const DB_NAME = 'escaner-documentos';
const DB_VERSION = 1;
const STORE = 'paginas';

let dbPromise = null;
let memoryOnly = false;
const memory = new Map();

function openDatabase() {
    if (memoryOnly) return Promise.reject(new Error('IndexedDB deshabilitado'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB no disponible'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('No se pudo abrir la base'));
        request.onblocked = () => reject(new Error('Base bloqueada por otra pestaña'));
    });

    return dbPromise;
}

function transaction(mode, fn) {
    return openDatabase().then(
        (db) =>
            new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const store = tx.objectStore(STORE);
                let result;
                try {
                    result = fn(store);
                } catch (err) {
                    reject(err);
                    return;
                }
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Transacción cancelada'));
            })
    );
}

function fallbackToMemory(err) {
    console.warn('[store] Se usará memoria volátil:', err);
    memoryOnly = true;
}

export const Store = {
    /** Todas las páginas guardadas, ordenadas. */
    async all() {
        try {
            const records = await transaction('readonly', (store) => {
                const out = [];
                store.openCursor().onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        out.push(cursor.value);
                        cursor.continue();
                    }
                };
                return out;
            });
            return records.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.createdAt - b.createdAt);
        } catch (err) {
            fallbackToMemory(err);
            return Array.from(memory.values()).sort(
                (a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.createdAt - b.createdAt
            );
        }
    },

    /** Inserta o actualiza una página. */
    async put(record) {
        if (memoryOnly) {
            memory.set(record.id, record);
            return;
        }
        try {
            await transaction('readwrite', (store) => store.put(record));
        } catch (err) {
            fallbackToMemory(err);
            memory.set(record.id, record);
        }
    },

    /** Actualiza la posición de varias páginas de una vez. */
    async putMany(records) {
        if (memoryOnly) {
            records.forEach((r) => memory.set(r.id, r));
            return;
        }
        try {
            await transaction('readwrite', (store) => records.forEach((r) => store.put(r)));
        } catch (err) {
            fallbackToMemory(err);
            records.forEach((r) => memory.set(r.id, r));
        }
    },

    /** Elimina una página. */
    async remove(id) {
        if (memoryOnly) {
            memory.delete(id);
            return;
        }
        try {
            await transaction('readwrite', (store) => store.delete(id));
        } catch (err) {
            fallbackToMemory(err);
            memory.delete(id);
        }
    },

    /** Borra absolutamente todo. */
    async clear() {
        memory.clear();
        if (memoryOnly) return;
        try {
            await transaction('readwrite', (store) => store.clear());
        } catch (err) {
            fallbackToMemory(err);
        }
    },
};
