/**
 * pdf.js — Exportación a PDF con jsPDF (cargado localmente, sin CDN).
 *
 * Cada página se coloca respetando su proporción real (nada de estirar la
 * imagen), con tamaño de hoja configurable y compresión activada.
 */

const PAGE_SIZES = {
    a4: [210, 297],
    letter: [215.9, 279.4],
};

const QUALITY_PRESETS = {
    alta: { quality: 0.92, maxLong: 2600 },
    media: { quality: 0.8, maxLong: 2000 },
    baja: { quality: 0.6, maxLong: 1500 },
};

let jsPdfPromise = null;

/** Espera a que jsPDF esté disponible (se carga con un <script> normal). */
export function loadJsPdf() {
    if (jsPdfPromise) return jsPdfPromise;
    jsPdfPromise = (async () => {
        for (let i = 0; i < 200; i++) {
            if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('No se pudo cargar la librería para generar PDF');
    })();
    return jsPdfPromise;
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo leer una de las imágenes'));
        img.src = url;
    });
}

/**
 * Vuelve a codificar la página en JPEG con la calidad pedida.
 * Devuelve el data URL y las dimensiones finales.
 */
async function encodePage(blob, preset) {
    const url = URL.createObjectURL(blob);
    try {
        const img = await loadImage(url);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, preset.maxLong / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);

        const dataUrl = canvas.toDataURL('image/jpeg', preset.quality);
        canvas.width = 0;
        canvas.height = 0;
        return { dataUrl, width: w, height: h };
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Dimensiones de hoja en mm y orientación para una imagen dada. */
function pageFormat(sizeKey, imgW, imgH) {
    if (sizeKey === 'fit') {
        const mm = 25.4 / 300; // 300 ppp
        return {
            format: [Math.max(10, imgW * mm), Math.max(10, imgH * mm)],
            orientation: imgW > imgH ? 'landscape' : 'portrait',
            margin: 0,
        };
    }
    const [shortSide, longSide] = PAGE_SIZES[sizeKey] || PAGE_SIZES.a4;
    const landscape = imgW > imgH;
    return {
        format: landscape ? [longSide, shortSide] : [shortSide, longSide],
        orientation: landscape ? 'landscape' : 'portrait',
        margin: 6,
    };
}

/**
 * Genera el PDF y devuelve un Blob.
 *
 * @param {Array<{blob: Blob, width: number, height: number}>} pages
 * @param {{size?: 'a4'|'letter'|'fit', quality?: 'alta'|'media'|'baja'}} options
 * @param {(progress: number, message: string) => void} [onProgress]
 */
export async function buildPdf(pages, options = {}, onProgress = () => {}) {
    if (!pages.length) throw new Error('No hay páginas para exportar');

    const JsPDF = await loadJsPdf();
    const preset = QUALITY_PRESETS[options.quality] || QUALITY_PRESETS.alta;
    const sizeKey = options.size || 'a4';

    onProgress(0.02, 'Preparando páginas…');
    const first = await encodePage(pages[0].blob, preset);
    const firstFormat = pageFormat(sizeKey, first.width, first.height);

    const doc = new JsPDF({
        unit: 'mm',
        format: firstFormat.format,
        orientation: firstFormat.orientation,
        compress: true,
    });

    doc.setProperties({
        title: 'Documento escaneado',
        subject: 'Escaneo realizado con Escáner (procesamiento local)',
        creator: 'Escáner de documentos',
    });

    const place = (encoded, format) => {
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = format.margin;
        const boxW = pageW - margin * 2;
        const boxH = pageH - margin * 2;
        const scale = Math.min(boxW / encoded.width, boxH / encoded.height);
        const w = encoded.width * scale;
        const h = encoded.height * scale;
        const x = (pageW - w) / 2;
        const y = (pageH - h) / 2;
        doc.addImage(encoded.dataUrl, 'JPEG', x, y, w, h, undefined, 'FAST');
    };

    place(first, firstFormat);

    for (let i = 1; i < pages.length; i++) {
        const encoded = await encodePage(pages[i].blob, preset);
        const format = pageFormat(sizeKey, encoded.width, encoded.height);
        doc.addPage(format.format, format.orientation);
        place(encoded, format);
        onProgress(0.02 + (0.92 * (i + 1)) / pages.length, `Página ${i + 1} de ${pages.length}`);
        // Ceder el hilo para que la barra de progreso se actualice.
        await new Promise((r) => setTimeout(r, 0));
    }

    onProgress(0.97, 'Cerrando el PDF…');
    const blob = doc.output('blob');
    onProgress(1, 'Listo');
    return blob;
}

/** Fuerza la descarga de un Blob con un nombre de archivo. */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // En iOS la descarga puede tardar; se libera con margen.
    setTimeout(() => URL.revokeObjectURL(url), 120000);
}

/** Nombre de archivo con la fecha del día. */
export function pdfFileName(prefix = 'Escaneo') {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${prefix}_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.pdf`;
}
