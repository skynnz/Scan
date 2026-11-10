/**
 * tools.js — Herramientas de PDF.
 *
 * Unir, comprimir, convertir imágenes a PDF y editar páginas (rotar, borrar,
 * reordenar). Todo ocurre en el navegador.
 *
 * pdf-lib y pdf.js se cargan recién cuando se abre una herramienta que las
 * necesita, para que la app de escaneo siga siendo liviana.
 */

import { buildPdf, downloadBlob, loadJsPdf } from './pdf.js';

const VENDOR = './vendor/';

/* ------------------------------------------------------------------ */
/* Carga diferida de librerías                                         */
/* ------------------------------------------------------------------ */

const scriptLoads = new Map();

function loadScript(src) {
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`No se pudo cargar ${src.split('/').pop()}`));
        document.head.appendChild(script);
    });
    scriptLoads.set(src, promise);
    return promise;
}

async function getPdfLib() {
    if (!window.PDFLib) await loadScript(`${VENDOR}pdf-lib.min.js`);
    if (!window.PDFLib) throw new Error('La herramienta de PDF no está disponible');
    return window.PDFLib;
}

async function getPdfJs() {
    if (!window.pdfjsLib) await loadScript(`${VENDOR}pdf.min.js`);
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('La herramienta de PDF no está disponible');
    if (!lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.js`;
    }
    return lib;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const ICONS = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
};

const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function stamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

const readArrayBuffer = (file) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'));
        reader.readAsArrayBuffer(file);
    });

const loadImageElement = (url) =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Imagen no válida'));
        img.src = url;
    });

/** Abre el selector de archivos del sistema y devuelve los elegidos. */
function pickFiles({ accept, multiple = false }) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.style.display = 'none';
        document.body.appendChild(input);

        let done = false;
        const finish = (files) => {
            if (done) return;
            done = true;
            input.remove();
            resolve(files);
        };

        input.addEventListener('change', () => finish(Array.from(input.files || [])));
        input.addEventListener('cancel', () => finish([]));
        input.click();
    });
}

/* ------------------------------------------------------------------ */
/* Inicialización                                                      */
/* ------------------------------------------------------------------ */

export function initTools(deps) {
    const { showView, toast, openSheet, closeSheet, nextFrame } = deps;

    const body = document.getElementById('tool-body');
    const footer = document.getElementById('tool-footer');
    const titleEl = document.getElementById('tool-title');

    let current = null;

    /* ----------------------------- helpers ----------------------------- */

    function setTitle(text) {
        titleEl.textContent = text;
    }

    function setBody(html) {
        body.innerHTML = html;
        body.scrollTop = 0;
    }

    function setFooter(html) {
        footer.innerHTML = html || '';
        footer.hidden = !html;
    }

    function showProgress(title) {
        setFooter('');
        setBody(`
            <div class="sheet-busy">
                <div class="spinner"></div>
                <p data-progress-msg>${escapeHtml(title)}</p>
                <div class="progress"><span data-progress-bar></span></div>
            </div>
        `);
    }

    function setProgress(fraction, message) {
        const bar = body.querySelector('[data-progress-bar]');
        const msg = body.querySelector('[data-progress-msg]');
        if (bar) bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
        if (msg && message) msg.textContent = message;
    }

    function showError(message, retry) {
        setFooter('');
        setBody(`
            <div class="tool-empty">
                <div class="tool-empty-icon">${ICONS.warn}</div>
                <h2>Algo no salió bien</h2>
                <p>${escapeHtml(message)}</p>
                <button class="btn primary" data-act="retry">Volver a intentar</button>
            </div>
        `);
        const button = body.querySelector('[data-act="retry"]');
        if (button) button.addEventListener('click', retry);
    }

    function showResult({ title, message, extra = '', filename, blob }) {
        setBody(`
            <div class="result-card">
                <div class="result-icon">${ICONS.check}</div>
                <h2>${escapeHtml(title)}</h2>
                <p>${escapeHtml(message)}</p>
                ${extra}
            </div>
        `);
        setFooter(`
            <button class="btn primary wide" data-act="download">Descargar PDF</button>
            <button class="btn ghost wide" data-act="again">Volver a herramientas</button>
        `);
        footer.querySelector('[data-act="download"]').addEventListener('click', () => {
            downloadBlob(blob, filename);
            toast('Descarga iniciada');
        });
        footer.querySelector('[data-act="again"]').addEventListener('click', () => showView('tools'));
    }

    function emptyBlock({ icon, title, text, action, actionLabel }) {
        return `
            <div class="tool-empty">
                <div class="tool-empty-icon">${icon}</div>
                <h2>${escapeHtml(title)}</h2>
                <p>${escapeHtml(text)}</p>
                <button class="btn primary" data-act="${action}">${escapeHtml(actionLabel)}</button>
            </div>
        `;
    }

    function bindFileRowActions(rows, { onMove, onRemove }) {
        rows.forEach((row) => {
            const index = Number(row.dataset.index);
            const up = row.querySelector('[data-act="up"]');
            const down = row.querySelector('[data-act="down"]');
            const remove = row.querySelector('[data-act="remove"]');
            if (up) up.addEventListener('click', () => onMove(index, -1));
            if (down) down.addEventListener('click', () => onMove(index, 1));
            if (remove) remove.addEventListener('click', () => onRemove(index));
        });
    }

    function moveItem(list, index, delta) {
        const target = index + delta;
        if (target < 0 || target >= list.length) return;
        const [item] = list.splice(index, 1);
        list.splice(target, 0, item);
    }

    function fileRow(item, index, total) {
        return `
            <div class="file-item" data-index="${index}">
                <div class="file-thumb is-pdf">PDF</div>
                <div class="file-meta">
                    <strong>${escapeHtml(item.name)}</strong>
                    <span>${formatBytes(item.size)} · ${item.pages} ${item.pages === 1 ? 'página' : 'páginas'}</span>
                </div>
                <div class="file-actions">
                    <button class="icon-mini" data-act="up" aria-label="Mover arriba" ${index === 0 ? 'disabled' : ''}>${ICONS.up}</button>
                    <button class="icon-mini" data-act="down" aria-label="Mover abajo" ${index === total - 1 ? 'disabled' : ''}>${ICONS.down}</button>
                    <button class="icon-mini danger" data-act="remove" aria-label="Quitar archivo">✕</button>
                </div>
            </div>
        `;
    }

    const pageLabel = (n) => `${n} ${n === 1 ? 'página' : 'páginas'}`;

    /* ------------------------------ UNIR ------------------------------ */

    let mergeFiles = [];

    function openMerge() {
        mergeFiles = [];
        setTitle('Unir PDFs');
        renderMerge();
    }

    function renderMerge() {
        if (!mergeFiles.length) {
            setBody(
                emptyBlock({
                    icon: ICONS.pdf,
                    title: 'Unir varios PDFs',
                    text: 'Elegí dos o más archivos y se combinarán en el orden que quieras.',
                    action: 'add',
                    actionLabel: 'Elegir PDFs',
                })
            );
            setFooter('');
            body.querySelector('[data-act="add"]').addEventListener('click', addMergeFiles);
            return;
        }

        setBody(`
            <div class="file-list">
                ${mergeFiles.map((file, index) => fileRow(file, index, mergeFiles.length)).join('')}
            </div>
            <div class="tool-add">
                <button class="btn ghost" data-act="add">Agregar más</button>
            </div>
            <p class="tool-note info">${ICONS.info} El orden de la lista es el orden de las páginas en el PDF final.</p>
        `);

        bindFileRowActions(body.querySelectorAll('.file-item'), {
            onMove: (index, delta) => {
                moveItem(mergeFiles, index, delta);
                renderMerge();
            },
            onRemove: (index) => {
                mergeFiles.splice(index, 1);
                renderMerge();
            },
        });
        body.querySelector('[data-act="add"]').addEventListener('click', addMergeFiles);

        const totalPages = mergeFiles.reduce((sum, file) => sum + file.pages, 0);
        setFooter(`
            <button class="btn primary wide" data-act="run" ${mergeFiles.length < 2 ? 'disabled' : ''}>
                Unir ${mergeFiles.length} PDFs · ${pageLabel(totalPages)}
            </button>
        `);
        footer.querySelector('[data-act="run"]').addEventListener('click', runMerge);
    }

    async function addMergeFiles() {
        const picked = await pickFiles({ accept: 'application/pdf,.pdf', multiple: true });
        if (!picked.length) return;

        showProgress('Leyendo archivos…');
        try {
            const PDFLib = await getPdfLib();
            for (const file of picked) {
                try {
                    const bytes = await readArrayBuffer(file);
                    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
                    mergeFiles.push({ name: file.name, size: file.size, bytes, pages: doc.getPageCount() });
                } catch (err) {
                    console.error(err);
                    toast(`${file.name}: no se pudo abrir`, 'error');
                }
            }
        } catch (err) {
            toast(err.message || 'No se pudo cargar la herramienta', 'error');
        }
        renderMerge();
    }

    async function runMerge() {
        if (mergeFiles.length < 2) return;
        showProgress('Uniendo PDFs…');
        try {
            const PDFLib = await getPdfLib();
            const out = await PDFLib.PDFDocument.create();

            for (let i = 0; i < mergeFiles.length; i++) {
                setProgress(i / mergeFiles.length, `Archivo ${i + 1} de ${mergeFiles.length}`);
                const source = await PDFLib.PDFDocument.load(mergeFiles[i].bytes, { ignoreEncryption: true });
                const copied = await out.copyPages(source, source.getPageIndices());
                copied.forEach((page) => out.addPage(page));
                await nextFrame();
            }

            setProgress(1, 'Guardando…');
            const bytes = await out.save();
            showResult({
                title: 'PDFs unidos',
                message: `${mergeFiles.length} archivos · ${pageLabel(out.getPageCount())}`,
                filename: `Unido_${stamp()}.pdf`,
                blob: new Blob([bytes], { type: 'application/pdf' }),
            });
        } catch (err) {
            console.error(err);
            showError('No se pudieron unir los archivos. Puede que alguno esté protegido con contraseña.', renderMerge);
        }
    }

    /* --------------------------- COMPRIMIR --------------------------- */

    const COMPRESS_PRESETS = {
        alta: { dpi: 200, quality: 0.82 },
        media: { dpi: 150, quality: 0.7 },
        baja: { dpi: 100, quality: 0.55 },
    };

    let compressState = null;

    function openCompress() {
        compressState = { file: null, bytes: null, pages: 0, quality: 'media' };
        setTitle('Comprimir PDF');
        renderCompress();
    }

    function renderCompress() {
        const state = compressState;

        if (!state.file) {
            setBody(
                emptyBlock({
                    icon: ICONS.pdf,
                    title: 'Comprimir un PDF',
                    text: 'Se reduce el peso del archivo para poder enviarlo por correo o WhatsApp.',
                    action: 'pick',
                    actionLabel: 'Elegir PDF',
                })
            );
            setFooter('');
            body.querySelector('[data-act="pick"]').addEventListener('click', pickCompressFile);
            return;
        }

        setBody(`
            <div class="tool-info">
                <div class="row"><span>Archivo</span><strong>${escapeHtml(state.file.name)}</strong></div>
                <div class="row"><span>Peso actual</span><strong>${formatBytes(state.file.size)}</strong></div>
                <div class="row"><span>Páginas</span><strong>${state.pages}</strong></div>
            </div>

            <div class="field">
                <span class="field-label">Calidad</span>
                <div class="choice" data-group="quality">
                    <button class="choice-btn" data-value="alta">Alta</button>
                    <button class="choice-btn" data-value="media">Media</button>
                    <button class="choice-btn" data-value="baja">Baja</button>
                </div>
            </div>

            <p class="tool-note">${ICONS.warn} Cada página se vuelve a guardar como imagen para bajar el peso. El texto deja de poder seleccionarse, igual que en un escaneo.</p>
        `);

        body.querySelectorAll('.choice[data-group="quality"] .choice-btn').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.value === state.quality);
            button.addEventListener('click', () => {
                state.quality = button.dataset.value;
                renderCompress();
            });
        });

        setFooter(`<button class="btn primary wide" data-act="run">Comprimir</button>`);
        footer.querySelector('[data-act="run"]').addEventListener('click', runCompress);
    }

    async function pickCompressFile() {
        const [file] = await pickFiles({ accept: 'application/pdf,.pdf' });
        if (!file) return;

        showProgress('Abriendo el PDF…');
        try {
            const bytes = await readArrayBuffer(file);
            const pdfjsLib = await getPdfJs();
            const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
            compressState = { file, bytes, pages: doc.numPages, quality: 'media' };
            await doc.destroy();
        } catch (err) {
            console.error(err);
            showError('No se pudo abrir ese PDF. Puede estar dañado o protegido.', openCompress);
            return;
        }
        renderCompress();
    }

    async function runCompress() {
        const state = compressState;
        if (!state.file) return;

        const preset = COMPRESS_PRESETS[state.quality] || COMPRESS_PRESETS.media;
        showProgress('Comprimiendo…');

        let doc = null;
        try {
            const pdfjsLib = await getPdfJs();
            const JsPDF = await loadJsPdf();

            doc = await pdfjsLib.getDocument({ data: state.bytes.slice(0) }).promise;
            const total = doc.numPages;
            let output = null;

            for (let i = 1; i <= total; i++) {
                setProgress((i - 1) / total, `Página ${i} de ${total}`);

                const page = await doc.getPage(i);
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: preset.dpi / 72 });

                const canvas = document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                const context = canvas.getContext('2d');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);

                await page.render({ canvasContext: context, viewport }).promise;
                const dataUrl = canvas.toDataURL('image/jpeg', preset.quality);
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();

                const widthMm = (base.width * 25.4) / 72;
                const heightMm = (base.height * 25.4) / 72;
                const orientation = widthMm > heightMm ? 'landscape' : 'portrait';

                if (!output) {
                    output = new JsPDF({ unit: 'mm', format: [widthMm, heightMm], orientation, compress: true });
                } else {
                    output.addPage([widthMm, heightMm], orientation);
                }
                output.addImage(dataUrl, 'JPEG', 0, 0, widthMm, heightMm, undefined, 'FAST');

                await nextFrame();
            }

            setProgress(1, 'Guardando…');
            const blob = output.output('blob');

            showResult({
                title: 'PDF comprimido',
                message: pageLabel(total),
                extra: sizeComparison(state.file.size, blob.size),
                filename: `Comprimido_${stamp()}.pdf`,
                blob,
            });
        } catch (err) {
            console.error(err);
            showError('No se pudo comprimir el archivo. Probá con otro PDF.', renderCompress);
        } finally {
            if (doc) {
                try {
                    await doc.destroy();
                } catch {
                    /* noop */
                }
            }
        }
    }

    function sizeComparison(before, after) {
        const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;
        const note = saved > 0
            ? `<div class="result-saving">${saved}% más liviano</div>`
            : `<div class="result-saving" style="color:#f5b942">No se pudo reducir más. Probá con calidad Baja.</div>`;
        return `
            <div class="result-sizes">
                <div class="result-size"><span>Antes</span><strong>${formatBytes(before)}</strong></div>
                <span class="result-arrow">→</span>
                <div class="result-size after"><span>Ahora</span><strong>${formatBytes(after)}</strong></div>
            </div>
            ${note}
        `;
    }

    /* ------------------------ IMÁGENES → PDF ------------------------ */

    let imagesState = null;

    function openImages() {
        imagesState = { files: [], size: 'a4' };
        setTitle('Imágenes a PDF');
        renderImages();
    }

    function renderImages() {
        const state = imagesState;

        if (!state.files.length) {
            setBody(
                emptyBlock({
                    icon: ICONS.image,
                    title: 'Convertir imágenes en PDF',
                    text: 'Elegí una o varias fotos. Cada una será una página, en el orden que elijas.',
                    action: 'add',
                    actionLabel: 'Elegir imágenes',
                })
            );
            setFooter('');
            body.querySelector('[data-act="add"]').addEventListener('click', addImageFiles);
            return;
        }

        setBody(`
            <div class="file-list">
                ${state.files
                    .map(
                        (item, index) => `
                    <div class="file-item" data-index="${index}">
                        <div class="file-thumb" style="background-image:url('${item.url}')" role="img" aria-label="${escapeHtml(item.file.name)}"></div>
                        <div class="file-meta">
                            <strong>${escapeHtml(item.file.name)}</strong>
                            <span>${formatBytes(item.file.size)} · ${item.width} × ${item.height}</span>
                        </div>
                        <div class="file-actions">
                            <button class="icon-mini" data-act="up" aria-label="Mover arriba" ${index === 0 ? 'disabled' : ''}>${ICONS.up}</button>
                            <button class="icon-mini" data-act="down" aria-label="Mover abajo" ${index === state.files.length - 1 ? 'disabled' : ''}>${ICONS.down}</button>
                            <button class="icon-mini danger" data-act="remove" aria-label="Quitar imagen">✕</button>
                        </div>
                    </div>`
                    )
                    .join('')}
            </div>
            <div class="tool-add">
                <button class="btn ghost" data-act="add">Agregar más</button>
            </div>

            <div class="field">
                <span class="field-label">Tamaño de hoja</span>
                <div class="choice" data-group="size">
                    <button class="choice-btn" data-value="a4">A4</button>
                    <button class="choice-btn" data-value="letter">Carta</button>
                    <button class="choice-btn" data-value="fit">Como la imagen</button>
                </div>
            </div>
        `);

        bindFileRowActions(body.querySelectorAll('.file-item'), {
            onMove: (index, delta) => {
                moveItem(imagesState.files, index, delta);
                renderImages();
            },
            onRemove: (index) => {
                const [removed] = imagesState.files.splice(index, 1);
                if (removed) URL.revokeObjectURL(removed.url);
                renderImages();
            },
        });
        body.querySelector('[data-act="add"]').addEventListener('click', addImageFiles);
        body.querySelectorAll('.choice[data-group="size"] .choice-btn').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.value === state.size);
            button.addEventListener('click', () => {
                state.size = button.dataset.value;
                renderImages();
            });
        });

        setFooter(`
            <button class="btn primary wide" data-act="run">Crear PDF · ${pageLabel(state.files.length)}</button>
        `);
        footer.querySelector('[data-act="run"]').addEventListener('click', runImages);
    }

    async function addImageFiles() {
        const picked = await pickFiles({ accept: 'image/*', multiple: true });
        if (!picked.length) return;

        showProgress('Leyendo imágenes…');
        for (const file of picked) {
            const url = URL.createObjectURL(file);
            try {
                const img = await loadImageElement(url);
                imagesState.files.push({
                    file,
                    url,
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                });
            } catch {
                URL.revokeObjectURL(url);
                toast(`${file.name}: no se pudo leer`, 'error');
            }
        }
        renderImages();
    }

    async function runImages() {
        const state = imagesState;
        if (!state.files.length) return;

        showProgress('Creando el PDF…');
        try {
            const pages = state.files.map((item) => ({ blob: item.file, width: item.width, height: item.height }));
            const blob = await buildPdf(pages, { size: state.size, quality: 'alta' }, (progress, message) => {
                setProgress(progress, message);
            });
            showResult({
                title: 'PDF creado',
                message: pageLabel(state.files.length),
                filename: `Imagenes_${stamp()}.pdf`,
                blob,
            });
        } catch (err) {
            console.error(err);
            showError('No se pudo crear el PDF con esas imágenes.', renderImages);
        }
    }

    /* ---------------------------- EDITAR ---------------------------- */

    let organizeState = null;

    function openOrganize() {
        organizeState = { name: '', bytes: null, pages: [] };
        setTitle('Editar PDF');
        renderOrganize();
    }

    function renderOrganize() {
        const state = organizeState;

        if (!state.pages.length) {
            setBody(
                emptyBlock({
                    icon: ICONS.pdf,
                    title: 'Editar las páginas',
                    text: 'Abrí un PDF para rotar, borrar o cambiar de lugar sus páginas.',
                    action: 'pick',
                    actionLabel: 'Elegir PDF',
                })
            );
            setFooter('');
            body.querySelector('[data-act="pick"]').addEventListener('click', pickOrganizeFile);
            return;
        }

        setBody(`
            <p class="sheet-sub" style="margin-bottom:12px">${escapeHtml(state.name)} · ${pageLabel(state.pages.length)}</p>
            <div class="pages-grid tool-grid">
                ${state.pages
                    .map(
                        (page, index) => `
                    <button class="page-card" data-index="${index}" type="button" aria-label="Página ${index + 1}">
                        <img src="${page.url}" alt="Página ${index + 1}" loading="lazy">
                        <span class="page-num">${index + 1}</span>
                        ${page.rotate ? `<span class="rotate-badge">↻ ${page.rotate}°</span>` : ''}
                    </button>`
                    )
                    .join('')}
            </div>
            <p class="tool-note info">${ICONS.info} Tocá una página para rotarla, moverla o eliminarla.</p>
        `);

        body.querySelectorAll('.page-card').forEach((card) => {
            card.addEventListener('click', () => openOrganizePageSheet(Number(card.dataset.index)));
        });

        setFooter(`
            <button class="btn primary wide" data-act="save">Guardar PDF · ${pageLabel(state.pages.length)}</button>
        `);
        footer.querySelector('[data-act="save"]').addEventListener('click', saveOrganize);
    }

    async function pickOrganizeFile() {
        const [file] = await pickFiles({ accept: 'application/pdf,.pdf' });
        if (!file) return;

        showProgress('Abriendo el PDF…');
        let doc = null;
        try {
            const bytes = await readArrayBuffer(file);
            const pdfjsLib = await getPdfJs();
            doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

            const pages = [];
            for (let i = 1; i <= doc.numPages; i++) {
                setProgress(((i - 1) / doc.numPages) * 0.95, `Página ${i} de ${doc.numPages}`);
                const page = await doc.getPage(i);
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: 200 / base.width });

                const canvas = document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

                pages.push({ index: i - 1, rotate: 0, url: canvas.toDataURL('image/jpeg', 0.72) });
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
                await nextFrame();
            }

            organizeState = { name: file.name, bytes, pages };
            await doc.destroy();
            doc = null;
            renderOrganize();
        } catch (err) {
            console.error(err);
            if (doc) {
                try {
                    await doc.destroy();
                } catch {
                    /* noop */
                }
            }
            showError('No se pudo abrir ese PDF. Puede estar dañado o protegido.', openOrganize);
        }
    }

    function openOrganizePageSheet(index) {
        const state = organizeState;
        const page = state.pages[index];
        if (!page) return;

        openSheet(`
            <h2 id="sheet-title">Página ${index + 1}</h2>
            <p class="sheet-sub">${pageLabel(state.pages.length)} en el documento</p>
            <div class="sheet-list">
                <button class="sheet-item" data-act="rotate">${ICONS.rotate} Rotar 90°</button>
                <button class="sheet-item" data-act="left" ${index === 0 ? 'disabled' : ''}>${ICONS.left} Mover antes</button>
                <button class="sheet-item" data-act="right" ${index === state.pages.length - 1 ? 'disabled' : ''}>${ICONS.right} Mover después</button>
                <button class="sheet-item danger" data-act="delete" ${state.pages.length === 1 ? 'disabled' : ''}>${ICONS.trash} Eliminar página</button>
            </div>
        `);

        document.querySelectorAll('#sheet-body .sheet-item').forEach((item) => {
            item.addEventListener('click', () => {
                const action = item.dataset.act;
                closeSheet();
                if (action === 'rotate') page.rotate = (page.rotate + 90) % 360;
                else if (action === 'left') moveItem(state.pages, index, -1);
                else if (action === 'right') moveItem(state.pages, index, 1);
                else if (action === 'delete') state.pages.splice(index, 1);
                renderOrganize();
            });
        });
    }

    async function saveOrganize() {
        const state = organizeState;
        if (!state.pages.length) return;

        showProgress('Guardando PDF…');
        try {
            const PDFLib = await getPdfLib();
            const source = await PDFLib.PDFDocument.load(state.bytes, { ignoreEncryption: true });
            const out = await PDFLib.PDFDocument.create();

            const copied = await out.copyPages(source, state.pages.map((page) => page.index));
            copied.forEach((page, index) => {
                const extra = state.pages[index].rotate;
                if (extra) {
                    const baseAngle = page.getRotation().angle || 0;
                    page.setRotation(PDFLib.degrees((baseAngle + extra) % 360));
                }
                out.addPage(page);
            });

            setProgress(0.9, 'Guardando…');
            const bytes = await out.save();
            showResult({
                title: 'PDF guardado',
                message: pageLabel(state.pages.length),
                filename: `Editado_${stamp()}.pdf`,
                blob: new Blob([bytes], { type: 'application/pdf' }),
            });
        } catch (err) {
            console.error(err);
            showError('No se pudo guardar el PDF. Puede que esté protegido con contraseña.', renderOrganize);
        }
    }

    /* ---------------------------- despacho ---------------------------- */

    const OPENERS = {
        merge: openMerge,
        compress: openCompress,
        images: openImages,
        organize: openOrganize,
    };

    function open(name) {
        const opener = OPENERS[name];
        if (!opener) return;
        current = name;
        opener();
        showView('tool');
    }

    return { open, get current() { return current; } };
}
