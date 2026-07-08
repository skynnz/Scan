// Scoped State Controller
(function() {
    'use strict';

    // Estado global de la sesión (Memoria Volátil)
    let pages = [];
    let stream = null;
    let lastCropRegion = null;
    // 'environment' = cámara trasera (por defecto), 'user' = cámara frontal
    let currentFacingMode = 'environment';
    let hasMultipleCameras = false;
    
    // Elementos del DOM
    const loadingScreen = document.getElementById('loading-screen');
    const loadingStatus = document.getElementById('loading-status');
    const progressBar = document.getElementById('progress-bar');
    const appContainer = document.getElementById('app-container');
    
    const videoFeed = document.getElementById('video-feed');
    const captureBtn = document.getElementById('capture-btn');
    const toggleFlashBtn = document.getElementById('toggle-flash-btn');
    
    const cameraSection = document.getElementById('camera-section');
    const previewSection = document.getElementById('preview-section');
    
    const canvasRaw = document.getElementById('canvas-raw');
    const canvasProcessed = document.getElementById('canvas-processed');
    
    const inputBlockSize = document.getElementById('input-block-size');
    const inputCValue = document.getElementById('input-c-value');
    const blockSizeVal = document.getElementById('block-size-val');
    const cValueVal = document.getElementById('c-val');
    
    const acceptPageBtn = document.getElementById('accept-page-btn');
    const discardPageBtn = document.getElementById('discard-page-btn');
    
    const galleryModal = document.getElementById('gallery-modal');
    const galleryTriggerBtn = document.getElementById('gallery-trigger-btn');
    const galleryTriggerImg = document.getElementById('gallery-trigger-img');
    const galleryTriggerIcon = document.getElementById('gallery-trigger-icon');
    const galleryTriggerBadge = document.getElementById('gallery-trigger-badge');
    const closeGalleryBtn = document.getElementById('close-gallery-btn');
    
    const thumbnailsContainer = document.getElementById('thumbnails-container');
    const pagesCountText = document.getElementById('pages-count-text');
    const cancelSessionBtn = document.getElementById('cancel-session-btn');
    const downloadPdfBtn = document.getElementById('download-pdf-btn');

    // 1. Monitorear e Inicializar OpenCV.js
    let progressInterval = setInterval(() => {
        let currentWidth = parseFloat(progressBar.style.width) || 0;
        if (currentWidth < 90) {
            progressBar.style.width = (currentWidth + 10) + '%';
        }
    }, 300);

    const checkOpenCv = setInterval(() => {
        if (typeof cv !== 'undefined' && cv.Mat && cv.adaptiveThreshold) {
            clearInterval(checkOpenCv);
            clearInterval(progressInterval);
            progressBar.style.width = '100%';
            
            loadingStatus.textContent = 'OpenCV listo. Iniciando cámara...';
            setTimeout(() => {
                initializeApplication();
            }, 500);
        }
    }, 100);

    // 2. Inicializar la Aplicación y Hardware
    async function initializeApplication() {
        try {
            await detectCameras();
            await startCamera();
            
            // Ocultar pantalla de carga y mostrar app
            loadingScreen.classList.remove('active');
            appContainer.classList.remove('app-hidden');
            
            // Registrar eventos de botones y controles
            setupEventListeners();
        } catch (error) {
            console.error('Error al inicializar la app:', error);
            loadingStatus.textContent = 'Error al acceder al hardware de video.';
            alert('No se pudo acceder a la cámara. Por favor, concede permisos e intenta de nuevo.');
        }
    }

    // Detectar si el dispositivo tiene múltiples cámaras para mostrar/ocultar el botón de voltear
    async function detectCameras() {
        try {
            // Necesitamos pedir permiso primero para que enumerateDevices devuelva las etiquetas
            // Hacemos una solicitud temporal solo para activar la enumeración
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
            tempStream.getTracks().forEach(t => t.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = devices.filter(d => d.kind === 'videoinput');
            hasMultipleCameras = videoInputs.length > 1;

            if (!hasMultipleCameras) {
                // Ocultar el botón de voltear si solo hay una cámara
                toggleFlashBtn.style.visibility = 'hidden';
                toggleFlashBtn.style.pointerEvents = 'none';
            }
        } catch (err) {
            console.warn('No se pudo enumerar cámaras:', err);
            // En caso de error de enumeración, ocultar el botón por seguridad
            toggleFlashBtn.style.visibility = 'hidden';
        }
    }

    // Iniciar el flujo de la cámara usando facingMode como fuente de verdad.
    // Este enfoque es el ÚNICO correcto en iOS Safari y Android Chrome,
    // ya que el orden del array de videoDevices no garantiza cuál es delantera/trasera.
    async function startCamera() {
        // Detener tracks anteriores si existen
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }

        // Primero intentamos con alta resolución + facingMode correcto
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: currentFacingMode },
                    width:  { ideal: 1920, max: 3840 },
                    height: { ideal: 1080, max: 2160 }
                }
            });
        } catch (err) {
            console.warn('Fallo resolución alta, reintentando con resolución básica:', err);
            // Fallback 1: solo facingMode, sin restricciones de resolución
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: currentFacingMode } }
                });
            } catch (fallbackErr) {
                console.warn('Fallo facingMode, reintentando con cualquier cámara:', fallbackErr);
                // Fallback 2: última opción, cualquier cámara disponible
                stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            }
        }

        videoFeed.srcObject = stream;
        updateFlipButtonIcon();
    }

    // Alternar entre cámara trasera (environment) y frontal (user)
    async function switchCamera() {
        currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';

        // Efecto visual de transición
        videoFeed.style.opacity = '0';
        videoFeed.style.transform = 'scale(0.95)';
        videoFeed.style.transition = 'opacity 0.2s ease, transform 0.2s ease';

        await startCamera();

        setTimeout(() => {
            videoFeed.style.opacity = '1';
            videoFeed.style.transform = 'scale(1)';
        }, 200);
    }

    // Actualizar el ícono del botón de volteo y etiqueta según la cámara activa
    function updateFlipButtonIcon() {
        const isRear = currentFacingMode === 'environment';
        const modeLabel = document.getElementById('camera-mode-label');

        toggleFlashBtn.title = isRear ? 'Cambiar a Cámara Frontal' : 'Cambiar a Cámara Trasera';

        // Resaltar el botón en verde cuando se usa cámara frontal (para indicar que no es el modo predeterminado)
        toggleFlashBtn.style.borderColor = isRear ? '' : 'var(--accent-color)';
        toggleFlashBtn.style.boxShadow  = isRear ? '' : '0 0 10px var(--accent-glow)';

        if (modeLabel) {
            modeLabel.textContent = isRear ? 'Trasera' : 'Frontal';
            modeLabel.style.color = isRear ? '' : 'var(--accent-color)';
        }
    }

    // Configurar manejadores de eventos
    function setupEventListeners() {
        // Captura
        captureBtn.addEventListener('click', captureFrame);
        toggleFlashBtn.addEventListener('click', switchCamera);
        
        // Ajustes de Filtro en tiempo real
        inputBlockSize.addEventListener('input', () => {
            let val = parseInt(inputBlockSize.value);
            if (val % 2 === 0) val += 1; // Debe ser impar
            blockSizeVal.textContent = val;
            applyAdaptiveThreshold();
        });

        inputCValue.addEventListener('input', () => {
            cValueVal.textContent = inputCValue.value;
            applyAdaptiveThreshold();
        });

        // Decisiones de Previsualización
        acceptPageBtn.addEventListener('click', acceptCapturedPage);
        discardPageBtn.addEventListener('click', discardCapturedPage);
        
        // Abrir/Cerrar Galería
        galleryTriggerBtn.addEventListener('click', () => {
            if (pages.length > 0) {
                galleryModal.classList.add('active');
            }
        });

        closeGalleryBtn.addEventListener('click', () => {
            galleryModal.classList.remove('active');
        });

        // Panel de Control y PDF
        cancelSessionBtn.addEventListener('click', () => {
            if (confirm('¿Estás seguro de que deseas cancelar la sesión? Se eliminarán de forma segura todos los datos en memoria.')) {
                destroyDataSecurely();
                switchToScannerView();
            }
        });

        downloadPdfBtn.addEventListener('click', generateAndDownloadPDF);
    }


    // Calcular la región del video real que corresponde al scanner guide visual.
    // Necesario porque el <video> usa object-fit:cover, lo cual escala y centra el
    // stream de video para llenar el contenedor, creando un offset invisible.
    function computeCropRegion() {
        const vW = videoFeed.videoWidth;
        const vH = videoFeed.videoHeight;

        // Dimensiones CSS del elemento <video> tal como lo renderiza el navegador
        const elRect = videoFeed.getBoundingClientRect();
        const eW = elRect.width;
        const eH = elRect.height;

        if (!vW || !vH || !eW || !eH) return null;

        // --- Matemática de object-fit: cover ---
        // La imagen se escala de modo que ambas dimensiones "cubran" el contenedor.
        // Escala = max(contenedor/video) para cada eje.
        const scale = Math.max(eW / vW, eH / vH);

        // Cuánto se desborda el video escalado más allá del elemento (centrado)
        const offsetX = (vW * scale - eW) / 2;  // px de video fuera a la izquierda
        const offsetY = (vH * scale - eH) / 2;  // px de video fuera arriba

        // Posición y tamaño CSS del scanner-guide (rectángulo visible A4)
        const guideEl = document.querySelector('.scanner-guide');
        if (!guideEl) return null;
        const guideRect = guideEl.getBoundingClientRect();

        // Posición del guide relativa al elemento <video> (en px CSS)
        const guideLeftCss  = guideRect.left   - elRect.left;
        const guideTopCss   = guideRect.top    - elRect.top;
        const guideWidthCss = guideRect.width;
        const guideHeightCss= guideRect.height;

        // Convertir coordenadas CSS → píxeles reales del stream de video
        const cropX = Math.round((guideLeftCss  + offsetX) / scale);
        const cropY = Math.round((guideTopCss   + offsetY) / scale);
        const cropW = Math.round(guideWidthCss  / scale);
        const cropH = Math.round(guideHeightCss / scale);

        // Clamping: garantizar que no nos salgamos del frame real
        return {
            x: Math.max(0, cropX),
            y: Math.max(0, cropY),
            w: Math.min(cropW, vW - Math.max(0, cropX)),
            h: Math.min(cropH, vH - Math.max(0, cropY))
        };
    }

    // 3. Flujo de Captura y Procesamiento
    function drawCropToCanvas(targetCanvas) {
        const crop = computeCropRegion();
        const srcX = crop ? crop.x : 0;
        const srcY = crop ? crop.y : 0;
        const srcW = crop ? crop.w : videoFeed.videoWidth;
        const srcH = crop ? crop.h : videoFeed.videoHeight;

        targetCanvas.width = srcW;
        targetCanvas.height = srcH;

        const ctx = targetCanvas.getContext('2d');
        if (!ctx) return null;

        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        ctx.drawImage(videoFeed, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

        lastCropRegion = crop;
        return { crop, srcX, srcY, srcW, srcH };
    }

    function captureFrame() {
        if (!stream) return;

        drawCropToCanvas(canvasRaw);

        // Cambiar a vista de previsualización
        cameraSection.classList.remove('active');
        previewSection.classList.add('active');

        // Procesar imagen con el filtro OpenCV
        applyAdaptiveThreshold();
    }

    // Filtro Mágico: Umbralización Adaptativa Gaussiana usando OpenCV.js
    function applyAdaptiveThreshold() {
        if (!canvasRaw.width || !canvasRaw.height) return;

        let src, gray, dst, contourMask, contours, hierarchy;
        let displayMat = null;
        try {
            // Cargar imagen raw en una matriz de OpenCV
            src = cv.imread(canvasRaw);
            gray = new cv.Mat();
            dst = new cv.Mat();
            contourMask = new cv.Mat();
            contours = new cv.MatVector();
            hierarchy = new cv.Mat();

            // Convertir a escala de grises
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

            // Obtener parámetros
            let blockSize = parseInt(inputBlockSize.value);
            if (blockSize % 2 === 0) blockSize += 1; // Obligatorio que sea impar
            if (blockSize < 3) blockSize = 3;
            
            const cValue = parseInt(inputCValue.value);

            // Aplicar Umbral Adaptativo Gaussiano
            cv.adaptiveThreshold(
                gray,
                dst,
                255, // Valor máximo (Blanco puro)
                cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv.THRESH_BINARY,
                blockSize,
                cValue
            );

            // Invertir el mapa para que las figuras oscuras se vuelvan manchas blancas y puedan detectarse como contornos
            cv.bitwise_not(dst, contourMask);

            // 1. Encontrar contornos principales
            cv.findContours(contourMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            let bestPoints = null;
            let maxArea = 0;

            for (let i = 0; i < contours.size(); i++) {
                const contour = contours.get(i);
                const area = cv.contourArea(contour, false);

                if (area < 1000) {
                    contour.delete();
                    continue;
                }

                const peri = cv.arcLength(contour, true);
                const approx = new cv.Mat();
                cv.approxPolyDP(contour, approx, 0.02 * peri, true);

                if (approx.rows === 4) {
                    const rect = cv.boundingRect(approx);
                    const rectArea = rect.width * rect.height;

                    if (rectArea > maxArea) {
                        maxArea = rectArea;

                        const points = [];
                        for (let j = 0; j < approx.rows; j++) {
                            points.push({
                                x: approx.data32S[j * 2],
                                y: approx.data32S[j * 2 + 1]
                            });
                        }

                        bestPoints = points;
                    }
                }

                approx.delete();
                contour.delete();
            }

            // 2. Si se estabiliza en un polígono de 4 esquinas, corregir perspectiva
            if (bestPoints && bestPoints.length === 4) {
                const sortedByY = bestPoints.slice().sort((a, b) => a.y - b.y || a.x - b.x);
                const top = sortedByY.slice(0, 2).sort((a, b) => a.x - b.x);
                const bottom = sortedByY.slice(2, 4).sort((a, b) => b.x - a.x);
                const orderedPoints = [top[0], top[1], bottom[0], bottom[1]];

                const width = Math.max(src.cols, 600);
                const height = Math.max(src.rows, 800);

                const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, orderedPoints.flatMap(p => [p.x, p.y]));
                const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
                const perspectiveMatrix = cv.getPerspectiveTransform(srcTri, dstTri);

                displayMat = new cv.Mat();
                cv.warpPerspective(src, displayMat, perspectiveMatrix, new cv.Size(width, height));

                srcTri.delete();
                dstTri.delete();
                perspectiveMatrix.delete();
            } else {
                displayMat = src.clone();
            }

            canvasProcessed.width = displayMat.cols;
            canvasProcessed.height = displayMat.rows;

            // Renderizar la matriz procesada en el canvas de previsualización
            cv.imshow(canvasProcessed, displayMat);

        } catch (error) {
            console.error('Error al aplicar procesamiento OpenCV:', error);
        } finally {
            // Liberación estricta de memoria WASM
            if (src) src.delete();
            if (gray) gray.delete();
            if (dst) dst.delete();
            if (contourMask) contourMask.delete();
            if (contours) contours.delete();
            if (hierarchy) hierarchy.delete();
            if (displayMat) displayMat.delete();
        }
    }

    // Aceptar Página Escaneada
    function acceptCapturedPage() {
        // Extraer contenido del canvas procesado como un Blob
        canvasProcessed.toBlob((blob) => {
            if (blob) {
                const objectUrl = URL.createObjectURL(blob);
                
                // Agregar al arreglo en memoria volátil
                pages.push({
                    blob: blob,
                    objectUrl: objectUrl
                });

                updateGalleryUI();
                switchToScannerView();
            }
        }, 'image/jpeg', 0.85); // Calidad optimizada de impresión
    }

    // Descartar captura actual
    function discardCapturedPage() {
        const rawCtx = canvasRaw.getContext('2d');
        if (rawCtx) rawCtx.clearRect(0, 0, canvasRaw.width, canvasRaw.height);
        canvasRaw.width = 0;
        canvasRaw.height = 0;

        const processedCtx = canvasProcessed.getContext('2d');
        if (processedCtx) processedCtx.clearRect(0, 0, canvasProcessed.width, canvasProcessed.height);
        canvasProcessed.width = 0;
        canvasProcessed.height = 0;

        lastCropRegion = null;
        switchToScannerView();
    }

    // Cambiar vistas
    function switchToScannerView() {
        previewSection.classList.remove('active');
        cameraSection.classList.add('active');
    }

    // 4. Gestión de la Galería
    function updateGalleryUI() {
        thumbnailsContainer.innerHTML = '';
        
        pages.forEach((page, index) => {
            const card = document.createElement('div');
            card.className = 'thumbnail-card';
            
            const img = document.createElement('img');
            img.src = page.objectUrl;
            img.alt = `Página ${index + 1}`;
            
            const badge = document.createElement('div');
            badge.className = 'page-badge';
            badge.textContent = index + 1;
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-thumb-btn';
            deleteBtn.innerHTML = '&times;';
            deleteBtn.title = 'Eliminar Página';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Evitar otros triggers
                removePage(index);
            });
            
            card.appendChild(img);
            card.appendChild(badge);
            card.appendChild(deleteBtn);
            thumbnailsContainer.appendChild(card);
        });

        // Actualizar contador y botones
        const count = pages.length;
        pagesCountText.textContent = count;
        
        // Actualizar botón de disparo de la galería (cámara)
        if (count > 0) {
            galleryTriggerBtn.disabled = false;
            galleryTriggerBadge.style.display = 'flex';
            galleryTriggerBadge.textContent = count;
            
            // Mostrar última página como miniatura en el botón de disparo
            galleryTriggerImg.src = pages[count - 1].objectUrl;
            galleryTriggerImg.style.display = 'block';
            galleryTriggerIcon.style.display = 'none';
            
            downloadPdfBtn.disabled = false;
        } else {
            galleryTriggerBtn.disabled = true;
            galleryTriggerBadge.style.display = 'none';
            galleryTriggerImg.style.display = 'none';
            galleryTriggerIcon.style.display = 'block';
            galleryTriggerImg.src = '';
            
            downloadPdfBtn.disabled = true;
            if (galleryModal) {
                galleryModal.classList.remove('active');
            }
        }
    }

    // Eliminar una página del arreglo
    function removePage(index) {
        if (index >= 0 && index < pages.length) {
            // Revocar URL del elemento removido
            URL.revokeObjectURL(pages[index].objectUrl);
            
            // Mutación del arreglo original (.splice())
            pages.splice(index, 1);
            
            // Actualizar vista
            updateGalleryUI();
        }
    }

    // Helper para convertir Blob a Base64 de forma asíncrona
    function readBlobAsDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    // 5. Compilación del Documento PDF y Descarga
    async function generateAndDownloadPDF() {
        if (pages.length === 0) return;

        downloadPdfBtn.disabled = true;
        downloadPdfBtn.textContent = 'Compilando PDF...';

        try {
            const { jsPDF } = window.jspdf;
            // PDF en A4 (210mm x 297mm) en modo vertical (portrait)
            const doc = new jsPDF({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4'
            });

            for (let i = 0; i < pages.length; i++) {
                if (i > 0) {
                    doc.addPage();
                }
                
                // Convertir Blob a Base64 justo en el momento de la compilación
                const base64Data = await readBlobAsDataURL(pages[i].blob);
                
                // Añadir imagen al PDF (Ajustado al tamaño completo de la página A4)
                doc.addImage(base64Data, 'JPEG', 0, 0, 210, 297);
            }

            // Descargar el archivo PDF
            doc.save('PersonalScan_' + new Date().toISOString().slice(0,10) + '.pdf');
            
            // Feedback de éxito y purga
            alert('¡PDF exportado con éxito! Se eliminarán inmediatamente todos los datos locales para tu privacidad.');
            
            // Destrucción obligatoria de datos en RAM
            destroyDataSecurely();
            
            // Retornar a la vista de cámara
            switchToScannerView();

        } catch (error) {
            console.error('Error al generar PDF:', error);
            alert('Ocurrió un error al compilar el PDF. Inténtalo de nuevo.');
            downloadPdfBtn.disabled = false;
        } finally {
            downloadPdfBtn.textContent = 'Exportar PDF (Descarga Privada)';
        }
    }

    // 6. Protocolo de Destrucción de Datos Privacy-First (MÉTODO DE DESTRUCCIÓN DE DATOS CRÍTICO)
    function destroyDataSecurely() {
        console.log('Iniciando protocolo de destrucción de datos...');
        
        // A. Romper referencias y revocar URLs de objeto en el navegador
        if (pages && pages.length > 0) {
            pages.forEach(page => {
                if (page.objectUrl) {
                    URL.revokeObjectURL(page.objectUrl);
                }
                // Anular propiedades para facilitar recolección de basura
                page.blob = null;
                page.objectUrl = null;
            });
            // Reasignar arreglo a vacío y romper referencia
            pages.length = 0;
        }
        pages = [];

        // B. Limpieza de Canvas del DOM e invalidación de texturas de GPU
        const canvases = [canvasRaw, canvasProcessed];
        canvases.forEach(canvas => {
            if (canvas) {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    // Borrar el búfer gráfico bidimensional
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                }
                // Forzar al motor gráfico del navegador a destruir la memoria del framebuffer
                canvas.width = 0;
                canvas.height = 0;
            }
        });

        // C. Limpiar la galería y cerrar modal
        if (galleryModal) {
            galleryModal.classList.remove('active');
        }
        
        updateGalleryUI();
        
        console.log('Destrucción de datos completada. Memoria RAM purgada exitosamente.');
    }

})();
