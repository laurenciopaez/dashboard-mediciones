#!/usr/bin/env node
// Genera un proyecto.json de prueba realista:
//  - 38 puntos distribuidos en los bounds del yacimiento
//  - 9 campañas (4/año × 2 años + 1 de 2026), lunes representativos
//  - ~24 puntos medidos por campaña, con ~60% rotación contra la previa
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
const NUM_POINTS = 38;
const CAMPAIGNS = [
  '2024-03-04', '2024-06-03', '2024-09-02', '2024-12-02',
  '2025-03-03', '2025-06-02', '2025-09-01', '2025-12-01',
  '2026-03-02',
];
const CAMPAIGN_SIZE_RANGE = [22, 28];   // cantidad de puntos medidos por campaña
const REPEAT_RATIO = 0.6;               // % que se repite contra la previa
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

// ───── Construir el pool de puntos ─────
const points = [];
for (let i = 0; i < NUM_POINTS; i++) {
  const id = `POZO-${String(i + 1).padStart(3, '0')}`;
  const pozo = `BS-${String(i + 1).padStart(3, '0')}`;
  // Coordenadas con jitter para que no formen una grilla
  const lat = +rRand(BOUNDS.south + 0.005, BOUNDS.north - 0.005).toFixed(4);
  const lon = +rRand(BOUNDS.west + 0.005, BOUNDS.east - 0.005).toFixed(4);
  const trait = rWeighted(TRAITS);
  // Baseline acorde al trait
  let baseVel;
  if (trait === 'estable') baseVel = rRand(0.08, 0.32);
  else if (trait === 'mejorando') baseVel = rRand(0.30, 0.55);  // arranca alto, baja
  else if (trait === 'empeorando') baseVel = rRand(0.10, 0.30); // arranca medio, sube
  else baseVel = rRand(0.15, 0.40);                              // errático
  points.push({ id, pozo, lat, lon, trait, baseVel, mediciones: [], firstCampaign: -1 });
}

// ───── Selección por campaña con rotación 60/40 ─────
let prevSet = new Set();
for (let ci = 0; ci < CAMPAIGNS.length; ci++) {
  const campaign = CAMPAIGNS[ci];
  const target = rInt(CAMPAIGN_SIZE_RANGE[0], CAMPAIGN_SIZE_RANGE[1]);
  const wantRepeats = Math.round(target * REPEAT_RATIO);

  // Toma % de la campaña previa
  const prevArr = [...prevSet];
  shuffle(prevArr);
  const repeats = prevArr.slice(0, Math.min(wantRepeats, prevArr.length));

  // Completa con puntos NO incluidos en la previa
  const others = points.filter(p => !prevSet.has(p.id)).map(p => p.id);
  shuffle(others);
  const needed = target - repeats.length;
  const newOnes = others.slice(0, needed);

  const selected = new Set([...repeats, ...newOnes]);

  // Si todavía falta (caso edge: pocas opciones), rellena
  if (selected.size < target) {
    const rest = points.filter(p => !selected.has(p.id)).map(p => p.id);
    shuffle(rest);
    for (const id of rest.slice(0, target - selected.size)) selected.add(id);
  }

  for (const point of points) {
    if (!selected.has(point.id)) continue;
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
  prevSet = selected;
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
    yacimiento: 'Bandurria Sur',
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
