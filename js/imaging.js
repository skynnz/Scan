/**
 * imaging.js — Motor de imagen 100% local y sin dependencias externas.
 *
 * Contiene:
 *  - Geometría de perspectiva (homografía) para "enderezar" el documento.
 *  - Extracción de la página a partir de 4 esquinas.
 *  - Filtros: original, color mágico (quita sombras), gris y blanco y negro adaptativo.
 *  - Detección automática de las esquinas del documento.
 *
 * Todo se ejecuta en el dispositivo del usuario: ninguna imagen sale del navegador.
 */

/* ------------------------------------------------------------------ */
/* Utilidades básicas                                                  */
/* ------------------------------------------------------------------ */

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
const odd = (n) => (n % 2 === 0 ? n + 1 : n);

/** Distancia euclidiana entre dos puntos. */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Ordena 4 puntos como [sup-izq, sup-der, inf-der, inf-izq].
 * Funciona con documentos rotados hasta ~45°.
 */
export function orderCorners(points) {
  if (!points || points.length !== 4) return [];

  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;

  // Con el eje Y hacia abajo, ordenar por ángulo produce sentido horario.
  const sorted = points
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Rotar para que el primero sea la esquina superior izquierda.
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  const out = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);

  // Garantizar el sentido horario (producto cruz positivo con Y hacia abajo).
  const cross =
    (out[1].x - out[0].x) * (out[2].y - out[1].y) -
    (out[1].y - out[0].y) * (out[2].x - out[1].x);
  if (cross < 0) {
    const tmp = out[1];
    out[1] = out[3];
    out[3] = tmp;
  }

  return out.map((p) => ({ x: p.x, y: p.y }));
}

/** Tamaño natural (en píxeles) del rectángulo que describen las esquinas. */
export function quadSize(corners) {
  return {
    w: Math.max(1, Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])))),
    h: Math.max(1, Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])))),
  };
}

/** Área de un cuadrilátero (fórmula del zapato). */
function polygonArea(q) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** ¿El cuadrilátero es convexo y con un área razonable? */
function isPlausibleQuad(q, w, h) {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const signs = [cross(q[0], q[1], q[2]), cross(q[1], q[2], q[3]), cross(q[2], q[3], q[0]), cross(q[3], q[0], q[1])];
  if (signs.some((s) => s <= 0)) return false;

  const ratio = polygonArea(q) / (w * h);
  if (ratio < 0.12 || ratio > 0.99) return false;

  const sides = [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])];
  const minSide = Math.min(...sides);
  if (minSide < Math.min(w, h) * 0.12) return false;

  const aspect = (sides[0] + sides[2]) / (sides[1] + sides[3]);
  if (aspect < 0.28 || aspect > 3.6) return false;

  // Ninguna esquina puede quedar muy fuera de la imagen.
  const margin = Math.max(w, h) * 0.08;
  for (const p of q) {
    if (p.x < -margin || p.y < -margin || p.x > w + margin || p.y > h + margin) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Homografía                                                          */
/* ------------------------------------------------------------------ */

/**
 * Matriz de homografía que lleva los 4 puntos `from` a los 4 puntos `to`.
 * Devuelve un array de 9 números en orden fila por fila.
 */
export function homography(from, to) {
  const A = new Float64Array(64);
  const b = new Float64Array(8);

  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    const r = i * 2;
    A[r * 8 + 0] = x; A[r * 8 + 1] = y; A[r * 8 + 2] = 1;
    A[r * 8 + 3] = 0; A[r * 8 + 4] = 0; A[r * 8 + 5] = 0;
    A[r * 8 + 6] = -x * u; A[r * 8 + 7] = -y * u;
    b[r] = u;

    A[(r + 1) * 8 + 0] = 0; A[(r + 1) * 8 + 1] = 0; A[(r + 1) * 8 + 2] = 0;
    A[(r + 1) * 8 + 3] = x; A[(r + 1) * 8 + 4] = y; A[(r + 1) * 8 + 5] = 1;
    A[(r + 1) * 8 + 6] = -x * v; A[(r + 1) * 8 + 7] = -y * v;
    b[r + 1] = v;
  }

  // Eliminación gaussiana con pivoteo parcial.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row * 8 + col]) > Math.abs(A[pivot * 8 + col])) pivot = row;
    }
    if (Math.abs(A[pivot * 8 + col]) < 1e-12) return null;
    if (pivot !== col) {
      for (let k = 0; k < 8; k++) {
        const tmp = A[col * 8 + k];
        A[col * 8 + k] = A[pivot * 8 + k];
        A[pivot * 8 + k] = tmp;
      }
      const tmpB = b[col];
      b[col] = b[pivot];
      b[pivot] = tmpB;
    }
    const d = A[col * 8 + col];
    for (let row = col + 1; row < 8; row++) {
      const f = A[row * 8 + col] / d;
      if (f === 0) continue;
      for (let k = col; k < 8; k++) A[row * 8 + k] -= f * A[col * 8 + k];
      b[row] -= f * b[col];
    }
  }

  const h = new Float64Array(8);
  for (let row = 7; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < 8; k++) sum -= A[row * 8 + k] * h[k];
    h[row] = sum / A[row * 8 + row];
  }

  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Endereza el cuadrilátero `srcQuad` de la imagen de origen y lo dibuja
 * en el rectángulo completo de destino (dstW × dstH).
 *
 * `srcQuad` y `dstQuad` deben venir en este orden: sup-izq, sup-der, inf-der, inf-izq.
 * El muestreo bilineal da texto nítido; el área fuera del original queda en blanco.
 */
export function warpQuad(src, srcW, srcH, srcQuad, dstW, dstH, dstQuad, opts = {}) {
  const { onProgress = null, rowsPerChunk = 0, transparentOutside = false } = opts;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const H = homography(dstQuad, srcQuad);
  if (!H) return out;

  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let y = 0; y < dstH; y++) {
    const py = y + 0.5;
    const bx = h1 * py + h2;
    const by = h4 * py + h5;
    const bd = h7 * py + h8;
    let o = y * dstW * 4;

    for (let x = 0; x < dstW; x++, o += 4) {
      const px = x + 0.5;
      const den = h6 * px + bd;
      const u = (h0 * px + bx) / den;
      const v = (h3 * px + by) / den;

      if (u < 0 || v < 0 || u > maxX || v > maxY) {
        if (!transparentOutside) {
          out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
        }
        continue;
      }

      const x0 = u | 0;
      const y0 = v | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = u - x0;
      const fy = v - y0;

      const i00 = (y0 * srcW + x0) << 2;
      const i10 = (y0 * srcW + x1) << 2;
      const i01 = (y1 * srcW + x0) << 2;
      const i11 = (y1 * srcW + x1) << 2;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      out[o]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      out[o + 3] = 255;
    }

    if (onProgress && rowsPerChunk > 0 && y % rowsPerChunk === 0) {
      onProgress(y / dstH);
    }
  }

  if (onProgress) onProgress(1);
  return out;
}

/**
 * Igual que warpQuad pero cede el hilo entre bloques de filas para que la
 * interfaz pueda mostrar progreso (evita el "se congeló" en móviles).
 */
export async function warpQuadAsync(src, srcW, srcH, srcQuad, dstW, dstH, dstQuad, opts = {}) {
  const { onProgress = null, rowsPerChunk = 128 } = opts;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const H = homography(dstQuad, srcQuad);
  if (!H) return out;

  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let y0 = 0; y0 < dstH; y0 += rowsPerChunk) {
    const yEnd = Math.min(dstH, y0 + rowsPerChunk);
    for (let y = y0; y < yEnd; y++) {
      const py = y + 0.5;
      const bx = h1 * py + h2;
      const by = h4 * py + h5;
      const bd = h7 * py + h8;
      let o = y * dstW * 4;

      for (let x = 0; x < dstW; x++, o += 4) {
        const px = x + 0.5;
        const den = h6 * px + bd;
        const u = (h0 * px + bx) / den;
        const v = (h3 * px + by) / den;

        if (u < 0 || v < 0 || u > maxX || v > maxY) {
          out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
          continue;
        }

        const ix = u | 0;
        const iy = v | 0;
        const ix1 = ix < maxX ? ix + 1 : ix;
        const iy1 = iy < maxY ? iy + 1 : iy;
        const fx = u - ix;
        const fy = v - iy;

        const i00 = (iy * srcW + ix) << 2;
        const i10 = (iy * srcW + ix1) << 2;
        const i01 = (iy1 * srcW + ix) << 2;
        const i11 = (iy1 * srcW + ix1) << 2;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        out[o]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11;
        out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
        out[o + 3] = 255;
      }
    }

    if (onProgress) onProgress(yEnd / dstH);
    // Ceder el hilo: permite repintar la barra de progreso.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Integrales y filtros                                                */
/* ------------------------------------------------------------------ */

/** Imagen integral (summed-area table) para promedios locales O(1). */
function integralImage(src, w, h) {
  const I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const row = (y + 1) * (w + 1);
    const prev = y * (w + 1);
    const srcRow = y * w;
    for (let x = 0; x < w; x++) {
      rowSum += src[srcRow + x];
      I[row + x + 1] = I[prev + x + 1] + rowSum;
    }
  }
  return I;
}

/** Luminancia aproximada (0-255) de un ImageData RGBA. */
function luminance(data, n) {
  const lum = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return lum;
}

/**
 * Aplica un filtro al ImageData (lo modifica en sitio y lo devuelve).
 *
 * Filtros:
 *  - 'original': sin cambios.
 *  - 'magic'   : quita sombras y blanquea el papel conservando el color de la tinta.
 *  - 'gray'    : escala de grises limpia, también sin sombras.
 *  - 'bw'      : blanco y negro adaptativo (el clásico "fotocopia").
 *
 * `intensity` va de 0 a 100 y controla cuánta "limpieza" se aplica.
 */
export function applyFilter(img, filter, intensity = 60) {
  if (!img || filter === 'original') return img;

  const { data, width, height } = img;
  const n = width * height;
  const t = clamp(intensity, 0, 100) / 100;
  const lum = luminance(data, n);

  if (filter === 'bw') {
    const block = odd(clamp(Math.round(Math.min(width, height) * (0.006 + 0.014 * t)), 15, 81));
    const C = 3 + 17 * t;
    const r = block >> 1;
    const I = integralImage(lum, width, height);
    const W = width + 1;

    for (let y = 0; y < height; y++) {
      const y0 = y - r < 0 ? 0 : y - r;
      const y1 = y + r >= height ? height - 1 : y + r;
      const rowA = y0 * W;
      const rowB = (y1 + 1) * W;
      const count = (y1 - y0 + 1);

      for (let x = 0; x < width; x++) {
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r >= width ? width - 1 : x + r;
        const sum = I[rowB + x1 + 1] - I[rowA + x1 + 1] - I[rowB + x0] + I[rowA + x0];
        const mean = sum / (count * (x1 - x0 + 1));
        const v = lum[y * width + x] > mean - C ? 255 : 0;
        const p = (y * width + x) << 2;
        data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
      }
    }
    return img;
  }

  // 'magic' y 'gray' comparten la normalización por fondo local.
  const radius = Math.max(6, Math.round(Math.min(width, height) * 0.09));
  const I = integralImage(lum, width, height);
  const W = width + 1;
  const strength = 0.35 + 0.65 * t;
  const gray = filter === 'gray';

  for (let y = 0; y < height; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius >= height ? height - 1 : y + radius;
    const rowA = y0 * W;
    const rowB = (y1 + 1) * W;
    const count = (y1 - y0 + 1);

    for (let x = 0; x < width; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= width ? width - 1 : x + radius;
      const sum = I[rowB + x1 + 1] - I[rowA + x1 + 1] - I[rowB + x0] + I[rowA + x0];
      const mean = sum / (count * (x1 - x0 + 1));
      const bg = mean < 8 ? 8 : mean;
      const gain = Math.pow(255 / bg, strength);

      const p = (y * width + x) << 2;

      if (gray) {
        const v = lum[y * width + x] * gain;
        data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
      } else {
        let r = data[p] * gain;
        let g = data[p + 1] * gain;
        let b = data[p + 2] * gain;

        // Saturar solo la tinta: si se aplica al papel, amplifica el tinte
        // cálido y deja manchas amarillentas.
        if (lum[y * width + x] < 210) {
          const avg = (r + g + b) / 3;
          const sat = 1 + 0.18 * t;
          r = avg + (r - avg) * sat;
          g = avg + (g - avg) * sat;
          b = avg + (b - avg) * sat;
        }

        // El papel debe quedar blanco puro, sin dominantes de color.
        if (r > 226 && g > 226 && b > 226) {
          r = 255; g = 255; b = 255;
        }

        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }
  }

  return img;
}

/* ------------------------------------------------------------------ */
/* Detección automática de esquinas                                    */
/* ------------------------------------------------------------------ */

/** Ajuste de recta por mínimos cuadrados totales con un recorte de atípicos. */
function fitLine(points) {
  if (points.length < 12) return null;

  const fit = (pts) => {
    const n = pts.length;
    let mx = 0;
    let my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;

    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    if (sxx + syy < 1e-6) return null;

    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) };
  };

  let line = fit(points);
  if (!line) return null;

  // Distancia perpendicular de cada punto a la recta.
  const residuals = points.map((p) => Math.abs((p.x - line.px) * line.dy - (p.y - line.py) * line.dx));
  const sortedRes = residuals.slice().sort((a, b) => a - b);
  const median = sortedRes[Math.floor(sortedRes.length / 2)] || 0;
  const limit = Math.max(median * 3, 2.5);

  const inliers = points.filter((_, i) => residuals[i] <= limit);
  if (inliers.length >= 12) {
    line = fit(inliers) || line;
    line.support = inliers.length / points.length;
  } else {
    line.support = 0;
  }
  return line;
}

function intersectLines(a, b) {
  if (!a || !b) return null;
  const det = a.dx * -b.dy - a.dy * -b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b.px - a.px) * -b.dy - (b.py - a.py) * -b.dx) / det;
  return { x: a.px + t * a.dx, y: a.py + t * a.dy };
}

/**
 * Detector de documento.
 *
 * Trabaja sobre una imagen pequeña (≈520 px) y usa la guía de encuadre como
 * "pista": recorre cada lado desde afuera hacia adentro y se queda con el
 * primer borde fuerte que encuentra. Buscar desde el borde exterior (en vez
 * del gradiente más intenso) evita confundirse con encabezados de color,
 * tablas o sellos dentro de la hoja.
 *
 * Los gradientes se calculan por canal (R, G, B) y se toma el mayor, así se
 * detectan bordes entre colores de luminancia parecida (papel azul sobre mesa
 * marrón, por ejemplo).
 *
 * @param {ImageData} img
 * @param {{x0:number,y0:number,x1:number,y1:number}} guide  rectángulo esperado
 * @returns {Array<{x:number,y:number}>|null} esquinas ordenadas o null
 */
export function detectQuad(img, guide) {
  const w = img.width;
  const h = img.height;
  if (w < 40 || h < 40) return null;
  const src = img.data;
  const n = w * h;

  // Suavizado 3x3 de cada canal (reduce ruido de sensor y de compresión).
  const chan = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 3; c++) {
    const out = chan[c];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const row = yy * w;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += src[(row + xx) * 4 + c];
            cnt++;
          }
        }
        out[y * w + x] = sum / cnt;
      }
    }
  }

  // Gradientes de Sobel: se guarda el máximo entre canales para cada eje.
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  let maxGrad = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let bestX = 0;
      let bestY = 0;
      for (let c = 0; c < 3; c++) {
        const ch = chan[c];
        const tl = ch[i - w - 1], tc = ch[i - w], tr = ch[i - w + 1];
        const ml = ch[i - 1], mr = ch[i + 1];
        const bl = ch[i + w - 1], bc = ch[i + w], br = ch[i + w + 1];
        const sx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const sy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        if (Math.abs(sx) > Math.abs(bestX)) bestX = sx;
        if (Math.abs(sy) > Math.abs(bestY)) bestY = sy;
      }
      gx[i] = Math.abs(bestX);
      gy[i] = Math.abs(bestY);
      const mag = gx[i] + gy[i];
      if (mag > maxGrad) maxGrad = mag;
    }
  }
  if (maxGrad < 16) return null;

  const gx0 = guide ? guide.x0 : w * 0.06;
  const gx1 = guide ? guide.x1 : w * 0.94;
  const gy0 = guide ? guide.y0 : h * 0.06;
  const gy1 = guide ? guide.y1 : h * 0.94;

  // Banda de búsqueda asimétrica: poca holgura hacia afuera (para no tomar
  // sombras u objetos del fondo) y bastante hacia adentro (el documento puede
  // estar más chico que el recuadro, sobre todo al importar una foto).
  const bandOutY = Math.max(5, (gy1 - gy0) * 0.1);
  const bandInY = Math.max(8, (gy1 - gy0) * 0.34);
  const bandOutX = Math.max(5, (gx1 - gx0) * 0.1);
  const bandInX = Math.max(8, (gx1 - gx0) * 0.34);

  const collect = (axis, expected, from, to, bandOut, bandIn) => {
    const pts = [];
    const grad = axis === 'y' ? gy : gx;
    const limit = axis === 'y' ? h : w;
    // Desde afuera hacia adentro: arriba/izquierda suben, abajo/derecha bajan.
    const fromOutside = expected < limit / 2;
    const lo = Math.max(2, Math.round(expected - (fromOutside ? bandOut : bandIn)));
    const hi = Math.min(limit - 3, Math.round(expected + (fromOutside ? bandIn : bandOut)));
    const step = fromOutside ? 1 : -1;
    const start = fromOutside ? lo : hi;
    const end = fromOutside ? hi : lo;

    const advance = (p) => (fromOutside ? p <= end : p >= end);

    for (let s = from; s <= to; s += 2) {
      // 1) Intensidad máxima dentro de la banda (referencia local).
      let bmax = 0;
      let bestPos = -1;
      for (let p = start; advance(p); p += step) {
        const v = axis === 'y' ? grad[p * w + s] : grad[s * w + p];
        if (v > bmax) {
          bmax = v;
          bestPos = p;
        }
      }
      if (bmax < 18) continue;

      // 2) Primer borde que supere un umbral relativo a esa banda.
      //    Así el ruido del fondo no se confunde con el borde del papel.
      const threshold = Math.max(20, bmax * 0.22);
      let hit = -1;
      for (let p = start; advance(p); p += step) {
        const v = axis === 'y' ? grad[p * w + s] : grad[s * w + p];
        if (v > threshold) {
          const q = p + step;
          if (q >= 0 && q < limit) {
            const v2 = axis === 'y' ? grad[q * w + s] : grad[s * w + q];
            if (v2 > threshold) {
              hit = p;
              break;
            }
          }
        }
      }

      const pos = hit >= 0 ? hit : bmax > 45 ? bestPos : -1;
      if (pos >= 0) {
        pts.push(axis === 'y' ? { x: s, y: pos } : { x: pos, y: s });
      }
    }
    return pts;
  };

  const top = fitLine(collect('y', gy0, Math.round(gx0), Math.round(gx1), bandOutY, bandInY));
  const bottom = fitLine(collect('y', gy1, Math.round(gx0), Math.round(gx1), bandOutY, bandInY));
  const left = fitLine(collect('x', gx0, Math.round(gy0), Math.round(gy1), bandOutX, bandInX));
  const right = fitLine(collect('x', gx1, Math.round(gy0), Math.round(gy1), bandOutX, bandInX));

  if (!top || !bottom || !left || !right) return null;
  if ([top, bottom, left, right].some((l) => l.support < 0.4)) return null;

  const tl = intersectLines(top, left);
  const tr = intersectLines(top, right);
  const br = intersectLines(bottom, right);
  const bl = intersectLines(bottom, left);
  if (!tl || !tr || !br || !bl) return null;

  const quad = orderCorners([tl, tr, br, bl]);
  if (!isPlausibleQuad(quad, w, h)) return null;

  // Coherencia con la guía: si el detector se fue a una zona mucho más chica
  // (un sello, una tabla, una foto dentro de la hoja) o a un lugar lejano,
  // es preferible quedarse con el recuadro que el usuario está encuadrando.
  if (guide) {
    const guideArea = Math.max(1, (guide.x1 - guide.x0) * (guide.y1 - guide.y0));
    const ratio = polygonArea(quad) / guideArea;
    if (ratio < 0.35 || ratio > 2.5) return null;

    const gcx = (guide.x0 + guide.x1) / 2;
    const gcy = (guide.y0 + guide.y1) / 2;
    const qcx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const qcy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    const dist = Math.hypot(qcx - gcx, qcy - gcy);
    const guideDiag = Math.hypot(guide.x1 - guide.x0, guide.y1 - guide.y0);
    if (dist > guideDiag * 0.45) return null;
  }

  return quad;
}

/* ------------------------------------------------------------------ */
/* Fuente de imagen y extracción de páginas                            */
/* ------------------------------------------------------------------ */

/**
 * Prepara un canvas como fuente de trabajo: guarda la imagen completa y una
 * versión reducida para la vista previa en vivo.
 */
export function createSource(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const full = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const maxPreview = 860;
  const scale = Math.min(1, maxPreview / Math.max(canvas.width, canvas.height));
  const pw = Math.max(1, Math.round(canvas.width * scale));
  const ph = Math.max(1, Math.round(canvas.height * scale));

  const pc = document.createElement('canvas');
  pc.width = pw;
  pc.height = ph;
  const pctx = pc.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(canvas, 0, 0, pw, ph);
  const preview = pctx.getImageData(0, 0, pw, ph);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    full,
    preview,
    previewScale: pw / canvas.width,
  };
}

/** Escala las esquinas de la imagen completa al espacio de la vista previa. */
export function scaleCorners(corners, scale) {
  return corners.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

/**
 * Encoge (o agranda) el cuadrilátero respecto a su centro.
 * Se usa para recortar un pelín el borde del papel detectado y que no quede
 * la línea del escritorio en la página final.
 */
export function scaleQuad(corners, factor) {
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
  return corners.map((p) => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

/**
 * Genera la página final (enderezada y filtrada) a resolución completa.
 * @returns {Promise<{canvas: HTMLCanvasElement, width:number, height:number}>}
 */
export async function renderPage(source, corners, filter, intensity, maxLong, onProgress) {
  const quad = orderCorners(corners);
  const natural = quadSize(quad);

  let scale = Math.min(1, maxLong / Math.max(natural.w, natural.h));
  const outW = Math.max(1, Math.round(natural.w * scale));
  const outH = Math.max(1, Math.round(natural.h * scale));

  const data = await warpQuadAsync(
    source.full.data,
    source.width,
    source.height,
    quad,
    outW,
    outH,
    [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ],
    { onProgress: (p) => onProgress && onProgress(p * 0.85) }
  );

  const imgData = new ImageData(data, outW, outH);
  applyFilter(imgData, filter, intensity);
  if (onProgress) onProgress(1);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext('2d').putImageData(imgData, 0, 0);
  return { canvas, width: outW, height: outH };
}

/** Versión rápida y reducida de renderPage para la previsualización en vivo. */
export function renderPreview(source, corners, filter, intensity) {
  const quad = orderCorners(scaleCorners(corners, source.previewScale));
  const natural = quadSize(quad);

  const maxLong = 900;
  const scale = Math.min(1, maxLong / Math.max(natural.w, natural.h));
  const outW = Math.max(1, Math.round(natural.w * scale));
  const outH = Math.max(1, Math.round(natural.h * scale));

  const data = warpQuad(
    source.preview.data,
    source.preview.width,
    source.preview.height,
    quad,
    outW,
    outH,
    [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ]
  );

  const imgData = new ImageData(data, outW, outH);
  applyFilter(imgData, filter, intensity);
  return imgData;
}

/** Reduce una imagen grande para el detector (máx. 520 px de lado mayor). */
export function detectFromSource(source, guide) {
  const maxSide = 520;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source.canvas, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);

  const g = guide
    ? { x0: guide.x0 * scale, y0: guide.y0 * scale, x1: guide.x1 * scale, y1: guide.y1 * scale }
    : null;

  const quad = detectQuad(img, g);
  return quad ? quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) : null;
}

/** Rota un canvas 90° en sentido horario. */
export function rotateCanvas(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/** Rota esquinas 90° en sentido horario para acompañar a rotateCanvas. */
export function rotateCorners(corners, srcW, srcH) {
  // (x, y) -> (srcH - y, x) usando dimensiones con margen de 1 px.
  return corners.map((p) => ({ x: srcH - 1 - p.y, y: p.x }));
}

export { clamp, dist };
