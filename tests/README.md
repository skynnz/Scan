# Pruebas del motor de imagen

Estas pruebas corren en el navegador, sin instalar nada.

## Preparar

Desde la raíz del proyecto:

```bash
python tests/make-fixtures.py
python -m http.server 8000
```

## Ejecutar

Abrir `http://localhost:8000/tests/imaging-test.html`.

La página genera nueve escenas sintéticas (documento sobre un escritorio, con
sombras, rotación, perspectiva y fondos claros), corre el detector sobre cada
una, y además procesa una foto realista importada. Al terminar escribe un JSON
con:

* `detected`: si encontró el documento.
* `errPx` / `errPct`: error medio de las esquinas contra la posición real.
* `ms`: tiempo de detección.
* `perf`: tiempos de enderezado + filtro a 1708 × 2400 px.

### Resultado esperado

```
10 de 10 escenas detectadas · error medio ≈ 0,3 % de la diagonal
detección ≈ 20-50 ms · página completa ≈ 0,2-0,4 s (escritorio)
```

`tests/visual-test.html` muestra, lado a lado, la foto original, la detección y
el resultado con cada filtro.

## Notas

* Los tiempos se midieron en una computadora; en un teléfono son 2-4 veces
  mayores. La app muestra una barra de progreso durante el procesado.
* El detector no usa OpenCV ni ninguna librería externa: es JavaScript puro
  sobre `Uint8ClampedArray`.
