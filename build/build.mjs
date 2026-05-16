#!/usr/bin/env node
// Build script: inlines everything into a single self-contained HTML.
// Vendors Chart.js and panzoom on first run (cached in src/vendor/).

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const DATA = resolve(ROOT, 'data');
const DIST = resolve(ROOT, 'dist');
const VENDOR = resolve(SRC, 'vendor');

const VENDOR_LIBS = [
  {
    name: 'chart.umd.min.js',
    url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
  },
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

async function imageToDataUri(path) {
  if (!existsSync(path)) {
    console.log(`  ! No se encontró ${path}, usando placeholder SVG.`);
    return placeholderMapDataUri();
  }
  const buf = await readFile(path);
  const ext = path.toLowerCase().split('.').pop();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function placeholderMapDataUri() {
  const w = 1600, h = 1000;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#3a2e22"/>
        <stop offset="100%" stop-color="#1a1410"/>
      </linearGradient>
      <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
        <path d="M80 0 L0 0 0 80" fill="none" stroke="#4a3a2a" stroke-width="0.5"/>
      </pattern>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect width="${w}" height="${h}" fill="url(#grid)"/>
    <path d="M0 ${h * 0.35} Q ${w * 0.3} ${h * 0.45}, ${w * 0.5} ${h * 0.4} T ${w} ${h * 0.5}"
          fill="none" stroke="#5a4a38" stroke-width="2" opacity="0.6"/>
    <path d="M0 ${h * 0.7} Q ${w * 0.4} ${h * 0.6}, ${w * 0.6} ${h * 0.75} T ${w} ${h * 0.65}"
          fill="none" stroke="#5a4a38" stroke-width="2" opacity="0.6"/>
    <text x="${w / 2}" y="${h - 30}" fill="#6a5a48" font-family="sans-serif" font-size="20" text-anchor="middle" opacity="0.7">
      MAPA DE REFERENCIA — Reemplazar data/mapa.png con imagen real del yacimiento
    </text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function sanitizeForScript(jsonStr) {
  return jsonStr.replace(/</g, '\\u003c').replace(/-->/g, '--\\>');
}

async function build() {
  console.log('▸ Build dashboard…');
  await ensureVendored();
  await mkdir(DIST, { recursive: true });

  const [template, styles, app, chartJs, panzoomJs, dataJsonRaw] = await Promise.all([
    readFile(resolve(SRC, 'template.html'), 'utf8'),
    readFile(resolve(SRC, 'styles.css'), 'utf8'),
    readFile(resolve(SRC, 'app.js'), 'utf8'),
    readVendor('chart.umd.min.js'),
    readVendor('panzoom.min.js'),
    readFile(resolve(DATA, 'proyecto.json'), 'utf8'),
  ]);

  const data = JSON.parse(dataJsonRaw);
  const mapPath = resolve(DATA, data.mapa?.imagen || 'mapa.png');
  const mapDataUri = await imageToDataUri(mapPath);

  const title = `${data.proyecto.nombre} · ${data.proyecto.yacimiento} · ${data.proyecto.fecha}`;

  let html = template
    .replaceAll('{{TITLE}}', title)
    .replaceAll('{{STYLES}}', styles)
    .replaceAll('{{DATA_JSON}}', sanitizeForScript(JSON.stringify(data)))
    .replaceAll('{{MAP_IMAGE_DATA_URI}}', mapDataUri)
    .replaceAll('{{CHART_JS}}', chartJs)
    .replaceAll('{{PANZOOM_JS}}', panzoomJs)
    .replaceAll('{{APP_JS}}', app);

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const outName = `dashboard-${slug(data.proyecto.cliente || 'cliente')}-${slug(data.proyecto.yacimiento || 'sitio')}-${data.proyecto.fecha}-${data.proyecto.version}.html`;
  const outPath = resolve(DIST, outName);
  await writeFile(outPath, html, 'utf8');

  const { size } = await stat(outPath);
  console.log(`✓ ${outName}`);
  console.log(`  ${(size / 1024).toFixed(1)} KB → ${outPath}`);
}

build().catch(err => { console.error('✗ Build falló:', err); process.exit(1); });
