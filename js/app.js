/**
 * app.js — Escáner de documentos.
 *
 * Flujo: cámara (o imagen) → ajuste de esquinas → filtro → páginas → PDF.
 * Todo el procesamiento ocurre en el dispositivo; no hay servidor.
 */

import * as IM from './imaging.js';
import { Store } from './store.js';
import { buildPdf, downloadBlob, pdfFileName } from './pdf.js';
import { initTools } from './tools.js';

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const MAX_CAPTURE_DIM = 3600;
const MAX_CAPTURE_PIXELS = 12e6;
const MAX_PAGE_DIM = 2600;
const JPEG_QUALITY = 0.86;
const LIVE_INTERVAL = 750;

/* ------------------------------------------------------------------ */
/* Referencias del DOM                                                 */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const dom = {
    boot: $('boot'),
    bootStatus: $('boot-status'),
    app: $('app'),

    video: $('cam'),
    liveOverlay: $('live-overlay'),
    guide: $('guide'),
    camHint: $('cam-hint'),
    camBlocked: $('cam-blocked'),
    camBlockedMsg: $('cam-blocked-msg'),
    shutter: $('btn-shutter'),
    torch: $('btn-torch'),
    flip: $('btn-flip'),
    thumbBtn: $('btn-gallery'),
    thumbLast: $('thumb-last'),
    thumbIcon: $('thumb-icon'),
    thumbBadge: $('thumb-badge'),

    tabbar: $('tabbar'),
    tabBadge: $('tab-badge'),

    pagesSub: $('pages-sub'),
    pagesGrid: $('pages-grid'),
    pagesEmpty: $('pages-empty'),
    exportBtn: $('btn-export'),
    clearBtn: $('btn-clear'),

    editCanvas: $('edit-canvas'),
    editHint: $('edit-hint'),
    editBusy: $('edit-busy'),
    busyText: $('busy-text'),
    busyBar: $('busy-bar'),
    filterChips: $('filter-chips'),
    intensityRow: $('intensity-row'),
    intensity: $('intensity'),
    intensityOut: $('intensity-out'),

    overlay: $('overlay'),
    sheet: $('sheet'),
    sheetBody: $('sheet-body'),

    viewer: $('viewer'),
    viewerImg: $('viewer-img'),

    toast: $('toast'),
    fileImport: $('file-import'),
    fileCamera: $('file-camera'),
};

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

const state = {
    view: 'scan',
    pages: [],
    editor: null,
    camera: {
        stream: null,
        facing: 'environment',
        starting: false,
        torchOn: false,
        torchAvailable: false,
        multiple: false,
    },
    export: { size: 'a4', quality: 'alta', purge: true },
    live: { timer: null, busy: false },
};

let sheetResolver = null;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function toast(message, type = 'info', timeout = 3000) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.toggle('is-error', type === 'error');
    dom.toast.classList.add('is-visible');
    toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), timeout);
}

/** Oculta el aviso flotante (por ejemplo, al abrir una hoja inferior). */
function hideToast() {
    clearTimeout(toastTimer);
    dom.toast.classList.remove('is-visible');
}

function setBoot(text) {
    if (dom.bootStatus) dom.bootStatus.textContent = text;
}

function hideBoot() {
    dom.boot.classList.add('is-hidden');
    dom.app.hidden = false;
    setTimeout(() => {
        dom.boot.hidden = true;
    }, 400);
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = JPEG_QUALITY) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo generar la imagen'))), type, quality);
    });
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Imagen no válida'));
        img.src = url;
    });
}

/* --------------------------- Hoja inferior --------------------------- */

function openSheet(html) {
    hideToast();
    dom.sheetBody.innerHTML = html;
    dom.overlay.hidden = false;
    dom.sheet.hidden = false;
}

function closeSheet(result = false) {
    dom.sheet.hidden = true;
    dom.overlay.hidden = true;
    dom.sheetBody.innerHTML = '';
    if (sheetResolver) {
        const resolve = sheetResolver;
        sheetResolver = null;
        resolve(result);
    }
}

function confirmSheet({ title, message, confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
    return new Promise((resolve) => {
        sheetResolver = resolve;
        openSheet(`
            <h2 id="sheet-title">${title}</h2>
            <p class="sheet-sub">${message}</p>
            <div class="sheet-actions">
                <button class="btn ghost" data-confirm="no">${cancelText}</button>
                <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-confirm="yes">${confirmText}</button>
            </div>
        `);
        dom.sheetBody.querySelector('[data-confirm="no"]').addEventListener('click', () => closeSheet(false));
        dom.sheetBody.querySelector('[data-confirm="yes"]').addEventListener('click', () => closeSheet(true));
    });
}

function sheetProgress(title, message = '') {
    openSheet(`
        <h2 id="sheet-title">${title}</h2>
        <div class="sheet-busy">
            <div class="spinner"></div>
            <p id="sheet-msg">${message}</p>
            <div class="progress"><span id="sheet-bar"></span></div>
        </div>
    `);
}

function updateSheetProgress(fraction, message) {
    const bar = document.getElementById('sheet-bar');
    const msg = document.getElementById('sheet-msg');
    if (bar) bar.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
    if (msg && message) msg.textContent = message;
}

/* --------------------------- Navegación --------------------------- */

function showView(name) {
    state.view = name;

    document.querySelectorAll('.view').forEach((view) => {
        view.classList.toggle('is-active', view.id === `view-${name}`);
    });
    document.querySelectorAll('.tab').forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.nav === name);
    });
    dom.tabbar.classList.toggle('is-hidden', name === 'edit' || name === 'tool');

    if (name === 'scan') {
        startCameraIfNeeded();
        startLiveDetection();
    } else {
        stopLiveDetection();
        if (name !== 'edit') stopCamera();
    }

    if (name === 'pages') renderPagesUI();
}

/* ------------------------------------------------------------------ */
/* Cámara                                                              */
/* ------------------------------------------------------------------ */

function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function getStream(facing) {
    const attempts = [
        {
            audio: false,
            video: {
                facingMode: { ideal: facing },
                width: { ideal: 3840 },
                height: { ideal: 2160 },
            },
        },
        {
            audio: false,
            video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        },
        { audio: false, video: { facingMode: { ideal: facing } } },
        { audio: false, video: true },
    ];

    let lastError = null;
    for (const constraints of attempts) {
        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            lastError = err;
            // Si el usuario dijo "no", no tiene sentido seguir probando.
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
        }
    }
    throw lastError || new Error('No hay cámara disponible');
}

async function startCameraIfNeeded() {
    if (state.camera.stream && state.camera.stream.active) return;
    await startCamera();
}

async function startCamera() {
    if (state.camera.starting) return;
    state.camera.starting = true;

    stopCamera();
    hideCameraBlocked();
    dom.shutter.disabled = true;
    dom.camHint.textContent = 'Iniciando cámara…';

    try {
        if (!cameraSupported()) {
            throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
        }
        if (!window.isSecureContext) {
            throw Object.assign(new Error('insecure'), { name: 'SecurityError' });
        }

        const stream = await getStream(state.camera.facing);
        state.camera.stream = stream;
        dom.video.srcObject = stream;

        await dom.video.play().catch(() => {});
        await waitForVideo();

        dom.shutter.disabled = false;
        dom.camHint.textContent = 'Ubica el documento dentro del recuadro';
        await refreshCameraCapabilities();
    } catch (err) {
        console.warn('[cámara]', err);
        showCameraBlocked(err);
    } finally {
        state.camera.starting = false;
    }
}

function waitForVideo(timeout = 5000) {
    if (dom.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            if (dom.video.videoWidth > 0 || Date.now() - start > timeout) {
                cleanup();
                resolve();
            } else {
                setTimeout(tick, 60);
            }
        };
        const onMeta = () => {
            cleanup();
            resolve();
        };
        const cleanup = () => {
            dom.video.removeEventListener('loadedmetadata', onMeta);
        };
        dom.video.addEventListener('loadedmetadata', onMeta);
        setTimeout(tick, 60);
    });
}

function stopCamera() {
    if (state.camera.stream) {
        state.camera.stream.getTracks().forEach((track) => {
            try {
                track.stop();
            } catch {
                /* noop */
            }
        });
        state.camera.stream = null;
    }
    if (dom.video.srcObject) dom.video.srcObject = null;
    state.camera.torchOn = false;
    dom.torch.classList.remove('is-on');
    dom.shutter.disabled = true;
}

async function refreshCameraCapabilities() {
    const track = state.camera.stream && state.camera.stream.getVideoTracks()[0];
    if (!track) return;

    let multiple = false;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        multiple = devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch {
        multiple = false;
    }
    state.camera.multiple = multiple;
    dom.flip.style.display = multiple ? '' : 'none';

    let torch = false;
    try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        torch = !!caps.torch;
    } catch {
        torch = false;
    }
    state.camera.torchAvailable = torch;
    dom.torch.hidden = !torch;
}

function showCameraBlocked(err) {
    const name = (err && err.name) || '';
    let message = 'Revisa los permisos de la cámara en tu navegador.';

    if (name === 'NotAllowedError') {
        message = 'Bloqueaste el acceso a la cámara. Habilítalo en los ajustes del navegador (el candado de la barra de direcciones) y reintenta.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        message = 'No encontramos ninguna cámara en este dispositivo. Puedes tomar la foto con la app de cámara o elegir una imagen.';
    } else if (name === 'NotReadableError') {
        message = 'Otra aplicación está usando la cámara. Ciérrala y vuelve a intentar.';
    } else if (name === 'SecurityError' || name === 'NotSupportedError') {
        message = 'La cámara necesita una conexión segura (https://). También puedes elegir una imagen de la galería.';
    }

    dom.camBlockedMsg.textContent = message;
    dom.camBlocked.hidden = false;
    dom.camHint.textContent = '';
    dom.shutter.disabled = true;
}

function hideCameraBlocked() {
    dom.camBlocked.hidden = true;
}

async function toggleTorch() {
    const track = state.camera.stream && state.camera.stream.getVideoTracks()[0];
    if (!track || !state.camera.torchAvailable) return;
    try {
        state.camera.torchOn = !state.camera.torchOn;
        await track.applyConstraints({ advanced: [{ torch: state.camera.torchOn }] });
        dom.torch.classList.toggle('is-on', state.camera.torchOn);
    } catch (err) {
        console.warn('[linterna]', err);
        state.camera.torchOn = false;
        dom.torch.classList.remove('is-on');
    }
}

async function switchCamera() {
    state.camera.facing = state.camera.facing === 'environment' ? 'user' : 'environment';
    await startCamera();
}

/* ------------------------------------------------------------------ */
/* Guía de encuadre → coordenadas de la foto                           */
/* ------------------------------------------------------------------ */

function defaultGuide(width, height) {
    const inset = 0.06;
    return {
        x0: width * inset,
        y0: height * inset,
        x1: width * (1 - inset),
        y1: height * (1 - inset),
    };
}

/**
 * Convierte el recuadro visible (CSS) a píxeles reales del video, teniendo en
 * cuenta que el video se muestra con object-fit: cover (recorta los costados).
 */
function guideRectInFrame(scale = 1) {
    const vw = dom.video.videoWidth;
    const vh = dom.video.videoHeight;
    if (!vw || !vh) return null;

    const videoRect = dom.video.getBoundingClientRect();
    const guideRect = dom.guide.getBoundingClientRect();
    if (!videoRect.width || !videoRect.height || !guideRect.width) {
        return defaultGuide(vw * scale, vh * scale);
    }

    const cover = Math.max(videoRect.width / vw, videoRect.height / vh);
    const offX = (vw * cover - videoRect.width) / 2;
    const offY = (vh * cover - videoRect.height) / 2;

    const toVideo = (cssX, cssY) => ({
        x: (cssX - videoRect.left + offX) / cover,
        y: (cssY - videoRect.top + offY) / cover,
    });

    const a = toVideo(guideRect.left, guideRect.top);
    const b = toVideo(guideRect.right, guideRect.bottom);

    return {
        x0: clamp(a.x, 0, vw) * scale,
        y0: clamp(a.y, 0, vh) * scale,
        x1: clamp(b.x, 0, vw) * scale,
        y1: clamp(b.y, 0, vh) * scale,
    };
}

/* ------------------------------------------------------------------ */
/* Detección en vivo (solo para guiar al usuario)                      */
/* ------------------------------------------------------------------ */

function startLiveDetection() {
    stopLiveDetection();
    state.live.timer = setInterval(detectLiveFrame, LIVE_INTERVAL);
}

function stopLiveDetection() {
    if (state.live.timer) clearInterval(state.live.timer);
    state.live.timer = null;
    clearLiveOverlay();
}

function clearLiveOverlay() {
    const canvas = dom.liveOverlay;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    dom.guide.classList.remove('is-detected');
    dom.camHint.classList.remove('is-detected');
    if (state.view === 'scan' && dom.video.videoWidth) {
        dom.camHint.textContent = 'Ubica el documento dentro del recuadro';
    }
}

async function detectLiveFrame() {
    if (state.live.busy || state.view !== 'scan' || !dom.video.videoWidth) return;
    if (dom.camBlocked.hidden === false) return;

    state.live.busy = true;
    try {
        const vw = dom.video.videoWidth;
        const vh = dom.video.videoHeight;
        const targetW = 320;
        const s = targetW / vw;
        const w = Math.round(vw * s);
        const h = Math.round(vh * s);

        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const octx = off.getContext('2d', { willReadFrequently: true });
        octx.drawImage(dom.video, 0, 0, w, h);
        const img = octx.getImageData(0, 0, w, h);

        const guide = guideRectInFrame(s);
        const quad = IM.detectQuad(img, guide);

        if (!quad) {
            clearLiveOverlay();
            return;
        }

        const rect = dom.liveOverlay.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (dom.liveOverlay.width !== Math.round(rect.width * dpr)) {
            dom.liveOverlay.width = Math.round(rect.width * dpr);
            dom.liveOverlay.height = Math.round(rect.height * dpr);
        }

        const ctx = dom.liveOverlay.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        const cover = Math.max(rect.width / vw, rect.height / vh);
        const offX = (vw * cover - rect.width) / 2;
        const offY = (vh * cover - rect.height) / 2;
        const pts = quad.map((p) => ({
            x: p.x / s * cover - offX,
            y: p.y / s * cover - offY,
        }));

        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(18, 196, 139, 0.95)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.shadowColor = 'rgba(18, 196, 139, 0.6)';
        ctx.shadowBlur = 12;
        ctx.stroke();

        dom.guide.classList.add('is-detected');
        dom.camHint.classList.add('is-detected');
        dom.camHint.textContent = 'Documento detectado';
    } catch (err) {
        // La detección en vivo es un extra: si falla, se desactiva sin romper nada.
        console.warn('[detección en vivo]', err);
        stopLiveDetection();
    } finally {
        state.live.busy = false;
    }
}

/* ------------------------------------------------------------------ */
/* Captura                                                             */
/* ------------------------------------------------------------------ */

async function captureFrame() {
    if (!dom.video.videoWidth) {
        toast('La cámara todavía no está lista');
        return;
    }
    stopLiveDetection();
    dom.shutter.disabled = true;

    try {
        const vw = dom.video.videoWidth;
        const vh = dom.video.videoHeight;
        const scale = Math.min(1, MAX_CAPTURE_DIM / Math.max(vw, vh), Math.sqrt(MAX_CAPTURE_PIXELS / (vw * vh)));

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vw * scale);
        canvas.height = Math.round(vh * scale);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(dom.video, 0, 0, canvas.width, canvas.height);

        const guide = guideRectInFrame(scale);
        openEditor(canvas, guide);
    } catch (err) {
        console.error(err);
        toast('No se pudo capturar la imagen', 'error');
    } finally {
        dom.shutter.disabled = false;
    }
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function buildBaseCanvas(editor) {
    const maxDisplay = 1400;
    const scale = Math.min(1, maxDisplay / Math.max(editor.source.width, editor.source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(editor.source.width * scale));
    canvas.height = Math.max(1, Math.round(editor.source.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(editor.source.canvas, 0, 0, canvas.width, canvas.height);
    editor.base = canvas;
    editor.baseScale = scale;
}

function openEditor(canvas, guide) {
    const source = IM.createSource(canvas);
    const fallback = guide || defaultGuide(source.width, source.height);

    let corners = [
        { x: fallback.x0, y: fallback.y0 },
        { x: fallback.x1, y: fallback.y0 },
        { x: fallback.x1, y: fallback.y1 },
        { x: fallback.x0, y: fallback.y1 },
    ];
    let detected = false;

    try {
        const found = IM.detectFromSource(source, fallback);
        if (found) {
            // Se recorta un 2 % hacia adentro: quita la línea del escritorio
            // que queda cuando la detección cae unos píxeles por fuera.
            corners = IM.scaleQuad(found, 0.98);
            detected = true;
        }
    } catch (err) {
        console.warn('[detección]', err);
    }

    state.editor = {
        source,
        corners,
        guide: fallback,
        filter: 'magic',
        intensity: 60,
        mode: 'adjust',
        base: null,
        baseScale: 1,
        previewData: null,
        previewDirty: true,
        dragging: -1,
        drawQueued: false,
        previewTimer: null,
    };

    buildBaseCanvas(state.editor);
    syncEditorControls();
    showView('edit');
    drawEditor();

    dom.editHint.hidden = false;
    dom.editHint.textContent = detected
        ? 'Documento detectado. Puedes ajustar las esquinas.'
        : 'Arrastra las esquinas hasta los bordes del papel';

    queuePreview();
}

function closeEditor() {
    const ed = state.editor;
    if (ed) {
        clearTimeout(ed.previewTimer);
        ed.base = null;
        ed.previewData = null;
    }
    state.editor = null;
    dom.editCanvas.width = 0;
    dom.editCanvas.height = 0;
}

function syncEditorControls() {
    const ed = state.editor;
    if (!ed) return;
    dom.filterChips.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.toggle('is-active', chip.dataset.filter === ed.filter);
    });
    dom.intensity.value = String(ed.intensity);
    dom.intensityOut.textContent = String(ed.intensity);
    dom.intensityRow.hidden = ed.filter === 'original';
    document.querySelectorAll('.seg').forEach((seg) => {
        seg.classList.toggle('is-active', seg.dataset.mode === ed.mode);
    });
}

function requestDraw() {
    const ed = state.editor;
    if (!ed || ed.drawQueued) return;
    ed.drawQueued = true;
    requestAnimationFrame(() => {
        ed.drawQueued = false;
        drawEditor();
    });
}

function drawEditor() {
    const ed = state.editor;
    if (!ed) return;
    const canvas = dom.editCanvas;

    if (ed.mode === 'result') {
        if (!ed.previewData) return;
        if (canvas.width !== ed.previewData.width || canvas.height !== ed.previewData.height) {
            canvas.width = ed.previewData.width;
            canvas.height = ed.previewData.height;
        }
        canvas.getContext('2d').putImageData(ed.previewData, 0, 0);
        dom.editHint.hidden = true;
        return;
    }

    dom.editHint.hidden = false;
    if (canvas.width !== ed.base.width || canvas.height !== ed.base.height) {
        canvas.width = ed.base.width;
        canvas.height = ed.base.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(ed.base, 0, 0);

    const s = ed.baseScale;
    const pts = ed.corners.map((p) => ({ x: p.x * s, y: p.y * s }));

    // Oscurecer lo que queda fuera de la página.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(4, 8, 15, 0.6)';
    ctx.fill('evenodd');

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#12c48b';
    ctx.lineWidth = Math.max(2, canvas.width * 0.0032);
    ctx.lineJoin = 'round';
    ctx.stroke();

    const radius = Math.max(9, canvas.width * 0.016);
    pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#12c48b';
        ctx.fill();
    });
    ctx.restore();
}

function queuePreview() {
    const ed = state.editor;
    if (!ed) return;
    clearTimeout(ed.previewTimer);
    ed.previewTimer = setTimeout(computePreview, 90);
}

function computePreview() {
    const ed = state.editor;
    if (!ed) return;
    try {
        const data = IM.renderPreview(ed.source, ed.corners, ed.filter, ed.intensity);
        ed.previewData = data;
        ed.previewDirty = false;
        if (ed.mode === 'result') requestDraw();
    } catch (err) {
        console.warn('[vista previa]', err);
    }
}

function setMode(mode) {
    const ed = state.editor;
    if (!ed) return;
    ed.mode = mode;
    if (mode === 'result' && (!ed.previewData || ed.previewDirty)) computePreview();
    syncEditorControls();
    drawEditor();
}

function setFilter(filter) {
    const ed = state.editor;
    if (!ed) return;
    ed.filter = filter;
    syncEditorControls();
    queuePreview();
}

function setIntensity(value) {
    const ed = state.editor;
    if (!ed) return;
    ed.intensity = clamp(parseInt(value, 10) || 0, 0, 100);
    dom.intensityOut.textContent = String(ed.intensity);
    queuePreview();
}

function editorPointer(e) {
    const canvas = dom.editCanvas;
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((e.clientX - rect.left) / rect.width) * canvas.width,
        y: ((e.clientY - rect.top) / rect.height) * canvas.height,
        scale: canvas.width / rect.width,
    };
}

function onPointerDown(e) {
    const ed = state.editor;
    if (!ed || ed.mode !== 'adjust') return;
    e.preventDefault();

    const p = editorPointer(e);
    const s = ed.baseScale;
    const hitRadius = 36 * p.scale;

    let best = -1;
    let bestDist = Infinity;
    ed.corners.forEach((corner, index) => {
        const d = Math.hypot(corner.x * s - p.x, corner.y * s - p.y);
        if (d < bestDist && d <= hitRadius) {
            bestDist = d;
            best = index;
        }
    });

    if (best >= 0) {
        ed.dragging = best;
        try {
            dom.editCanvas.setPointerCapture(e.pointerId);
        } catch {
            /* algunos navegadores no dejan capturar punteros sintéticos */
        }
        dom.editCanvas.style.cursor = 'grabbing';
    }
}

function onPointerMove(e) {
    const ed = state.editor;
    if (!ed || ed.dragging < 0) return;
    e.preventDefault();

    const p = editorPointer(e);
    const s = ed.baseScale;
    const corner = ed.corners[ed.dragging];
    corner.x = clamp(p.x / s, 0, ed.source.width);
    corner.y = clamp(p.y / s, 0, ed.source.height);
    ed.previewDirty = true;
    requestDraw();
}

function onPointerUp(e) {
    const ed = state.editor;
    if (!ed) return;
    if (ed.dragging >= 0) {
        ed.dragging = -1;
        dom.editCanvas.style.cursor = '';
        try {
            dom.editCanvas.releasePointerCapture(e.pointerId);
        } catch {
            /* noop */
        }
        queuePreview();
    }
}

function rotateEditor() {
    const ed = state.editor;
    if (!ed) return;

    const rotated = IM.rotateCanvas(ed.source.canvas);
    const corners = IM.rotateCorners(ed.corners, ed.source.width, ed.source.height);

    ed.source = IM.createSource(rotated);
    ed.corners = corners;
    ed.guide = defaultGuide(ed.source.width, ed.source.height);
    ed.previewData = null;

    buildBaseCanvas(ed);
    drawEditor();
    queuePreview();
    toast('Imagen rotada');
}

/* --------------------------- Guardar página --------------------------- */

function setBusy(visible, text = 'Procesando…') {
    dom.editBusy.hidden = !visible;
    if (visible) {
        dom.busyText.textContent = text;
        dom.busyBar.style.width = '0%';
    }
}

async function acceptPage() {
    const ed = state.editor;
    if (!ed) return;

    setBusy(true, 'Generando página…');
    await nextFrame();

    try {
        const page = await IM.renderPage(
            ed.source,
            ed.corners,
            ed.filter,
            ed.intensity,
            MAX_PAGE_DIM,
            (progress) => {
                dom.busyBar.style.width = `${Math.round(progress * 100)}%`;
            }
        );

        const blob = await canvasToBlob(page.canvas, 'image/jpeg', JPEG_QUALITY);
        page.canvas.width = 0;
        page.canvas.height = 0;

        await addPage(blob, page.width, page.height);

        closeEditor();
        showView('scan');
        toast(`Página ${state.pages.length} guardada`);
    } catch (err) {
        console.error(err);
        toast('No se pudo guardar la página', 'error');
    } finally {
        setBusy(false);
    }
}

/* ------------------------------------------------------------------ */
/* Páginas                                                             */
/* ------------------------------------------------------------------ */

async function loadPages() {
    const records = await Store.all();
    state.pages = records.map((record) => ({
        ...record,
        url: URL.createObjectURL(record.blob),
    }));
}

async function addPage(blob, width, height) {
    const record = {
        id: uuid(),
        blob,
        width,
        height,
        pos: state.pages.length,
        createdAt: Date.now(),
    };
    state.pages.push({ ...record, url: URL.createObjectURL(blob) });
    await Store.put(record);
    renderPagesUI();
}

function pageCountLabel(count) {
    return count === 1 ? '1 página' : `${count} páginas`;
}

function renderPagesUI() {
    const count = state.pages.length;

    dom.pagesSub.textContent = count === 0 ? 'Sin páginas todavía' : pageCountLabel(count);
    dom.tabBadge.hidden = count === 0;
    dom.tabBadge.textContent = String(count);
    dom.pagesEmpty.hidden = count > 0;
    dom.pagesGrid.hidden = count === 0;
    dom.exportBtn.disabled = count === 0;
    dom.clearBtn.disabled = count === 0;

    if (count > 0) {
        const last = state.pages[count - 1];
        dom.thumbLast.src = last.url;
        dom.thumbLast.hidden = false;
        // Los elementos SVG no tienen la propiedad `hidden`: se ocultan por estilo.
        dom.thumbIcon.style.display = 'none';
        dom.thumbBadge.hidden = false;
        dom.thumbBadge.textContent = String(count);
    } else {
        dom.thumbLast.hidden = true;
        dom.thumbLast.removeAttribute('src');
        dom.thumbIcon.style.display = '';
        dom.thumbBadge.hidden = true;
    }

    dom.pagesGrid.innerHTML = '';
    state.pages.forEach((page, index) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'page-card';
        card.dataset.index = String(index);
        card.setAttribute('aria-label', `Página ${index + 1}, opciones`);

        const img = document.createElement('img');
        img.src = page.url;
        img.alt = `Página ${index + 1}`;
        img.loading = 'lazy';

        const badge = document.createElement('span');
        badge.className = 'page-num';
        badge.textContent = String(index + 1);

        card.append(img, badge);
        card.addEventListener('click', () => openPageSheet(index));
        dom.pagesGrid.appendChild(card);
    });
}

function openPageSheet(index) {
    const page = state.pages[index];
    if (!page) return;

    openSheet(`
        <h2 id="sheet-title">Página ${index + 1}</h2>
        <p class="sheet-sub">${pageCountLabel(state.pages.length)} en el documento</p>
        <div class="sheet-list">
            <button class="sheet-item" data-act="view">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                Ver en grande
            </button>
            <button class="sheet-item" data-act="rotate">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
                Rotar 90°
            </button>
            <button class="sheet-item" data-act="left" ${index === 0 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                Mover antes
            </button>
            <button class="sheet-item" data-act="right" ${index === state.pages.length - 1 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                Mover después
            </button>
            <button class="sheet-item danger" data-act="delete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                Eliminar página
            </button>
        </div>
    `);

    dom.sheetBody.querySelectorAll('.sheet-item').forEach((item) => {
        item.addEventListener('click', async () => {
            const act = item.dataset.act;
            closeSheet();
            if (act === 'view') openViewer(page.url);
            else if (act === 'rotate') await rotatePage(index);
            else if (act === 'delete') await deletePage(index);
            else if (act === 'left') await movePage(index, -1);
            else if (act === 'right') await movePage(index, 1);
        });
    });
}

function openViewer(url) {
    dom.viewerImg.src = url;
    dom.viewer.hidden = false;
}

async function rotatePage(index) {
    const page = state.pages[index];
    if (!page) return;
    try {
        const img = await loadImage(page.url);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalHeight;
        canvas.height = img.naturalWidth;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(img, 0, 0);

        const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
        canvas.width = 0;
        canvas.height = 0;

        URL.revokeObjectURL(page.url);
        page.blob = blob;
        page.url = URL.createObjectURL(blob);
        page.width = img.naturalHeight;
        page.height = img.naturalWidth;
        await Store.put(stripUrl(page));
        renderPagesUI();
        toast('Página rotada');
    } catch (err) {
        console.error(err);
        toast('No se pudo rotar la página', 'error');
    }
}

async function movePage(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.pages.length) return;
    const [moved] = state.pages.splice(index, 1);
    state.pages.splice(target, 0, moved);
    state.pages.forEach((p, i) => {
        p.pos = i;
    });
    await Store.putMany(state.pages.map(stripUrl));
    renderPagesUI();
}

async function deletePage(index) {
    const page = state.pages[index];
    if (!page) return;
    const ok = await confirmSheet({
        title: 'Eliminar página',
        message: `¿Eliminar la página ${index + 1}? Esta acción no se puede deshacer.`,
        confirmText: 'Eliminar',
        danger: true,
    });
    if (!ok) return;

    URL.revokeObjectURL(page.url);
    state.pages.splice(index, 1);
    state.pages.forEach((p, i) => {
        p.pos = i;
    });
    await Store.remove(page.id);
    await Store.putMany(state.pages.map(stripUrl));
    renderPagesUI();
    toast('Página eliminada');
}

function stripUrl(page) {
    const { url, ...record } = page;
    return record;
}

async function clearPages() {
    state.pages.forEach((page) => URL.revokeObjectURL(page.url));
    state.pages = [];
    await Store.clear();
    renderPagesUI();
}

/* ------------------------------------------------------------------ */
/* Exportación a PDF                                                   */
/* ------------------------------------------------------------------ */

function openExportSheet() {
    if (!state.pages.length) return;
    const count = state.pages.length;

    openSheet(`
        <h2 id="sheet-title">Exportar PDF</h2>
        <p class="sheet-sub">${pageCountLabel(count)} · el archivo se genera en tu dispositivo</p>

        <div class="field">
            <span class="field-label">Tamaño de hoja</span>
            <div class="choice" data-group="size">
                <button class="choice-btn" data-value="a4">A4</button>
                <button class="choice-btn" data-value="letter">Carta</button>
                <button class="choice-btn" data-value="fit">Como la imagen</button>
            </div>
        </div>

        <div class="field">
            <span class="field-label">Calidad</span>
            <div class="choice" data-group="quality">
                <button class="choice-btn" data-value="alta">Alta</button>
                <button class="choice-btn" data-value="media">Media</button>
                <button class="choice-btn" data-value="baja">Baja (más liviano)</button>
            </div>
        </div>

        <div class="switch-row">
            <div class="switch-text">
                Borrar las páginas al terminar
                <small>Se eliminan del dispositivo después de descargar</small>
            </div>
            <button class="switch" data-toggle="purge" aria-label="Borrar páginas al exportar"></button>
        </div>

        <div class="sheet-actions">
            <button class="btn ghost" data-action="cancel">Cancelar</button>
            <button class="btn primary" data-action="export">Exportar PDF</button>
        </div>
    `);

    const syncChoices = () => {
        dom.sheetBody.querySelectorAll('.choice[data-group]').forEach((group) => {
            const key = group.dataset.group;
            group.querySelectorAll('.choice-btn').forEach((btn) => {
                btn.classList.toggle('is-active', state.export[key] === btn.dataset.value);
            });
        });
        const toggle = dom.sheetBody.querySelector('[data-toggle="purge"]');
        if (toggle) toggle.classList.toggle('is-on', state.export.purge);
    };

    dom.sheetBody.querySelectorAll('.choice[data-group]').forEach((group) => {
        group.querySelectorAll('.choice-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.export[group.dataset.group] = btn.dataset.value;
                syncChoices();
            });
        });
    });

    const toggle = dom.sheetBody.querySelector('[data-toggle="purge"]');
    toggle.addEventListener('click', () => {
        state.export.purge = !state.export.purge;
        syncChoices();
    });

    dom.sheetBody.querySelector('[data-action="cancel"]').addEventListener('click', () => closeSheet());
    dom.sheetBody.querySelector('[data-action="export"]').addEventListener('click', () => runExport());

    syncChoices();
}

async function runExport() {
    const options = { size: state.export.size, quality: state.export.quality };
    const purge = state.export.purge;
    const count = state.pages.length;

    sheetProgress('Generando PDF', 'Preparando páginas…');
    await nextFrame();

    try {
        const blob = await buildPdf(state.pages, options, (progress, message) => {
            updateSheetProgress(progress, message);
        });

        await sleep(150);
        downloadBlob(blob, pdfFileName());

        if (purge) await clearPages();

        closeSheet();
        showView('pages');
        toast(
            purge
                ? `PDF descargado. Se borraron ${count} ${count === 1 ? 'página' : 'páginas'}.`
                : 'PDF descargado.',
            'info',
            4200
        );
    } catch (err) {
        console.error(err);
        closeSheet();
        toast('No se pudo generar el PDF. Intenta de nuevo.', 'error', 4200);
    }
}

/* ------------------------------------------------------------------ */
/* Importar imágenes                                                   */
/* ------------------------------------------------------------------ */

async function imageFileToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await loadImage(url);
        const vw = img.naturalWidth;
        const vh = img.naturalHeight;
        const scale = Math.min(1, MAX_CAPTURE_DIM / Math.max(vw, vh), Math.sqrt(MAX_CAPTURE_PIXELS / (vw * vh)));

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vw * scale));
        canvas.height = Math.max(1, Math.round(vh * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
        toast('Ese archivo no es una imagen', 'error');
        return;
    }

    if (files.length === 1) {
        try {
            const canvas = await imageFileToCanvas(files[0]);
            openEditor(canvas, defaultGuide(canvas.width, canvas.height));
        } catch (err) {
            console.error(err);
            toast('No se pudo abrir la imagen', 'error');
        }
        return;
    }

    // Varias imágenes: se agregan en lote con detección y filtro automáticos.
    sheetProgress('Agregando imágenes', `0 de ${files.length}`);
    await nextFrame();

    try {
        for (let i = 0; i < files.length; i++) {
            const canvas = await imageFileToCanvas(files[i]);
            const source = IM.createSource(canvas);
            const guide = defaultGuide(source.width, source.height);
            let corners = [
                { x: guide.x0, y: guide.y0 },
                { x: guide.x1, y: guide.y0 },
                { x: guide.x1, y: guide.y1 },
                { x: guide.x0, y: guide.y1 },
            ];
            try {
                const found = IM.detectFromSource(source, guide);
                if (found) corners = IM.scaleQuad(found, 0.98);
            } catch {
                /* usa el recuadro por defecto */
            }

            const page = await IM.renderPage(source, corners, 'magic', 60, MAX_PAGE_DIM);
            const blob = await canvasToBlob(page.canvas, 'image/jpeg', JPEG_QUALITY);
            page.canvas.width = 0;
            page.canvas.height = 0;
            await addPage(blob, page.width, page.height);

            updateSheetProgress((i + 1) / files.length, `${i + 1} de ${files.length}`);
            await sleep(10);
        }
        closeSheet();
        showView('pages');
        toast(`${files.length} páginas agregadas`);
    } catch (err) {
        console.error(err);
        closeSheet();
        toast('Hubo un problema con alguna imagen', 'error');
    }
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function bindEvents() {
    // Cámara
    dom.shutter.addEventListener('click', captureFrame);
    dom.torch.addEventListener('click', toggleTorch);
    dom.flip.addEventListener('click', switchCamera);
    dom.thumbBtn.addEventListener('click', () => showView('pages'));

    $('btn-retry-cam').addEventListener('click', () => {
        hideCameraBlocked();
        startCamera();
    });
    $('btn-native-cam').addEventListener('click', () => dom.fileCamera.click());
    $('btn-import-photo').addEventListener('click', () => dom.fileImport.click());

    // Navegación
    document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => showView(tab.dataset.nav));
    });

    $('btn-add-page').addEventListener('click', () => showView('scan'));
    $('btn-empty-scan').addEventListener('click', () => showView('scan'));

    // Herramientas
    document.querySelectorAll('.tool-card').forEach((card) => {
        card.addEventListener('click', () => tools.open(card.dataset.tool));
    });
    $('tool-back').addEventListener('click', () => showView('tools'));

    // Editor
    $('btn-edit-cancel').addEventListener('click', () => {
        closeEditor();
        showView('scan');
    });
    $('btn-retake').addEventListener('click', () => {
        closeEditor();
        showView('scan');
    });
    $('btn-rotate').addEventListener('click', rotateEditor);
    $('btn-accept').addEventListener('click', acceptPage);

    document.querySelectorAll('.seg').forEach((seg) => {
        seg.addEventListener('click', () => setMode(seg.dataset.mode));
    });

    dom.filterChips.addEventListener('click', (event) => {
        const chip = event.target.closest('.chip');
        if (chip) setFilter(chip.dataset.filter);
    });

    dom.intensity.addEventListener('input', (event) => setIntensity(event.target.value));

    dom.editCanvas.addEventListener('pointerdown', onPointerDown);
    dom.editCanvas.addEventListener('pointermove', onPointerMove);
    dom.editCanvas.addEventListener('pointerup', onPointerUp);
    dom.editCanvas.addEventListener('pointercancel', onPointerUp);

    // Páginas
    dom.exportBtn.addEventListener('click', openExportSheet);
    dom.clearBtn.addEventListener('click', async () => {
        const ok = await confirmSheet({
            title: 'Vaciar documento',
            message: 'Se eliminarán todas las páginas guardadas en este dispositivo. Esta acción no se puede deshacer.',
            confirmText: 'Vaciar',
            danger: true,
        });
        if (ok) {
            await clearPages();
            toast('Documento vaciado');
        }
    });

    // Hoja inferior
    dom.overlay.addEventListener('click', () => closeSheet(false));

    // Visor
    $('viewer-close').addEventListener('click', () => {
        dom.viewer.hidden = true;
        dom.viewerImg.removeAttribute('src');
    });

    // Archivos
    dom.fileImport.addEventListener('change', (event) => {
        handleFiles(event.target.files);
        event.target.value = '';
    });
    dom.fileCamera.addEventListener('change', (event) => {
        handleFiles(event.target.files);
        event.target.value = '';
    });

    // Visibilidad: ahorrar batería y liberar la cámara en segundo plano.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopLiveDetection();
            stopCamera();
        } else if (state.view === 'scan') {
            startCameraIfNeeded();
            startLiveDetection();
        }
    });

    window.addEventListener('pagehide', () => stopCamera());

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (!dom.viewer.hidden) {
                dom.viewer.hidden = true;
                return;
            }
            if (!dom.sheet.hidden) {
                closeSheet(false);
                return;
            }
            if (state.view === 'edit') {
                closeEditor();
                showView('scan');
            }
        }
    });
}

/* ------------------------------------------------------------------ */
/* Service worker (funcionamiento sin conexión)                        */
/* ------------------------------------------------------------------ */

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        return;
    }

    const register = () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('[sw]', err);
        });
    };

    // El arranque es asíncrono: puede que el evento `load` ya haya pasado.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

// Las herramientas comparten los avisos y las hojas inferiores de la app.
const tools = initTools({ showView, toast, openSheet, closeSheet, nextFrame });

async function boot() {
    setBoot('Cargando tus páginas…');

    try {
        await loadPages();
    } catch (err) {
        console.warn(err);
    }

    bindEvents();
    registerServiceWorker();
    renderPagesUI();

    setBoot('Listo');
    hideBoot();

    // Un instante para que se pinte la interfaz antes de pedir la cámara.
    await nextFrame();
    showView('scan');
}

// Expuesto para depuración y pruebas automatizadas.
window.__SCAN__ = { state, showView, captureFrame, openEditor, renderPagesUI };

boot();
