#!/usr/bin/env node
// Genera un proyecto.json de prueba realista:
//  - 38 puntos medidos por campaña (fijo), universo de puntos que crece:
//    C1 = 38 nuevos; C2..C9 = 23 repetidos de la previa (60%) + 15 nuevos (40%).
//    Tras 9 campañas → 38 + 8·15 = 158 puntos en total.
//  - 9 campañas (4/año × 2 años + 1 de 2026), lunes representativos
//  - Mezcla de comportamientos: estable / mejorando / empeorando / errático
//
// Salida: data/proyecto.json (sobreescribe).
// Uso: node data/_mock.mjs

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ───── Parámetros del mock ─────
const BOUNDS = { north: -38.55, south: -38.88, west: -68.85, east: -68.45 };
const CAMPAIGNS = [
  '2024-03-04', '2024-06-03', '2024-09-02', '2024-12-02',
  '2025-03-03', '2025-06-02', '2025-09-01', '2025-12-01',
  '2026-03-02',
];
const CAMPAIGN_SIZE = 38;               // puntos medidos por campaña (fijo)
const REPEAT_RATIO = 0.6;               // % que se repite contra la previa
const REPEAT_PER_CAMPAIGN = Math.round(CAMPAIGN_SIZE * REPEAT_RATIO);  // 23
const NEW_PER_CAMPAIGN = CAMPAIGN_SIZE - REPEAT_PER_CAMPAIGN;          // 15
const PEOPLE = ['M. González', 'F. Liporace', 'D. Sosa', 'L. Pérez'];
const NOTE_RATE = 0.32;                 // % de puntos con notas
const TRAITS = [
  // weights: estable, mejorando, empeorando, errático
  ['estable', 0.45],
  ['mejorando', 0.15],
  ['empeorando', 0.25],
  ['erratico', 0.15],
];
const NOTAS_POOL = [
  'Pozo de referencia. Monitoreo regular según plan.',
  'Comportamiento estable. Validado contra cupones de pérdida de peso.',
  'Cambio de operación en último trimestre. Bajo observación.',
  'Inhibidor reformulado. Respuesta favorable confirmada.',
  'Tendencia ascendente detectada en último ciclo.',
  'Punto crítico. Requiere intervención antes del próximo ciclo.',
  'Punto incorporado al plan en última revisión.',
  'Variación atípica. Validar metodología en próxima campaña.',
  'Cupones de referencia coinciden con LPR. Sin alertas.',
  'Recomendado aumentar frecuencia por proximidad a umbral crítico.',
];

// ───── PRNG determinístico (mismo seed = mismos datos) ─────
let seed = 20260516;
function rng() {
  // Mulberry32
  let t = (seed += 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rRand = (min, max) => rng() * (max - min) + min;
const rInt = (min, max) => Math.floor(rRand(min, max + 1));
const rPick = (arr) => arr[Math.floor(rng() * arr.length)];
function rWeighted(opts) {
  const total = opts.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [v, w] of opts) { r -= w; if (r <= 0) return v; }
  return opts[opts.length - 1][0];
}

// ───── Construcción incremental: el universo de puntos crece campaña a campaña ─────
//
// C1: se crean 38 puntos nuevos y se miden todos.
// C2..Cn: se eligen REPEAT_PER_CAMPAIGN (23) puntos al azar de la campaña previa
//          y se crean NEW_PER_CAMPAIGN (15) puntos nuevos. Total por campaña = 38.
//
// El universo nunca se contrae — un punto introducido en C5 sigue existiendo
// aunque no vuelva a medirse en C6+. Esto refleja el caso real: a veces se
// suman puntos al plan y otros se discontinúan, pero todos forman parte del
// histórico del proyecto.
const points = [];
let nextIdx = 0;

function createPoint() {
  const idx = nextIdx++;
  const id = `POZO-${String(idx + 1).padStart(3, '0')}`;
  const pozo = `BS-${String(idx + 1).padStart(3, '0')}`;
  // Coordenadas con jitter para que no formen una grilla
  const lat = +rRand(BOUNDS.south + 0.005, BOUNDS.north - 0.005).toFixed(4);
  const lon = +rRand(BOUNDS.west + 0.005, BOUNDS.east - 0.005).toFixed(4);
  const trait = rWeighted(TRAITS);
  let baseVel;
  if (trait === 'estable') baseVel = rRand(0.08, 0.32);
  else if (trait === 'mejorando') baseVel = rRand(0.30, 0.55);
  else if (trait === 'empeorando') baseVel = rRand(0.10, 0.30);
  else baseVel = rRand(0.15, 0.40);
  const p = { id, pozo, lat, lon, trait, baseVel, mediciones: [], firstCampaign: -1 };
  points.push(p);
  return p;
}

function measure(point, ci, campaign) {
  if (point.firstCampaign < 0) point.firstCampaign = ci;
  const step = ci - point.firstCampaign;
  let vel;
  if (point.trait === 'estable') {
    vel = point.baseVel + rRand(-0.025, 0.025);
  } else if (point.trait === 'mejorando') {
    vel = point.baseVel - step * rRand(0.025, 0.05) + rRand(-0.02, 0.02);
  } else if (point.trait === 'empeorando') {
    vel = point.baseVel + step * rRand(0.03, 0.08) + rRand(-0.02, 0.02);
  } else {
    vel = point.baseVel + rRand(-0.18, 0.22);
  }
  vel = Math.max(0.02, Math.min(0.95, vel));
  point.mediciones.push({ fecha: campaign, velCorrosion: +vel.toFixed(3) });
}

let prevSelected = [];  // puntos medidos en la campaña previa
for (let ci = 0; ci < CAMPAIGNS.length; ci++) {
  const campaign = CAMPAIGNS[ci];
  const selected = [];

  if (ci === 0) {
    // Primera campaña: 38 puntos completamente nuevos.
    for (let i = 0; i < CAMPAIGN_SIZE; i++) selected.push(createPoint());
  } else {
    // 23 repetidos al azar de la campaña previa.
    const prevShuffled = [...prevSelected];
    shuffle(prevShuffled);
    const repeats = prevShuffled.slice(0, Math.min(REPEAT_PER_CAMPAIGN, prevShuffled.length));
    selected.push(...repeats);
    // 15 puntos nuevos al universo (cualquier déficit se compensa con extras nuevos).
    const newCount = CAMPAIGN_SIZE - selected.length;
    for (let i = 0; i < newCount; i++) selected.push(createPoint());
  }

  for (const p of selected) measure(p, ci, campaign);
  prevSelected = selected;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ───── KPI histórico (snapshot a fin de 2025) ─────
const CUT_2025 = '2025-12-31';
const measuredBy2025 = points.filter(p => p.mediciones.some(m => m.fecha <= CUT_2025));
const histMeasurements = points.reduce((a, p) => a + p.mediciones.filter(m => m.fecha <= CUT_2025).length, 0);
const histLastVels = measuredBy2025.map(p => {
  const ms = p.mediciones.filter(m => m.fecha <= CUT_2025);
  return ms[ms.length - 1].velCorrosion;
});
const histVelPromedio = histLastVels.length
  ? +(histLastVels.reduce((a, b) => a + b, 0) / histLastVels.length).toFixed(3)
  : 0;

// ───── JSON final ─────
const project = {
  proyecto: {
    nombre: 'Monitoreo Electroquímico',
    yacimiento: 'Loma la Lata y Sierra Barrosa',
    cliente: 'YPF',
    fecha: '2026-05-16',
    version: 'v1',
  },
  mapa: {
    bounds: BOUNDS,
    imageryTargetWidth: 1500,
  },
  umbralesCriticidad: {
    bajo: 0.10, moderado: 0.30, critico: 0.50,
    unidad: 'mm/año',
  },
  kpiHistorico: {
    fecha: CUT_2025,
    etiqueta: 'vs. Q4-25',
    pozos: measuredBy2025.length,
    velPromedio: histVelPromedio,
    mediciones: histMeasurements,
  },
  puntos: points.map(p => {
    const hasNote = rng() < NOTE_RATE && p.mediciones.length > 0;
    const notas = hasNote
      ? {
          texto: rPick(NOTAS_POOL),
          autor: rPick(PEOPLE),
          fecha: p.mediciones[p.mediciones.length - 1].fecha,
        }
      : { texto: '', autor: '', fecha: '' };
    return {
      id: p.id,
      pozo: p.pozo,
      lat: p.lat,
      lon: p.lon,
      yacimiento: 'Bandurria Sur',
      notas,
      mediciones: p.mediciones,
    };
  }),
};

const out = resolve(HERE, 'proyecto.json');
writeFileSync(out, JSON.stringify(project, null, 2), 'utf8');

const totalM = project.puntos.reduce((a, p) => a + p.mediciones.length, 0);
const measuredPts = project.puntos.filter(p => p.mediciones.length).length;
console.log(`✓ ${out}`);
console.log(`  ${project.puntos.length} puntos · ${measuredPts} con datos · ${CAMPAIGNS.length} campañas · ${totalM} mediciones totales`);
