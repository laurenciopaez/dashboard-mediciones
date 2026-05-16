# CLAUDE.md

Guía para trabajar en este repo. Lee esto antes de tocar código nuevo.

## Qué es esto

Dashboard interactivo de mediciones electroquímicas (velocidad de corrosión)
que **SINTEC S.A.** entrega como anexo a informes técnicos para clientes
(YPF y similares). El producto final es **un único archivo `.html`
autocontenido**, distribuido por email, que se abre en cualquier browser
desktop o móvil **100% offline**. El cliente solo consulta — no edita,
no guarda, no sincroniza.

Cada nueva versión es un archivo nuevo generado desde el repo. No hay
backend, no hay updates remotos.

## Arquitectura

```
data/
  proyecto.json     ← fuente de verdad: bounds, puntos, mediciones, umbrales
  _mock.mjs         ← regenera proyecto.json determinísticamente para demo
src/
  template.html     ← marco HTML con placeholders {{...}}
  styles.css        ← tokens + layout (dark + IBM Plex-ish)
  app.js            ← lógica: state, render, panzoom, SVG factories
  vendor/           ← panzoom inlined (auto-descargado en primer build)
build/
  build.mjs         ← orquestador: lee data + src + tiles, escupe HTML
  mapfetch.mjs      ← descarga + stitch + crop de tiles Esri World Imagery
  .tile-cache/      ← cache de tiles (no requiere re-download)
dist/
  dashboard-<cliente>-<sitio>-<fecha>-<ver>.html   ← lo que se manda
```

**Stack**: vanilla JS, sin framework. Gráficos son SVG hand-rolled (Chart.js
fue removido — pesaba 200KB y no soportaba zonas de criticidad / banda de
confianza limpiamente). Única dependencia runtime: `panzoom` (~33KB).

**Peso típico final**: 1.5–2 MB (depende sobre todo del mapa satelital
embebido como base64).

## Comandos

```bash
npm install              # primera vez (instala pngjs + jpeg-js)
npm run build            # genera dist/<archivo>.html
node data/_mock.mjs      # regenera proyecto.json (mock determinístico)
```

El primer build descarga ~100 tiles satelitales de Esri (~10s con internet).
Builds subsiguientes son instantáneos gracias al cache en
`build/.tile-cache/`.

## Restricciones que NO se pueden romper

1. **Offline absoluto en runtime**. Nada de iframes externos, CDNs, fetches,
   tracking, web fonts remotas. Todo se inlinea en el HTML.
2. **Un solo archivo**. Si necesitás un asset nuevo (imagen, fuente,
   librería), va inline base64 o se embebe en el JS/CSS.
3. **Sin frameworks**. Mantener vanilla JS. La complejidad no lo justifica
   y agrega peso.
4. **Email-friendly**. Idealmente <2 MB. >5 MB es problema para gateways
   corporativos (Outlook on-prem suele cortar a 10 MB).
5. **El cliente no edita**. Notas, umbrales, datos: todo viene del JSON,
   read-only desde la UI.

## Gotchas que ya nos mordieron

### Build / pipeline

- **`String.prototype.replaceAll(str, str)` interpreta `$$` como `$`** en
  el reemplazo (regla de patrones). Romper esto rompe `app.js` cuando
  declara `$` y `$$` como helpers de querySelector/All. Usar siempre la
  forma de función: `replaceAll('{{X}}', () => valor)`. Ver
  [build/build.mjs](build/build.mjs).
- **Esri World Imagery devuelve JPEG**, no PNG, aunque la URL diga `.png`.
  El módulo de tiles detecta el formato por magic bytes y usa `jpeg-js`
  para decodificar. Ver [build/mapfetch.mjs](build/mapfetch.mjs).
- **Re-encodear los JPEG satelitales como PNG infla x8** (1MB → 8MB). El
  output final es JPEG quality 82, que mantiene 1.1 MB sin artefactos
  visibles para fotos aéreas.
- **Tiles satelitales son Web Mercator (EPSG:3857)**. La transformación
  lat/lon → pixel en `app.js` usa Mercator (`mercY(lat) = log(tan(π/4 +
  lat·π/360))`), NO interpolación lineal. Para un área de ~30km la
  diferencia es ~800m de error en la posición de los puntos.

### Runtime / SVG

- **Las CSS rules sobreescriben los atributos SVG presentation** (la
  especificidad de un attr es la más baja). Para cualquier valor dinámico
  (font-size, stroke-width, width, height), usar **inline style**:
  `el.style.width = Wpx`. Setear el atributo SVG no alcanza si hay CSS
  apuntando al mismo elemento.
- **`CSS width: auto` en SVGs no respeta confiablemente el ancho
  intrínseco**. Cada factory SVG (`barChart`, `stackedBarChart`,
  `trendChart`, `donut`) escribe `style="width:Wpx;height:Hpx"` inline.
  Sin esto, el scroll horizontal no funciona en mobile.
- **Charts renderizados antes de `showView`** miden el host con 0 px de
  altura (el view está `hidden`). Siempre: `showView(...)` →
  `requestAnimationFrame(() => drawIntoHost(...))`. Ver `openDetail` y
  `openDashboard` en [src/app.js](src/app.js).
- **Panzoom puede comerse el `click` event en touch**. Para puntos del
  mapa usamos `pointerdown` + `pointerup` con detección de drag (< 10px
  movimiento = tap, > 10px se ignora). El `click` por sí solo no es
  confiable.
- **En touch los puntos quedan microscópicos cuando el mapa está fit-to-
  stage** (zoom ~0.14x). Se aplica un mínimo on-screen de 13 px en
  pointer:coarse para garantizar tap target.

## Modelo de datos (`proyecto.json`)

```json
{
  "proyecto":           { nombre, yacimiento, cliente, fecha, version },
  "mapa": {
    "bounds":           { north, south, east, west },   // grados decimales
    "imageryTargetWidth": 1500                          // ancho aprox del PNG final
  },
  "umbralesCriticidad": { bajo, moderado, critico, unidad },
  "kpiHistorico":       { fecha, etiqueta, pozos, velPromedio, mediciones },
  "puntos": [
    {
      "id":      "POZO-XXX",
      "pozo":    "BS-XXX",          // etiqueta corta visible
      "lat":     -38.62, "lon": -68.75,
      "yacimiento": "Bandurria Sur",
      "notas":   { texto, autor, fecha },
      "mediciones": [{ fecha: "YYYY-MM-DD", velCorrosion: 0.123 }, ...]
    }
  ]
}
```

**"Pozo" no implica pozo petrolero literal** — un "punto" puede ser un
punto de planta, ducto, o cualquier instrumento de monitoreo. La UI usa
"puntos" en todos los labels visibles.

**Las campañas son una agrupación derivada**: mediciones en la misma
semana ISO se agrupan en una campaña. El generador de mock asume 4
campañas por año, lunes representativos.

## Customización por proyecto

Editar `data/proyecto.json`:

- **Cambiar zona del mapa**: ajustar `mapa.bounds`. La primera build con
  bounds nuevos descarga tiles nuevos (~10–60s).
- **Resolución del mapa**: `mapa.imageryTargetWidth` (default 1500).
  Bajar a 1000 → ~700 KB final. Subir a 2000 → ~3 MB.
- **Umbrales de criticidad**: `umbralesCriticidad.{bajo,moderado,critico}`.
  Los chips, donut, zonas de fondo del chart y colores de los puntos
  se ajustan automáticamente.
- **Cliente/proyecto**: `proyecto.{nombre,cliente,yacimiento,fecha,version}`.
  El nombre del archivo de salida se deriva de cliente + yacimiento +
  fecha + versión.

## Las 3 vistas

1. **Mapa** (default). Header + panel lateral fijo (search/filtros/lista) +
   mapa satelital con puntos clickeables coloreados por criticidad +
   popover con info mínima.
2. **Detalle** (overlay, abre desde el popover o la lista). Ficha completa
   del punto + chart de tendencia con zonas de criticidad, recta de
   regresión, proyección a 6 meses + tabla de mediciones con Δ y % +
   notas + export CSV.
3. **Dashboard completo** (overlay, abre desde el botón en el panel).
   4 KPIs arriba + 2x2 grid: criticidad por campaña (barras apiladas) ·
   criticidad actual (donut) · tendencia global (scatter + recta) ·
   mediciones por campaña (barras). Cada chart con caption explicativo
   sin referenciar valores concretos.

## Memoria

Hay memoria persistente en
`C:\Users\laure\.claude\projects\c--Users-laure-OneDrive-Escritorio-dashboard-mediciones\memory\`
con contexto del proyecto (overview, arquitectura, modelo de datos,
spec de pantallas). Léela antes de empezar una sesión nueva.
