#!/usr/bin/env node
// Build script: inlines everything into a single self-contained HTML.
// Vendors panzoom on first run (cached in src/vendor/) and fetches a
// satellite mosaic from Esri World Imagery on first run for the configured
// bounds (cached in build/.tile-cache/).

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSatelliteMap } from './mapfetch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const DATA = resolve(ROOT, 'data');
const DIST = resolve(ROOT, 'dist');
const VENDOR = resolve(SRC, 'vendor');
const TILE_CACHE = resolve(ROOT, 'build', '.tile-cache');

const VENDOR_LIBS = [
  {
    name: 'panzoom.min.js',
    url: 'https://cdn.jsdelivr.net/npm/panzoom@9.4.3/dist/panzoom.min.js',
  },
];

async function ensureVendored() {
  await mkdir(VENDOR, { recursive: true });
  for (const lib of VENDOR_LIBS) {
    const path = resolve(VENDOR, lib.name);
    if (existsSync(path)) continue;
    console.log(`  ↓ Descargando ${lib.name}…`);
    const res = await fetch(lib.url);
    if (!res.ok) throw new Error(`No se pudo descargar ${lib.url}: ${res.status}`);
    const text = await res.text();
    await writeFile(path, text, 'utf8');
    console.log(`    ✓ Guardado en ${path} (${(text.length / 1024).toFixed(1)} KB)`);
  }
}

async function readVendor(name) {
  return await readFile(resolve(VENDOR, name), 'utf8');
}

function placeholderMapDataUri(reason) {
  const w = 1600, h = 1000;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#1a1410"/>
    <text x="${w / 2}" y="${h / 2}" fill="#a89167" font-family="sans-serif" font-size="22" text-anchor="middle">
      Mapa no disponible
    </text>
    <text x="${w / 2}" y="${h / 2 + 30}" fill="#6a5a48" font-family="sans-serif" font-size="14" text-anchor="middle">
      ${reason}
    </text>
  </svg>`;
  return { dataUri: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), width: w, height: h };
}

function sanitizeForScript(jsonStr) {
  return jsonStr.replace(/</g, '\\u003c').replace(/-->/g, '--\\>');
}

async function getMapImage(data) {
  const bounds = data.mapa?.bounds;
  if (!bounds || !['north', 'south', 'east', 'west'].every(k => typeof bounds[k] === 'number')) {
    console.log('  ! No hay bounds válidos en proyecto.json, usando placeholder.');
    return placeholderMapDataUri('Configurar mapa.bounds en proyecto.json');
  }
  const targetWidth = data.mapa.imageryTargetWidth || 1500;
  console.log(`▸ Imagen satelital (Esri World Imagery)…`);
  console.log(`  bounds  N=${bounds.north} S=${bounds.south} W=${bounds.west} E=${bounds.east}`);
  console.log(`  target  ~${targetWidth}px de ancho`);
  try {
    const { buffer, mime, width, height, zoom } = await buildSatelliteMap({
      bounds, targetWidth, cacheDir: TILE_CACHE, log: console.log,
    });
    const fmt = mime.split('/')[1].toUpperCase();
    console.log(`  ✓ mosaico ${width}×${height}px @ z${zoom} (${(buffer.length / 1024).toFixed(0)} KB ${fmt})`);
    return {
      dataUri: `data:${mime};base64,` + buffer.toString('base64'),
      width, height,
    };
  } catch (e) {
    console.log(`  ✗ Falló la descarga del mosaico: ${e.message}`);
    console.log(`    Usando placeholder. Probá de nuevo cuando tengas internet.`);
    return placeholderMapDataUri(`Error: ${e.message}`);
  }
}

async function build() {
  console.log('▸ Build dashboard…');
  await ensureVendored();
  await mkdir(DIST, { recursive: true });

  const [template, styles, app, panzoomJs, dataJsonRaw] = await Promise.all([
    readFile(resolve(SRC, 'template.html'), 'utf8'),
    readFile(resolve(SRC, 'styles.css'), 'utf8'),
    readFile(resolve(SRC, 'app.js'), 'utf8'),
    readVendor('panzoom.min.js'),
    readFile(resolve(DATA, 'proyecto.json'), 'utf8'),
  ]);

  const data = JSON.parse(dataJsonRaw);
  const map = await getMapImage(data);

  const title = `${data.proyecto.nombre} · ${data.proyecto.yacimiento} · ${data.proyecto.fecha}`;

  // Use function replacements so $$ / $& in inlined JS/CSS/JSON aren't
  // interpreted as special replacement patterns by String.replaceAll.
  const subs = {
    '{{TITLE}}': title,
    '{{STYLES}}': styles,
    '{{DATA_JSON}}': sanitizeForScript(JSON.stringify(data)),
    '{{MAP_IMAGE_DATA_URI}}': map.dataUri,
    '{{PANZOOM_JS}}': panzoomJs,
    '{{APP_JS}}': app,
  };
  let html = template;
  for (const [key, val] of Object.entries(subs)) {
    html = html.replaceAll(key, () => val);
  }

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const outName = `dashboard-${slug(data.proyecto.cliente || 'cliente')}-${slug(data.proyecto.yacimiento || 'sitio')}-${data.proyecto.fecha}-${data.proyecto.version}.html`;
  const outPath = resolve(DIST, outName);
  await writeFile(outPath, html, 'utf8');

  const { size } = await stat(outPath);
  console.log(`✓ ${outName}`);
  console.log(`  ${(size / 1024).toFixed(1)} KB → ${outPath}`);
}

build().catch(err => { console.error('✗ Build falló:', err); process.exit(1); });
