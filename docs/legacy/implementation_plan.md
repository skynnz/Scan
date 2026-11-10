# Plan de Implementación: Escáner Web Personal (Serverless / Privacy-First)

Este plan describe la arquitectura, flujo de trabajo, diseño visual y método de destrucción de memoria para la aplicación web de escaneo de documentos.

## User Review Required

> [!IMPORTANT]
> **CDN de OpenCV.js**: Se utilizará una versión específica de la biblioteca OpenCV.js a través de jsDelivr (`@techstark/opencv-js@4.9.0-release.3`) y la biblioteca jsPDF (`jspdf@2.5.1`). OpenCV.js inicializa un módulo WebAssembly que puede tomar entre 3 y 8 segundos en cargar en dispositivos móviles; se implementará una pantalla de carga premium con un spinner y barra de progreso simulada.

> [!WARNING]
> **Privacidad y Destrucción de Datos**: Para garantizar la destrucción absoluta de datos en memoria y cumplir con el principio de privacidad:
> 1. Se vaciará el array de páginas (`pages = []`).
> 2. Se invocará `.delete()` en todos los objetos `cv.Mat` temporales de OpenCV.js.
> 3. Se vaciarán los contextos de canvas con `clearRect` y se reseteará su tamaño (`width = 0, height = 0`) para obligar al navegador a liberar los búferes de memoria de la GPU.
> 4. Se revocarán todas las URLs de objeto (`URL.revokeObjectURL`) creadas durante la sesión.

---

## Proposed Changes

### Estructura de Archivos
Se creará una SPA en la raíz del espacio de trabajo:
* `index.html`: Estructura semántica, enlaces a CDNs y contenedores de UI.
* `styles.css`: Estilos visuales con diseño premium, responsivo y adaptado para móviles.
* `app.js`: Lógica de la aplicación, control de cámara, procesamiento OpenCV, generación de PDF y destrucción de memoria.

---

### [Componente de UI y Estructura]

#### [NEW] [index.html](file:///c:/Users/fcespedes/OneDrive%20-%20GNB%20Sudameris%20S.A/Documents/Coders/Scan/index.html)
* **Pantalla de Carga**: Indicador visual del estado de carga de OpenCV.js (WASM).
* **Vista del Escáner**:
  * Elemento `<video>` oculto o visible (visor de cámara en vivo).
  * Superposición de área de escaneo (guía visual para el documento).
  * Controles de captura (Botón de captura, alternar cámara).
  * Panel de ajustes para el umbral adaptativo (Block Size, C parameter).
* **Vista de Previsualización**:
  * Canvas donde se muestra el resultado procesado por OpenCV.js.
  * Botones de confirmación: "Guardar página", "Reintentar".
* **Galería y Control de Documento**:
  * Contador en tiempo real del número de páginas.
  * Carrusel inferior con miniaturas de las páginas capturadas, con opción de eliminar páginas de forma individual (`.splice()`).
  * Botón de descarga de PDF.
  * Botón de cancelación / borrado completo de la sesión.

---

### [Estilizado y Diseño Visual]

#### [NEW] [styles.css](file:///c:/Users/fcespedes/OneDrive%20-%20GNB%20Sudameris%20S.A/Documents/Coders/Scan/styles.css)
* **Estética Premium**:
  * Paleta de colores oscura y elegante (Slate Gray, Charcoal, Emerald/Mint Green como color de acento).
  * Glassmorphism en los paneles de control y botones flotantes.
  * Tipografía moderna (Google Fonts "Outfit").
  * Animaciones suaves y micro-interacciones (efectos de hover, transiciones de captura).
  * Adaptabilidad completa para navegadores móviles (Safari iOS, Chrome Android).

---

### [Motor de Visión y Lógica de Negocio]

#### [NEW] [app.js](file:///c:/Users/fcespedes/OneDrive%20-%20GNB%20Sudameris%20S.A/Documents/Coders/Scan/app.js)
* **Inicialización de Cámara**:
  * Uso de `navigator.mediaDevices.getUserMedia` con `{ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } }`.
* **Procesamiento de OpenCV.js**:
  * Método para capturar el frame actual del video a un canvas `canvasRaw`.
  * Conversión de la matriz a escala de grises (`cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY)`).
  * Aplicación del filtro `cv.adaptiveThreshold` para remover sombras y mejorar contraste (blanco y negro de alta calidad).
  * Renderización de la matriz resultante en `canvasProcessed`.
  * Liberación inmediata de las matrices temporales mediante `.delete()`.
* **Ciclo de Vida del PDF**:
  * Arreglo en memoria `pages` que guarda las imágenes procesadas en base64 o Blob URLs.
  * Compilación con jsPDF recorriendo `pages` y usando `doc.addPage()` y `doc.addImage()`.
  * Guardado con `doc.save()`.
* **Destrucción de Datos en Memoria**:
  * Limpieza del arreglo: `pages = []` y sobrescritura de referencias previas.
  * Limpieza de los canvas:
    * Llamada a `ctx.clearRect(0, 0, canvas.width, canvas.height)` para todos los canvas.
    * Reseteo de las dimensiones del canvas a `0` para liberar la memoria de textura de la GPU.
  * Revocación de URLs de objetos.
  * Llamada al recolector de basura de JS forzando el descarte de variables.

---

## Verification Plan

### Automated Tests
* La aplicación se validará localmente mediante inspección en herramientas de desarrollo de Chrome (Simulador móvil, Profiler de memoria).

### Manual Verification
1. **Carga e Inicialización**: Verificar que la pantalla de carga se oculta cuando OpenCV.js está listo.
2. **Acceso a Cámara**: Probar en dispositivo móvil (iOS Safari y Android Chrome) que solicita permiso y activa la cámara trasera en alta resolución.
3. **Procesamiento de Imagen**: Tomar una captura con sombras y validar que la umbralización adaptativa gaussiana limpia el fondo a blanco y negro con buen contraste.
4. **Mutación de Páginas**: Agregar múltiples páginas, previsualizar la galería, eliminar una página intermedia y comprobar el contador en tiempo real.
5. **Generación de PDF**: Descargar el archivo PDF y verificar su legibilidad.
6. **Destrucción de Memoria**: Inspeccionar en Chrome DevTools que el array se limpie y los tamaños de los canvas se reduzcan a 0, liberando la memoria.
