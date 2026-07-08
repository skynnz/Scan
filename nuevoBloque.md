<script>
    // Variables de estado global
    let paginasDocumento = [];
    let puntosEsquinas = [];
    let puntoSeleccionado = null;
    let imagenOriginalMat = null;

    const video = document.getElementById('video');
    const btnCapture = document.getElementById('btnCapture');
    const btnSavePDF = document.getElementById('btnSavePDF');
    const btnClear = document.getElementById('btnClear');
    const carousel = document.getElementById('carousel');
    const pageCountSpan = document.getElementById('count');
    const statusDiv = document.getElementById('status');

    const canvasRaw = document.getElementById('canvasRaw');
    const canvasOutput = document.getElementById('canvasOutput');

    // 1. Inicializar cámara trasera
    async function initCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                },
                audio: false
            });
            video.srcObject = stream;
            statusDiv.innerText = 'Cámara lista. Cargando OpenCV...';
            checkReadyState();
        } catch (err) {
            statusDiv.innerText = 'Error: acceso denegado a la cámara o falta protocolo HTTPS.';
        }
    }

    function checkReadyState() {
        if (typeof cv !== 'undefined') {
            statusDiv.innerText = 'Escáner inteligente listo.';
            btnCapture.disabled = false;
        } else {
            setTimeout(checkReadyState, 500);
        }
    }

    // 2. Captura inicial y auto-detección de contornos
    btnCapture.addEventListener('click', () => {
        if (video.videoWidth === 0) return;

        canvasRaw.width = video.videoWidth;
        canvasRaw.height = video.videoHeight;
        canvasRaw.style.display = 'block';
        video.style.display = 'none';

        const ctx = canvasRaw.getContext('2d');
        ctx.drawImage(video, 0, 0, canvasRaw.width, canvasRaw.height);

        statusDiv.innerText = 'Analizando geometría del documento...';

        if (imagenOriginalMat) imagenOriginalMat.delete();
        imagenOriginalMat = cv.imread(canvasRaw);

        let gris = new cv.Mat();
        let bordes = new cv.Mat();
        let contornos = new cv.MatVector();
        let jerarquia = new cv.Mat();

        cv.cvtColor(imagenOriginalMat, gris, cv.COLOR_RGBA2GRAY, 0);
        cv.GaussianBlur(gris, gris, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
        cv.Canny(gris, bordes, 75, 200, 3, false);
        cv.findContours(bordes, contornos, jerarquia, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        let aproximacion = new cv.Mat();
        let exitoDeteccion = false;

        for (let i = 0; i < contornos.size(); ++i) {
            let contornoActual = contornos.get(i);
            let perimetro = cv.arcLength(contornoActual, true);
            cv.approxPolyDP(contornoActual, aproximacion, 0.02 * perimetro, true);

            if (aproximacion.rows === 4) {
                puntosEsquinas = [];
                for (let j = 0; j < 4; j++) {
                    puntosEsquinas.push({
                        x: aproximacion.data32S[j * 2],
                        y: aproximacion.data32S[j * 2 + 1]
                    });
                }
                exitoDeteccion = true;
                break;
            }
        }

        if (!exitoDeteccion) {
            statusDiv.innerText = 'Ajusta las esquinas manualmente con tu dedo.';
            const w = canvasRaw.width;
            const h = canvasRaw.height;
            puntosEsquinas = [
                { x: w * 0.2, y: h * 0.2 },
                { x: w * 0.8, y: h * 0.2 },
                { x: w * 0.8, y: h * 0.8 },
                { x: w * 0.2, y: h * 0.8 }
            ];
        } else {
            statusDiv.innerText = '¡Documento detectado! Puedes refinar los puntos.';
        }

        gris.delete();
        bordes.delete();
        contornos.delete();
        jerarquia.delete();
        aproximacion.delete();

        ordenarPuntosEsquinas();
        dibujarEsquinasInteractivas();
        inicializarEventosTactiles();
    });

    // Ordenar puntos: [arriba-izquierda, arriba-derecha, abajo-derecha, abajo-izquierda]
    function ordenarPuntosEsquinas() {
        puntosEsquinas.sort((a, b) => a.y - b.y);
        const arriba = puntosEsquinas.slice(0, 2).sort((a, b) => a.x - b.x);
        const abajo = puntosEsquinas.slice(2, 4).sort((a, b) => b.x - a.x);
        puntosEsquinas = [arriba[0], arriba[1], abajo[0], abajo[1]];
    }

    // 3. Renderizado y gestión de la interfaz táctil (ajuste manual)
    function dibujarEsquinasInteractivas() {
        const ctx = canvasRaw.getContext('2d');
        ctx.drawImage(video, 0, 0, canvasRaw.width, canvasRaw.height);

        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(puntosEsquinas[0].x, puntosEsquinas[0].y);
        for (let i = 1; i < 4; i++) {
            ctx.lineTo(puntosEsquinas[i].x, puntosEsquinas[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        puntosEsquinas.forEach((punto) => {
            ctx.fillStyle = '#16a34a';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(punto.x, punto.y, 25, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
        });
    }

    function inicializarEventosTactiles() {
        const procesarInicio = (clientX, clientY) => {
            const rect = canvasRaw.getBoundingClientRect();
            const escalaX = canvasRaw.width / rect.width;
            const escalaY = canvasRaw.height / rect.height;
            const clickX = (clientX - rect.left) * escalaX;
            const clickY = (clientY - rect.top) * escalaY;

            puntoSeleccionado = puntosEsquinas.find((p) => {
                const distancia = Math.hypot(p.x - clickX, p.y - clickY);
                return distancia < 40;
            });
        };

        const procesarMovimiento = (clientX, clientY) => {
            if (!puntoSeleccionado) return;
            const rect = canvasRaw.getBoundingClientRect();
            const escalaX = canvasRaw.width / rect.width;
            const escalaY = canvasRaw.height / rect.height;

            puntoSeleccionado.x = (clientX - rect.left) * escalaX;
            puntoSeleccionado.y = (clientY - rect.top) * escalaY;
            dibujarEsquinasInteractivas();
        };

        canvasRaw.onmousedown = (e) => procesarInicio(e.clientX, e.clientY);
        canvasRaw.onmousemove = (e) => procesarMovimiento(e.clientX, e.clientY);
        canvasRaw.onmouseup = () => {
            puntoSeleccionado = null;
        };

        canvasRaw.ontouchstart = (e) => {
            if (e.touches.length > 0) {
                procesarInicio(e.touches[0].clientX, e.touches[0].clientY);
            }
        };
        canvasRaw.ontouchmove = (e) => {
            if (e.touches.length > 0) {
                procesarMovimiento(e.touches[0].clientX, e.touches[0].clientY);
            }
            e.preventDefault();
        };
        canvasRaw.ontouchend = () => {
            puntoSeleccionado = null;
        };
    }

    // 4. Corrección de perspectiva, filtro y guardado en memoria
    function confirmarRecorteYProcesar() {
        if (!imagenOriginalMat || puntosEsquinas.length !== 4) return;

        statusDiv.innerText = 'Transformando perspectiva y recortando...';
        ordenarPuntosEsquinas();

        const anchoA = Math.hypot(puntosEsquinas[2].x - puntosEsquinas[3].x, puntosEsquinas[2].y - puntosEsquinas[3].y);
        const anchoB = Math.hypot(puntosEsquinas[1].x - puntosEsquinas[0].x, puntosEsquinas[1].y - puntosEsquinas[0].y);
        const anchoMax = Math.max(anchoA, anchoB);

        const altoA = Math.hypot(puntosEsquinas[1].x - puntosEsquinas[2].x, puntosEsquinas[1].y - puntosEsquinas[2].y);
        const altoB = Math.hypot(puntosEsquinas[0].x - puntosEsquinas[3].x, puntosEsquinas[0].y - puntosEsquinas[3].y);
        const altoMax = Math.max(altoA, altoB);

        canvasOutput.width = anchoMax;
        canvasOutput.height = altoMax;

        const mapeoOrigen = cv.matFromArray(4, 1, cv.CV_32FC2, [
            puntosEsquinas[0].x, puntosEsquinas[0].y,
            puntosEsquinas[1].x, puntosEsquinas[1].y,
            puntosEsquinas[2].x, puntosEsquinas[2].y,
            puntosEsquinas[3].x, puntosEsquinas[3].y
        ]);

        const mapeoDestino = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0,
            anchoMax, 0,
            anchoMax, altoMax,
            0, altoMax
        ]);

        const dst = new cv.Mat();
        const M = cv.getPerspectiveTransform(mapeoOrigen, mapeoDestino);

        cv.warpPerspective(imagenOriginalMat, dst, M, new cv.Size(anchoMax, altoMax), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
        cv.cvtColor(dst, dst, cv.COLOR_RGBA2GRAY, 0);
        cv.adaptiveThreshold(dst, dst, 255, cv.ADAPTATIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 10);
        cv.imshow(canvasOutput, dst);

        mapeoOrigen.delete();
        mapeoDestino.delete();
        M.delete();
        dst.delete();

        const imgDataUrl = canvasOutput.toDataURL('image/jpeg', 0.85);
        paginasDocumento.push(imgDataUrl);

        canvasRaw.style.display = 'none';
        video.style.display = 'block';
        updateUI();
        statusDiv.innerText = 'Página recortada y procesada.';
    }

    function updateUI() {
        if (pageCountSpan) {
            pageCountSpan.textContent = paginasDocumento.length;
        }
    }

    function eliminarPagina(index) {
        if (index >= 0 && index < paginasDocumento.length) {
            paginasDocumento.splice(index, 1);
            updateUI();
        }
    }

    function destruirSesion() {
        paginasDocumento = [];
        puntosEsquinas = [];
        puntoSeleccionado = null;
        imagenOriginalMat = null;
        updateUI();
    }

    if (btnSavePDF) {
        btnSavePDF.addEventListener('click', () => {
            statusDiv.innerText = 'Exportación PDF pendiente de integración.';
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', () => {
            destruirSesion();
            statusDiv.innerText = 'Sesión limpiada.';
        });
    }

    canvasRaw.addEventListener('dblclick', confirmarRecorteYProcesar);
</script>