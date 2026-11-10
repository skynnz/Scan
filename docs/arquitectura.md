# Arquitectura

La app es una página estática sin paso de compilación. Tres vistas y cuatro
módulos de JavaScript.

## Vistas

| Vista | Archivo | Descripción |
| --- | --- | --- |
| Escanear | `#view-scan` | Cámara en vivo, guía de encuadre y detección en tiempo real. |
| Documento | `#view-pages` | Grilla de páginas, acciones por página y exportación. |
| Editor | `#view-edit` | Ajuste de esquinas y vista previa con filtros. |
| Herramientas | `#view-tools` | Lista de utilidades de PDF. |
| Herramienta | `#view-tool` | Vista genérica que cada herramienta arma dinámicamente. |

El editor se abre a pantalla completa (sin barra inferior) y se cierra
guardando o descartando la página.

## Flujo de una página

```
video ──► canvas (fotograma completo)
           │
           ├─► detector  ──► 4 esquinas (o la guía como respaldo)
           │
           ├─► vista previa (860 px, rápida)  ──► editor
           │
           └─► render final (hasta 2600 px)   ──► JPEG  ──► IndexedDB
                                                              │
                                                              └─► PDF
```

## Motor de imagen (`js/imaging.js`)

### Enderezado

Se calcula la homografía que lleva el rectángulo destino a las 4 esquinas del
documento (sistema de 8 ecuaciones, eliminación gaussiana con pivoteo). Luego se
recorre cada píxel de salida, se mapea hacia la foto original y se muestrea con
interpolación bilineal. Lo que queda fuera de la foto se pinta de blanco.

* Versión completa (`warpQuadAsync`): cede el hilo cada 128 filas para que la
  barra de progreso se actualice.
* Versión de vista previa (`renderPreview`): trabaja sobre una copia reducida a
  860 px y devuelve el resultado en menos de 100 ms.

### Filtros

Todos trabajan con **imágenes integrales** (summed-area tables), lo que permite
calcular promedios locales en tiempo constante.

* **Color mágico**: divide cada píxel por el brillo medio de su entorno. Al
  normalizar por el fondo, las sombras desaparecen y el papel queda blanco sin
  perder el color de la tinta.
* **Gris**: la misma normalización, pero el resultado se pasa a luminancia.
* **Blanco y negro**: umbral adaptativo. Se compara cada píxel con la media de
  su bloque menos una constante `C`. El tamaño de bloque y `C` escalan con la
  resolución y con el control "Limpieza".

El deslizador **Limpieza** (0-100) ajusta esos parámetros en los tres filtros.

### Detección (`detectQuad`)

1. Se reduce la foto a 520 px de lado mayor.
2. Se suaviza cada canal (R, G, B) y se calcula el gradiente de Sobel. Se toma
   el mayor entre canales: así se detectan bordes entre colores de luminancia
   parecida (papel azul sobre mesa marrón).
3. Se usa la guía de encuadre como pista: para cada lado se recorre una banda
   desde afuera hacia adentro y se toma el **primer** borde que supera un umbral
   relativo al máximo de esa banda. Buscar desde afuera evita confundirse con
   encabezados, tablas o sellos dentro de la hoja.
4. Se ajusta una recta por mínimos cuadrados totales con descarte de valores
   atípicos, y se cruzan las cuatro rectas para obtener las esquinas.
5. Se valida: convexidad, área, relación de aspecto, y coherencia con la guía
   (si el resultado es mucho más chico o está lejos, se descarta).

Si alguna validación falla, el editor arranca con las esquinas de la guía y el
usuario las acomoda a mano.

## Cámara (`js/app.js`)

* Se piden 3840×2160 y se baja de escalón si el dispositivo no lo soporta
  (`3840×2160 → 1920×1080 → facingMode → cualquier cámara`).
* El `<video>` usa `object-fit: cover`. Para pasar del recuadro visible a
  píxeles reales de la foto se aplica la transformación inversa del recorte
  (`guideRectInFrame`).
* La detección en vivo corre cada 750 ms sobre un fotograma de 320 px y dibuja
  el contorno detectado sobre un canvas superpuesto.
* La cámara se libera al cambiar de vista, al ocultar la app y al cerrar.

## Guardado (`js/store.js`)

IndexedDB con un único almacén `paginas`:

```js
{ id, blob, width, height, pos, createdAt }
```

`pos` define el orden y se reescribe al reordenar. Si IndexedDB no está
disponible (navegación privada restrictiva) se usa memoria volátil y la app
sigue funcionando.

## PDF (`js/pdf.js`)

* Cada página se vuelve a codificar en JPEG con la calidad elegida.
* El tamaño de hoja se calcula por página: A4/Carta (con orientación según la
  imagen) o "como la imagen" (300 ppp).
* La imagen se escala respetando su proporción y se centra; nunca se estira.
* `compress: true` activa la compresión de los flujos del PDF.

## Herramientas (`js/tools.js`)

Las librerías se cargan con etiquetas `<script>` inyectadas en el momento, no
en el arranque. Así el escaneo no paga los ~2,3 MB de `pdf-lib` + `pdf.js`.

| Herramienta | Librería | Cómo funciona |
| --- | --- | --- |
| Unir PDFs | pdf-lib | Copia las páginas de cada archivo, en orden, a un documento nuevo. |
| Comprimir PDF | pdf.js + jsPDF | Renderiza cada página a 200/150/100 ppp y la vuelve a codificar en JPEG. Conserva el tamaño de hoja original. |
| Imágenes a PDF | jsPDF | Reutiliza `buildPdf` sobre las imágenes (una por página). |
| Editar PDF | pdf.js + pdf-lib | pdf.js dibuja las miniaturas; pdf-lib copia solo las páginas elegidas, en el orden y con la rotación indicada. |

La compresión rasteriza: el texto deja de ser seleccionable. Es el mismo
resultado que se obtiene al escanear, y es lo que permite bajar el peso de
verdad (en una prueba, 6,5 MB → 539 KB).

## PWA

`sw.js` precarga el shell. Las navegaciones y el código propio van a la red
primero (para recibir actualizaciones); los iconos y jsPDF se sirven desde la
caché. Al cambiar archivos hay que subir `VERSION` en `sw.js`.
