# Documentos originales (histórico)

Estos archivos son el brief y la documentación generada en la primera versión
del proyecto. Se conservan como referencia, pero **describen una implementación
que ya no es la actual**:

* La versión original dependía de OpenCV.js (10 MB desde un CDN) para detectar
  el documento. La versión actual detecta y endereza con JavaScript propio
  (`js/imaging.js`), sin dependencias externas.
* El guardado era solo en memoria. Ahora las páginas se conservan en IndexedDB
  del propio dispositivo.
* La documentación vigente está en el [README](../README.md) y en
  [arquitectura.md](../arquitectura.md).
