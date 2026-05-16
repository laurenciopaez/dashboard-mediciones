(function () {
  'use strict';

  const data = window.__PROYECTO__;
  const mapDataUri = window.__MAPA_DATA_URI__;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const PAL = {
    bg: '#0d1117', bgPanel: '#11161d', bgElev: '#161d26',
    border: '#1f2731', borderStrong: '#2a3441',
    text: '#e6edf3', textDim: '#7d8590', textDimmer: '#545d68',
    accent: '#58a6ff',
    bajo: '#3fb950', moderado: '#d29922', critico: '#f85149', sin: '#6e7681',
  };

  const state = {
    search: '',
    filterFecha: 'all',
    filterCrit: 'all',
    selectedId: null,
  };

  // ---------- Math helpers ----------
  const MS_DAY = 86400000;
  const parseFecha = (s) => new Date(s + 'T00:00:00Z').getTime();
  const fmtFecha = (s) => {
    if (!s) return '—';
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  };
  const fmtFechaCorta = (s) => {
    if (!s) return '—';
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
  };
  const fmtFechaCortaMs = (ms) => fmtFechaCorta(new Date(ms).toISOString().slice(0, 10));

  // ISO 8601 week key for a YYYY-MM-DD date string. Weeks start on Monday;
  // week 1 is the week containing the year's first Thursday. We use this to
  // group all measurements of the same "campaign" (which take place within
  // a single representative week, typically on a Monday or Tuesday).
  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yStart) / MS_DAY) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function groupByCampaign(allStats) {
    const map = new Map();
    for (const { stats } of allStats) {
      for (const m of stats.mediciones) {
        const key = isoWeekKey(m.fecha);
        if (!map.has(key)) map.set(key, { key, mediciones: [], earliestFecha: m.fecha });
        const c = map.get(key);
        c.mediciones.push(m);
        if (m.fecha < c.earliestFecha) c.earliestFecha = m.fecha;
      }
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function campaignLabel(c) {
    const d = new Date(c.earliestFecha + 'T00:00:00Z');
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }) + ` '${String(d.getUTCFullYear()).slice(2)}`;
  }

  function criticidad(vel) {
    if (vel == null) return 'sin';
    const u = data.umbralesCriticidad;
    if (vel >= u.critico) return 'critico';
    if (vel >= u.moderado) return 'moderado';
    return 'bajo';
  }
  const critColor = (c) => PAL[c] || PAL.sin;
  const unidad = () => (data.umbralesCriticidad?.unidad) || 'mm/año';

  function linearFit(ms) {
    if (ms.length < 2) return null;
    const t0 = parseFecha(ms[0].fecha);
    const xs = ms.map(m => (parseFecha(m.fecha) - t0) / MS_DAY);
    const ys = ms.map(m => m.velCorrosion);
    const n = xs.length;
    const sx = xs.reduce((a, b) => a + b, 0);
    const sy = ys.reduce((a, b) => a + b, 0);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    const m = (n * sxy - sx * sy) / denom;
    const b = (sy - m * sx) / n;
    const yMean = sy / n;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const yp = m * xs[i] + b;
      ssRes += (ys[i] - yp) ** 2;
      ssTot += (ys[i] - yMean) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    const rmse = Math.sqrt(ssRes / n);
    return { slopePerDay: m, slopePerYear: m * 365.25, intercept: b, r2, rmse, t0 };
  }

  function pointStats(p) {
    const ms = [...p.mediciones].sort((a, b) => parseFecha(a.fecha) - parseFecha(b.fecha));
    if (ms.length === 0) return { ultimaFecha: null, ultimaVel: null, n: 0, freqDias: null, crit: 'sin', mediciones: [], fit: null };
    const ult = ms[ms.length - 1];
    let freq = null;
    if (ms.length >= 2) {
      const span = parseFecha(ms[ms.length - 1].fecha) - parseFecha(ms[0].fecha);
      freq = Math.round(span / MS_DAY / (ms.length - 1));
    }
    return {
      ultimaFecha: ult.fecha,
      ultimaVel: ult.velCorrosion,
      n: ms.length,
      freqDias: freq,
      crit: criticidad(ult.velCorrosion),
      mediciones: ms,
      fit: linearFit(ms),
    };
  }

  // ---------- Lat/Lon → pixel (Web Mercator) ----------
  // The map image is rendered from Esri World Imagery tiles (EPSG:3857).
  // Longitude is linear in Mercator, latitude is not — log-tangent projection.
  let mapImgSize = { w: 0, h: 0 };
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  function latLonToPixel(lat, lon) {
    const b = data.mapa.bounds;
    const x = ((lon - b.west) / (b.east - b.west)) * mapImgSize.w;
    const ymN = mercY(b.north), ymS = mercY(b.south);
    const y = ((ymN - mercY(lat)) / (ymN - ymS)) * mapImgSize.h;
    return { x, y };
  }

  // ---------- DOM helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(n.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of children) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  // ---------- Filters ----------
  function filterPoints() {
    const q = state.search.trim().toLowerCase();
    const now = Date.now();
    let cutoff = null;
    if (state.filterFecha === '1y') cutoff = now - 365 * MS_DAY;
    else if (state.filterFecha === '6m') cutoff = now - 182 * MS_DAY;
    else if (state.filterFecha === '3m') cutoff = now - 91 * MS_DAY;

    const all = data.puntos.map(p => ({ p, stats: pointStats(p) }));
    return all.filter(({ p, stats }) => {
      if (q && !(p.pozo.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))) return false;
      if (cutoff != null) {
        if (!stats.ultimaFecha || parseFecha(stats.ultimaFecha) < cutoff) return false;
      }
      if (state.filterCrit !== 'all' && stats.crit !== state.filterCrit) return false;
      return true;
    });
  }

  // ---------- Sparkline (inline SVG) ----------
  function sparkline({ mediciones, color, width = 72, height = 18, areaOpacity = 0.15 }) {
    const svg = svgEl('svg', { width, height, style: 'display:block;overflow:visible' });
    if (!mediciones || mediciones.length === 0) return svg;
    const xs = mediciones.map(m => parseFecha(m.fecha));
    const ys = mediciones.map(m => m.velCorrosion);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 2;
    const sx = (x) => xs.length === 1 ? width / 2 : pad + ((x - x0) / Math.max(1, x1 - x0)) * (width - pad * 2);
    const sy = (y) => y1 === y0 ? height / 2 : (height - pad) - ((y - y0) / (y1 - y0)) * (height - pad * 2);
    const pts = mediciones.map(m => `${sx(parseFecha(m.fecha)).toFixed(1)},${sy(m.velCorrosion).toFixed(1)}`).join(' ');
    if (areaOpacity > 0 && mediciones.length > 1) {
      svg.appendChild(svgEl('polygon', {
        points: `${pad},${height} ${pts} ${width - pad},${height}`,
        fill: color, opacity: areaOpacity,
      }));
    }
    svg.appendChild(svgEl('polyline', {
      points: pts, fill: 'none', stroke: color, 'stroke-width': 1.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    const last = mediciones[mediciones.length - 1];
    svg.appendChild(svgEl('circle', {
      cx: sx(parseFecha(last.fecha)), cy: sy(last.velCorrosion), r: 2, fill: color,
    }));
    return svg;
  }

  // ---------- TrendChart (detail + dashboard mini) ----------
  function trendChart({ stats, width, height, showZones = true, showForecast = false }) {
    const padL = 50, padR = 16, padT = 16, padB = 32;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const ms = stats.mediciones;
    const fit = stats.fit;
    const u = data.umbralesCriticidad;

    const svg = svgEl('svg', {
      width, height, viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'xMidYMid meet',
      style: `display:block;width:${width}px;height:${height}px`,
    });
    if (!ms || ms.length === 0) return svg;

    const xs = ms.map(m => parseFecha(m.fecha));
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    if (xMin === xMax) { xMax = xMin + MS_DAY * 30; }
    if (showForecast && fit) xMax = xMax + (xMax - xMin) * 0.25;

    const maxObs = Math.max(...ms.map(m => m.velCorrosion), u.critico + 0.05);
    const yMax = Math.max(0.7, Math.ceil(maxObs * 10) / 10);
    const yMin = 0;
    const sx = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
    const sy = (y) => padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

    // Criticality zones
    if (showZones) {
      const zCrit = sy(u.critico);
      const zMod = sy(u.moderado);
      const zBaj = sy(u.bajo);
      const zoneRect = (y, h, color, op) => svgEl('rect', {
        x: padL, y, width: plotW, height: Math.max(0, h), fill: color, opacity: op,
      });
      svg.appendChild(zoneRect(zCrit, padT + plotH - zCrit, PAL.critico, 0.08));
      svg.appendChild(zoneRect(zMod, zCrit - zMod, PAL.moderado, 0.08));
      svg.appendChild(zoneRect(zBaj, zMod - zBaj, PAL.bajo, 0.06));
    }

    // Y grid + labels
    const yStep = 0.2;
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      const y = sy(v);
      svg.appendChild(svgEl('line', { x1: padL, x2: width - padR, y1: y, y2: y, stroke: 'rgba(255,255,255,0.04)', 'stroke-width': 1 }));
      const t = svgEl('text', { x: padL - 8, y: y + 3, fill: PAL.textDim, 'font-size': 10, 'text-anchor': 'end', 'font-family': 'var(--mono)' });
      t.textContent = v.toFixed(2);
      svg.appendChild(t);
    }

    // Threshold lines
    [[u.bajo, PAL.bajo], [u.moderado, PAL.moderado], [u.critico, PAL.critico]].forEach(([v, col]) => {
      svg.appendChild(svgEl('line', {
        x1: padL, x2: width - padR, y1: sy(v), y2: sy(v),
        stroke: col, 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.55,
      }));
    });

    // X axis
    svg.appendChild(svgEl('line', { x1: padL, x2: width - padR, y1: padT + plotH, y2: padT + plotH, stroke: PAL.border }));
    const xTickCount = Math.min(5, Math.max(2, ms.length));
    for (let i = 0; i < xTickCount; i++) {
      const t = xMin + ((xMax - xMin) / (xTickCount - 1)) * i;
      const tx = svgEl('text', {
        x: sx(t), y: padT + plotH + 16,
        fill: PAL.textDim, 'font-size': 10, 'text-anchor': 'middle', 'font-family': 'var(--mono)',
      });
      tx.textContent = fmtFechaCortaMs(t);
      svg.appendChild(tx);
    }

    // Regression line + forecast separator
    if (fit) {
      const yAt = (x) => fit.slopePerDay * ((x - fit.t0) / MS_DAY) + fit.intercept;
      const xLineMin = Math.min(...xs);
      const xLineMax = showForecast ? xMax : Math.max(...xs);
      svg.appendChild(svgEl('line', {
        x1: sx(xLineMin), y1: sy(yAt(xLineMin)),
        x2: sx(xLineMax), y2: sy(yAt(xLineMax)),
        stroke: PAL.accent, 'stroke-width': 1.5, 'stroke-dasharray': '5 3', opacity: 0.9,
      }));
      if (showForecast) {
        const xObsMax = Math.max(...xs);
        svg.appendChild(svgEl('line', {
          x1: sx(xObsMax), y1: padT, x2: sx(xObsMax), y2: padT + plotH,
          stroke: PAL.textDim, 'stroke-dasharray': '2 4', opacity: 0.5,
        }));
      }
    }

    // Points
    for (const m of ms) {
      const c = criticidad(m.velCorrosion);
      svg.appendChild(svgEl('circle', {
        cx: sx(parseFecha(m.fecha)), cy: sy(m.velCorrosion),
        r: 4, fill: critColor(c), stroke: PAL.bg, 'stroke-width': 1.5,
      }));
    }

    return svg;
  }

  // ---------- Bar chart ----------
  // The returned SVG width may exceed `width` if items × minBarSlot doesn't
  // fit. The host (chart-host) scrolls horizontally in that case, so every
  // bar and label stays readable rather than being skipped or overlapped.
  function barChart({ data: items, width, height, valueFormat = (v) => v.toFixed(2), minBarSlot = 52 }) {
    const padL = 44, padR = 12, padT = 12, padB = 32;
    const W = Math.max(width, items.length * minBarSlot + padL + padR);
    const plotW = W - padL - padR;
    const plotH = height - padT - padB;
    // Inline style wins over stylesheet — guarantees the SVG renders at its
    // intrinsic width so the chart-host can scroll it horizontally when wider
    // than the visible area. `min-width:Wpx` keeps it from being squashed
    // when the host applies its own layout constraints.
    const svg = svgEl('svg', { width: W, height, viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'xMidYMid meet', style: `display:block;width:${W}px;height:${height}px;min-width:${W}px` });
    if (!items.length) return svg;
    const vals = items.map(d => d.value);
    const maxV = Math.max(0.001, ...vals.map(Math.abs));
    const minV = Math.min(0, ...vals);
    const range = Math.max(0.001, maxV - minV);
    const sy = (v) => padT + plotH - ((v - minV) / range) * plotH;
    const slot = plotW / items.length;
    const barW = Math.max(2, slot * 0.7);
    const slotPad = (slot - barW) / 2;

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = minV + (range * i) / ticks;
      svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: sy(v), y2: sy(v), stroke: 'rgba(255,255,255,0.04)' }));
      const t = svgEl('text', { x: padL - 6, y: sy(v) + 3, 'font-size': 10, fill: PAL.textDim, 'text-anchor': 'end', 'font-family': 'var(--mono)' });
      t.textContent = valueFormat(v);
      svg.appendChild(t);
    }
    if (minV < 0) {
      svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: sy(0), y2: sy(0), stroke: PAL.border }));
    }
    items.forEach((d, i) => {
      const x = padL + slot * i + slotPad;
      const y = d.value >= 0 ? sy(d.value) : sy(0);
      const h = Math.abs(sy(d.value) - sy(0));
      svg.appendChild(svgEl('rect', { x, y, width: barW, height: h, fill: d.color || PAL.accent, rx: 1 }));
      const t = svgEl('text', { x: x + barW / 2, y: height - padB + 14, 'font-size': 10, fill: PAL.textDim, 'text-anchor': 'middle', 'font-family': 'var(--mono)' });
      t.textContent = d.label;
      svg.appendChild(t);
    });
    return svg;
  }

  // ---------- Stacked bar chart ----------
  // Each data item: { label, segments: [{ value, color }, ...] }.
  // Segments stack from the bottom up in the given order.
  function stackedBarChart({ data: items, width, height, valueFormat = (v) => Math.round(v).toString(), minBarSlot = 52 }) {
    const padL = 36, padR = 12, padT = 12, padB = 32;
    const W = Math.max(width, items.length * minBarSlot + padL + padR);
    const plotW = W - padL - padR;
    const plotH = height - padT - padB;
    const svg = svgEl('svg', { width: W, height, viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'xMidYMid meet', style: `display:block;width:${W}px;height:${height}px;min-width:${W}px` });
    if (!items.length) return svg;

    const totals = items.map(d => d.segments.reduce((a, s) => a + (s.value || 0), 0));
    const maxV = Math.max(1, ...totals);
    const sy = (v) => padT + plotH - (v / maxV) * plotH;
    const slot = plotW / items.length;
    const barW = Math.max(2, slot * 0.7);
    const slotPad = (slot - barW) / 2;

    // y ticks
    const ticks = Math.min(4, Math.max(2, Math.round(maxV)));
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV * i) / ticks;
      svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: sy(v), y2: sy(v), stroke: 'rgba(255,255,255,0.04)' }));
      const t = svgEl('text', { x: padL - 6, y: sy(v) + 3, 'font-size': 10, fill: PAL.textDim, 'text-anchor': 'end', 'font-family': 'var(--mono)' });
      t.textContent = valueFormat(v);
      svg.appendChild(t);
    }

    items.forEach((d, i) => {
      const x = padL + slot * i + slotPad;
      let y = padT + plotH;
      for (const s of d.segments) {
        const v = s.value || 0;
        if (v <= 0) continue;
        const h = (v / maxV) * plotH;
        y -= h;
        svg.appendChild(svgEl('rect', { x, y, width: barW, height: h, fill: s.color, rx: 1 }));
      }
      const t = svgEl('text', { x: x + barW / 2, y: height - padB + 14, 'font-size': 10, fill: PAL.textDim, 'text-anchor': 'middle', 'font-family': 'var(--mono)' });
      t.textContent = d.label;
      svg.appendChild(t);
    });

    return svg;
  }

  // ---------- Donut ----------
  function donut({ segments, size = 120, thickness = 20, centerValue, centerLabel }) {
    const r = size / 2 - thickness / 2;
    const c = 2 * Math.PI * r;
    const total = segments.reduce((a, s) => a + s.value, 0);
    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: 'display:block' });
    svg.appendChild(svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: PAL.border, 'stroke-width': thickness }));
    let offset = 0;
    for (const s of segments) {
      const frac = total === 0 ? 0 : s.value / total;
      const dash = c * frac;
      const gap = c - dash;
      svg.appendChild(svgEl('circle', {
        cx: size / 2, cy: size / 2, r, fill: 'none',
        stroke: s.color, 'stroke-width': thickness,
        'stroke-dasharray': `${dash} ${gap}`, 'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }));
      offset += dash;
    }
    if (centerLabel != null) {
      const val = svgEl('text', { x: size / 2, y: size / 2 - 2, 'text-anchor': 'middle', 'font-size': 22, fill: PAL.text, 'font-family': 'var(--mono)', 'font-weight': 500 });
      val.textContent = centerValue;
      const lbl = svgEl('text', { x: size / 2, y: size / 2 + 14, 'text-anchor': 'middle', 'font-size': 9, fill: PAL.textDim, 'letter-spacing': 1 });
      lbl.textContent = centerLabel;
      svg.appendChild(val); svg.appendChild(lbl);
    }
    return svg;
  }

  // ---------- Data binding ----------
  function applyBindings() {
    $$('[data-bind]').forEach(node => {
      const path = node.getAttribute('data-bind').split('.');
      let v = data; for (const k of path) v = v ? v[k] : undefined;
      node.textContent = v ?? '';
    });
    document.title = `${data.proyecto.nombre} · ${data.proyecto.yacimiento} · ${data.proyecto.fecha}`;
  }

  function renderLegend() {
    const u = data.umbralesCriticidad;
    const rows = [
      ['Crítica', `≥ ${u.critico.toFixed(2)}`, PAL.critico],
      ['Moderada', `${u.moderado.toFixed(2)} – ${u.critico.toFixed(2)}`, PAL.moderado],
      ['Baja', `< ${u.moderado.toFixed(2)}`, PAL.bajo],
    ];
    const host = $('#legend-rows');
    host.innerHTML = '';
    for (const [l, range, col] of rows) {
      host.appendChild(el('div', { class: 'legend-row' }, [
        el('span', { class: 'legend-dot', style: { background: col } }),
        el('span', { class: 'legend-label' }, [l]),
        el('span', { class: 'legend-range' }, [range]),
      ]));
    }
  }

  // ---------- Map render ----------
  let panzoomInstance = null;
  function setupMap() {
    const img = $('#map-bg');
    img.onload = () => {
      mapImgSize = { w: img.naturalWidth, h: img.naturalHeight };
      const svg = $('#points-layer');
      svg.setAttribute('width', mapImgSize.w);
      svg.setAttribute('height', mapImgSize.h);
      svg.setAttribute('viewBox', `0 0 ${mapImgSize.w} ${mapImgSize.h}`);
      renderMapPoints();
      initPanzoom();
      fitMapToStage();
      updateScaleBar();
    };
    img.src = mapDataUri;
  }

  function initPanzoom() {
    if (panzoomInstance || !window.panzoom) return;
    panzoomInstance = window.panzoom($('#map-zoomer'), {
      minZoom: 0.1, maxZoom: 12, smoothScroll: false,
    });
    panzoomInstance.on('transform', () => {
      hidePopover();
      updateScaleBar();
      applyPointScale();
    });
    $('#zoom-in').onclick = () => zoomCentered(1.3);
    $('#zoom-out').onclick = () => zoomCentered(0.7);
    $('#zoom-reset').onclick = fitMapToStage;
  }

  function zoomCentered(factor) {
    const stage = $('#map-stage');
    panzoomInstance.smoothZoom(stage.clientWidth / 2, stage.clientHeight / 2, factor);
  }

  function fitMapToStage() {
    if (!panzoomInstance) return;
    const stage = $('#map-stage');
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const scale = Math.min(sw / mapImgSize.w, sh / mapImgSize.h) * 0.92;
    const tx = (sw - mapImgSize.w * scale) / 2;
    const ty = (sh - mapImgSize.h * scale) / 2;
    panzoomInstance.zoomAbs(0, 0, scale);
    panzoomInstance.moveTo(tx, ty);
  }

  function updateScaleBar() {
    if (!panzoomInstance || !mapImgSize.w) return;
    const t = panzoomInstance.getTransform();
    const b = data.mapa.bounds;
    // Approximate meters per degree at midlat
    const midLat = (b.north + b.south) / 2;
    const mPerDegLon = 111320 * Math.cos(midLat * Math.PI / 180);
    const mPerImgPx = ((b.east - b.west) * mPerDegLon) / mapImgSize.w;
    const mPerScreenPx = mPerImgPx / t.scale;
    const totalMeters = 80 * mPerScreenPx;
    let label;
    if (totalMeters >= 1000) label = `${(totalMeters / 1000).toFixed(totalMeters >= 10000 ? 0 : 1)} km`;
    else label = `${Math.round(totalMeters)} m`;
    $('#scale-label').textContent = label;
  }

  // Inverse-scale points against panzoom zoom so they get a bit larger when
  // zooming out (visible from far) and smaller when zooming in (precision).
  // Square-root dampens the effect — full inverse (1/z) would lock them to a
  // constant on-screen pixel size, which feels rigid.
  //
  // On touch devices we enforce a minimum on-screen radius so points stay
  // tappable even when the map is fully zoomed out (otherwise a point can
  // render at 2-3 screen pixels, below any reasonable tap target).
  const IS_COARSE_POINTER = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches;
  const MIN_SCREEN_R_PX = IS_COARSE_POINTER ? 13 : 4;
  function pointScaleFactor() {
    const z = panzoomInstance ? panzoomInstance.getTransform().scale : 1;
    const dampened = 1 / Math.sqrt(Math.max(0.1, z));
    // baseR=7 (smallest unselected). On-screen radius = baseR * k * z, so
    // k >= MIN_SCREEN_R_PX / (baseR * z) guarantees tappability.
    const minK = MIN_SCREEN_R_PX / (7 * Math.max(0.05, z));
    return Math.max(dampened, minK);
  }
  function applyPointScale() {
    const k = pointScaleFactor();
    document.querySelectorAll('#points-layer [data-base-r]').forEach(el => {
      const base = +el.dataset.baseR;
      el.setAttribute('r', (base * k).toFixed(2));
      const sw = el.dataset.baseStroke;
      // Inline style beats stylesheet (which has higher specificity than
      // plain SVG presentation attributes), so use style.* for runtime overrides.
      if (sw) el.style.strokeWidth = (+sw * k).toFixed(2) + 'px';
    });
    const labelOff = 14 * k;
    document.querySelectorAll('#points-layer [data-base-x]').forEach(el => {
      const bx = +el.dataset.baseX, by = +el.dataset.baseY;
      el.setAttribute('x', bx + labelOff);
      el.setAttribute('y', by + 4 * k);
      el.style.fontSize = (11 * k).toFixed(1) + 'px';
      el.style.strokeWidth = (3 * k).toFixed(2) + 'px';
    });
  }

  function renderMapPoints() {
    const svg = $('#points-layer');
    svg.innerHTML = '';
    const visible = new Set(filterPoints().map(v => v.p.id));
    const k = pointScaleFactor();
    for (const p of data.puntos) {
      const stats = pointStats(p);
      const { x, y } = latLonToPixel(p.lat, p.lon);
      const isVisible = visible.has(p.id);
      const isSelected = state.selectedId === p.id;
      const opacity = isVisible ? 1 : 0.25;
      const col = critColor(stats.crit);

      const g = svgEl('g', { opacity });
      if (isSelected) {
        const ring = svgEl('circle', {
          cx: x, cy: y, r: 22 * k,
          class: 'point-selected-ring', stroke: col,
        });
        ring.dataset.baseR = '22';
        g.appendChild(ring);
      }
      const baseR = isSelected ? 9 : 7;
      const circle = svgEl('circle', {
        cx: x, cy: y, r: baseR * k,
        class: `point point-fill ${stats.crit}`,
      });
      circle.style.strokeWidth = (1.5 * k).toFixed(2) + 'px';
      circle.dataset.baseR = String(baseR);
      circle.dataset.baseStroke = '1.5';
      // Tap detection via pointer events: we capture the down position and
      // only treat it as a selection if pointerup lands close to it. This
      // works for both mouse and touch, and avoids the `click` event being
      // swallowed by panzoom on mobile.
      let downPt = null;
      circle.addEventListener('pointerdown', (e) => {
        // Stop propagation so panzoom doesn't start a drag from the point —
        // makes the selection feel snappy.
        e.stopPropagation();
        downPt = { x: e.clientX, y: e.clientY, id: e.pointerId };
      });
      circle.addEventListener('pointerup', (e) => {
        const d = downPt; downPt = null;
        if (!d || d.id !== e.pointerId) return;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
        e.stopPropagation();
        state.selectedId = p.id;
        renderMapPoints();
        renderPointsList();
        showPopover(p, stats, e);
      });
      circle.addEventListener('pointercancel', () => { downPt = null; });
      g.appendChild(circle);

      const label = svgEl('text', {
        x: x + 14 * k, y: y + 4 * k,
        class: 'point-label',
      });
      label.style.fontSize = (11 * k).toFixed(1) + 'px';
      label.style.strokeWidth = (3 * k).toFixed(2) + 'px';
      label.dataset.baseX = String(x);
      label.dataset.baseY = String(y);
      label.textContent = p.pozo;
      g.appendChild(label);

      svg.appendChild(g);
    }
  }

  // ---------- Popover ----------
  function showPopover(p, stats, event) {
    const pop = $('#point-popover');
    const u = unidad();
    const col = critColor(stats.crit);
    pop.innerHTML = '';

    const head = el('div', { class: 'pop-head' }, [
      el('div', { class: 'pop-pozo' }, [p.pozo]),
      el('div', { class: 'pop-id' }, [p.id]),
    ]);
    pop.appendChild(head);
    pop.appendChild(el('div', { class: 'pop-divider' }));

    const main = el('div', { class: 'pop-main' }, [
      el('div', {}, [
        el('div', { class: 'pop-label' }, ['Última vel.']),
        el('div', { class: 'pop-main-vel', style: { color: col } }, [
          stats.ultimaVel != null ? stats.ultimaVel.toFixed(2) : '—',
        ]),
      ]),
    ]);
    main.appendChild(sparkline({ mediciones: stats.mediciones, color: col, width: 80, height: 28, areaOpacity: 0.2 }));
    pop.appendChild(main);

    const meta = el('div', { class: 'pop-meta' });
    meta.innerHTML = `
      <div>Fecha: <span class="val">${fmtFecha(stats.ultimaFecha)}</span></div>
      <div>Mediciones: <span class="val">${stats.n}</span></div>
      <div class="full">Tendencia: <span class="val" style="color:${stats.fit && stats.fit.slopePerYear > 0 ? PAL.critico : PAL.bajo}">${
        stats.fit ? `${stats.fit.slopePerYear >= 0 ? '+' : ''}${stats.fit.slopePerYear.toFixed(3)} ${u}/año` : 'requiere ≥2 mediciones'
      }</span></div>`;
    pop.appendChild(meta);

    const actions = el('div', { class: 'pop-actions' }, [
      el('button', { class: 'pop-close', onclick: hidePopover }, ['Cerrar']),
      el('button', { class: 'pop-more', onclick: () => { hidePopover(); openDetail(p.id); } }, ['Ver detalle →']),
    ]);
    pop.appendChild(actions);

    pop.classList.remove('hidden');
    const stageRect = $('#map-area').getBoundingClientRect();
    const popW = 240, popH = pop.offsetHeight || 200;
    let x = event.clientX - stageRect.left + 20;
    let y = event.clientY - stageRect.top - 30;
    if (x + popW > stageRect.width - 8) x = event.clientX - stageRect.left - popW - 20;
    if (y < 8) y = 8;
    if (y + popH > stageRect.height - 8) y = stageRect.height - popH - 8;
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
  }
  function hidePopover() { $('#point-popover').classList.add('hidden'); }

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#point-popover') || e.target.closest('.point')) return;
    hidePopover();
  });

  // ---------- Side panel list ----------
  function renderPointsList() {
    const ul = $('#points-list');
    const items = filterPoints().sort((a, b) => {
      // Critical first, then moderate, then bajo, then sin
      const rank = { critico: 0, moderado: 1, bajo: 2, sin: 3 };
      const r = rank[a.stats.crit] - rank[b.stats.crit];
      if (r !== 0) return r;
      return (b.stats.ultimaVel || 0) - (a.stats.ultimaVel || 0);
    });
    const u = unidad();
    $('#list-count').textContent = `${items.length} ${items.length === 1 ? 'punto' : 'puntos'}`;

    ul.innerHTML = '';
    if (items.length === 0) {
      ul.appendChild(el('li', { class: 'point-empty' }, ['Sin resultados']));
      return;
    }
    for (const { p, stats } of items) {
      const col = critColor(stats.crit);
      const li = el('li', {
        class: 'point-row' + (state.selectedId === p.id ? ' selected' : ''),
        onclick: () => {
          state.selectedId = p.id;
          openDetail(p.id);
        },
      });
      li.appendChild(el('span', {
        class: 'point-dot',
        style: { background: col, boxShadow: `0 0 0 3px ${col}22` },
      }));

      const info = el('div', { class: 'point-info' }, [
        el('div', { class: 'point-info-head' }, [
          el('div', { class: 'point-info-pozo' }, [p.pozo]),
          el('div', { class: 'point-info-id' }, [p.id]),
        ]),
      ]);
      const meta = el('div', { class: 'point-info-meta' });
      meta.appendChild(sparkline({ mediciones: stats.mediciones, color: col, width: 72, height: 18, areaOpacity: 0.15 }));
      const txt = el('span', {}, [`${stats.n} med · ${fmtFechaCorta(stats.ultimaFecha)}`]);
      meta.appendChild(txt);
      info.appendChild(meta);
      li.appendChild(info);

      const val = el('div', { class: 'point-info-val' }, [
        el('div', { class: 'num', style: { color: col } }, [stats.ultimaVel != null ? stats.ultimaVel.toFixed(2) : '—']),
        el('div', { class: 'unit' }, [u]),
      ]);
      li.appendChild(val);

      ul.appendChild(li);
    }
  }

  // ---------- Filters wiring ----------
  function setupFilters() {
    $('#search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderPointsList();
      renderMapPoints();
    });
    const wireChips = (sel, key) => {
      $$(`${sel} .chip`).forEach(c => {
        c.onclick = () => {
          $$(`${sel} .chip`).forEach(x => x.classList.remove('active'));
          c.classList.add('active');
          state[key] = c.dataset[key === 'filterFecha' ? 'fecha' : 'crit'];
          renderPointsList();
          renderMapPoints();
        };
      });
    };
    wireChips('#chips-fecha', 'filterFecha');
    wireChips('#chips-criticidad', 'filterCrit');
  }

  // ---------- Detail view ----------
  function openDetail(id) {
    const p = data.puntos.find(x => x.id === id);
    if (!p) return;
    state.selectedId = id;
    const stats = pointStats(p);
    const u = unidad();
    const col = critColor(stats.crit);

    // Title
    const title = $('#detail-title');
    title.innerHTML = '';
    title.appendChild(el('span', { class: 'pozo' }, [p.pozo]));
    title.appendChild(el('span', { class: 'id' }, [p.id]));
    title.appendChild(el('span', { class: `crit-pill ${stats.crit}` }, [
      stats.crit === 'sin' ? 'Sin datos' : `Criticidad ${stats.crit}`,
    ]));

    // KPI + meta
    const kpiVal = $('#detail-kpi-val');
    kpiVal.textContent = stats.ultimaVel != null ? stats.ultimaVel.toFixed(2) : '—';
    kpiVal.style.color = col;
    $('#detail-kpi-unit').textContent = u;

    const kv = $('#detail-kv');
    kv.innerHTML = '';
    const prev = stats.mediciones.length >= 2 ? stats.mediciones[stats.mediciones.length - 2] : null;
    const delta = prev ? stats.ultimaVel - prev.velCorrosion : null;
    const rows = [
      ['Última fecha', fmtFecha(stats.ultimaFecha)],
      ['Mediciones', stats.n],
      ['Frecuencia', stats.freqDias != null ? `${stats.freqDias} d` : '—'],
      ['Δ vs. previa', delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}` : '—'],
      ['Yacimiento', p.yacimiento || data.proyecto.yacimiento],
      ['Coordenadas', `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`],
    ];
    for (const [k, v] of rows) {
      kv.appendChild(el('div', {}, [
        el('div', { class: 'k' }, [k]),
        el('div', { class: 'v' }, [String(v)]),
      ]));
    }

    // Fit
    const fitGrid = $('#detail-fit');
    fitGrid.innerHTML = '';
    const fitCard = $('#detail-fit-card');
    if (stats.fit) {
      fitCard.style.display = '';
      // Forecast 6 months past the last measurement
      const lastMs = parseFecha(stats.ultimaFecha);
      const forecastMs = lastMs + 182 * MS_DAY;
      const daysFromT0 = (forecastMs - stats.fit.t0) / MS_DAY;
      const forecastVel = stats.fit.slopePerDay * daysFromT0 + stats.fit.intercept;
      const forecastCrit = criticidad(Math.max(0, forecastVel));
      const fcLabel = new Date(forecastMs).toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
      const fitRows = [
        ['Pendiente anual', `${stats.fit.slopePerYear >= 0 ? '+' : ''}${stats.fit.slopePerYear.toFixed(4)} ${u}/año`, stats.fit.slopePerYear > 0 ? PAL.critico : PAL.bajo],
        ['R²', stats.fit.r2.toFixed(4), PAL.text],
        ['RMSE', `${stats.fit.rmse.toFixed(4)} ${u}`, PAL.text],
        [`Proyección ${fcLabel}`, `${Math.max(0, forecastVel).toFixed(3)} ${u}`, critColor(forecastCrit)],
      ];
      for (const [k, v, c] of fitRows) {
        fitGrid.appendChild(el('div', { class: 'k' }, [k]));
        fitGrid.appendChild(el('div', { class: 'v', style: { color: c } }, [v]));
      }
    } else {
      fitCard.style.display = '';
      fitGrid.innerHTML = `<div class="k" style="grid-column:1/-1;font-style:italic">${stats.n === 1 ? 'Se requieren ≥2 mediciones para tendencia.' : 'No hay datos suficientes para ajuste.'}</div>`;
    }

    // Notes (support legacy string or { texto, autor, fecha })
    const notes = $('#detail-notes');
    notes.innerHTML = '';
    const notasObj = p.notas && typeof p.notas === 'object' ? p.notas : (p.notas ? { texto: p.notas } : null);
    if (notasObj && notasObj.texto) {
      notes.appendChild(el('div', {}, [notasObj.texto]));
      if (notasObj.autor || notasObj.fecha) {
        const foot = el('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '10.5px', color: 'var(--text-dim)' } });
        const parts = [];
        if (notasObj.fecha) parts.push(`Actualizada · ${fmtFecha(notasObj.fecha)}`);
        if (notasObj.autor) parts.push(`por <span style="color:var(--text)">${notasObj.autor}</span>`);
        foot.innerHTML = parts.join(' · ');
        notes.appendChild(foot);
      }
    }

    // Chart legend (chart itself drawn after showView, when host has size)
    const chartHost = $('#detail-chart-host');
    const chartLegend = $('#detail-chart-legend');
    chartLegend.innerHTML = `
      <span class="chart-legend-item"><span class="dot" style="background:${col}"></span>Medición</span>
      ${stats.fit ? `<span class="chart-legend-item"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="${PAL.accent}" stroke-width="1.5" stroke-dasharray="3 2"/></svg>Tendencia (R² ${stats.fit.r2.toFixed(2)})</span>` : ''}
      <span class="chart-legend-item"><span class="zone" style="background:${PAL.critico}"></span>Zonas de criticidad</span>
    `;
    chartHost.innerHTML = '';

    // Table
    const tbody = $('#detail-table tbody');
    tbody.innerHTML = '';
    const measures = stats.mediciones;
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      const prevM = i > 0 ? measures[i - 1].velCorrosion : null;
      const d = prevM != null ? m.velCorrosion - prevM : null;
      const pct = prevM != null && prevM !== 0 ? (d / prevM) * 100 : null;
      const c2 = criticidad(m.velCorrosion);
      const c2col = critColor(c2);
      const tr = el('tr');
      tr.innerHTML = `
        <td>${fmtFecha(m.fecha)}</td>
        <td class="right">${m.velCorrosion.toFixed(3)}</td>
        <td class="right ${d == null ? 'delta-none' : d > 0 ? 'delta-pos' : 'delta-neg'}">${d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(3)}</td>
        <td class="right ${pct == null ? 'delta-none' : pct > 0 ? 'delta-pos' : 'delta-neg'}">${pct == null ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'}</td>
        <td><span class="crit-cell" style="color:${c2col}"><span class="dot" style="background:${c2col}"></span>${c2.toUpperCase()}</span></td>`;
      tbody.appendChild(tr);
    }

    $('#detail-table-title').textContent = `Historial de mediciones · ${stats.n} ${stats.n === 1 ? 'registro' : 'registros'}`;

    $('#export-csv').onclick = () => exportCSV(p, stats);

    showView('detail');
    renderPointsList();

    // Draw the chart after layout so we measure the real host size.
    requestAnimationFrame(() => {
      drawIntoHost(chartHost, (w, h) => trendChart({ stats, width: w, height: h, showZones: true, showForecast: true }));
    });
  }

  function exportCSV(p, stats) {
    const lines = ['fecha,vel_corrosion'];
    for (const m of stats.mediciones) lines.push(`${m.fecha},${m.velCorrosion}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.id}_mediciones.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Replace host SVG sized to container
  function drawIntoHost(host, factory) {
    const rect = host.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(120, Math.floor(rect.height));
    host.innerHTML = '';
    host.appendChild(factory(w, h));
  }

  // ---------- Dashboard view ----------
  function openDashboard() {
    const allStats = data.puntos.map(p => ({ p, stats: pointStats(p) }));
    const u = unidad();

    // KPIs
    const totalMediciones = allStats.reduce((a, b) => a + b.stats.n, 0);
    const velValues = allStats.map(s => s.stats.ultimaVel).filter(v => v != null);
    const velMean = velValues.length ? velValues.reduce((a, b) => a + b, 0) / velValues.length : 0;
    const velMax = velValues.length ? Math.max(...velValues) : 0;
    const critCount = allStats.filter(s => s.stats.crit === 'critico').length;

    const hist = data.kpiHistorico || null;
    const histLabel = hist?.etiqueta || (hist?.fecha ? `vs. ${fmtFechaCorta(hist.fecha)}` : '');
    const deltaSub = (curr, prev, fmt = (v) => v.toFixed(0)) => {
      if (prev == null) return '';
      const d = curr - prev;
      const sign = d >= 0 ? '+' : '−';
      const pct = prev !== 0 ? Math.abs(d / prev) * 100 : 0;
      return `${sign}${fmt(Math.abs(d))} ${histLabel} (${pct.toFixed(0)}%)`;
    };
    const mediciones90d = allStats.reduce((a, b) => a + b.stats.mediciones.filter(m => Date.now() - parseFecha(m.fecha) < 91 * MS_DAY).length, 0);
    const velMeanCrit = criticidad(velMean);
    const histPozosSub = hist ? deltaSub(data.puntos.length, hist.pozos) : `${allStats.filter(s => s.stats.n > 0).length} con datos`;
    const histMedSub = hist ? deltaSub(totalMediciones, hist.mediciones) : `${mediciones90d} en últimos 90 d`;
    const histVelSub = hist
      ? `máx ${velMax.toFixed(2)} · ${deltaSub(velMean, hist.velPromedio, (v) => v.toFixed(2))}`
      : `máx ${velMax.toFixed(2)}`;
    const kpis = [
      { label: 'Puntos monitoreados', value: data.puntos.length, sub: histPozosSub, col: PAL.text },
      { label: 'Mediciones totales', value: totalMediciones, sub: histMedSub, col: PAL.text },
      { label: `Vel. promedio (${u})`, value: velMean.toFixed(2), sub: histVelSub, col: velMeanCrit === 'critico' ? PAL.critico : velMeanCrit === 'moderado' ? PAL.moderado : PAL.text },
      { label: 'Puntos críticos', value: critCount, sub: critCount > 0 ? 'requiere intervención' : 'sin alertas', col: critCount > 0 ? PAL.critico : PAL.bajo },
    ];
    const kpiHost = $('#dashboard-kpis');
    kpiHost.innerHTML = '';
    for (const k of kpis) {
      kpiHost.appendChild(el('div', { class: 'kpi-card' }, [
        el('div', { class: 'label' }, [k.label]),
        el('div', { class: 'val', style: { color: k.col } }, [String(k.value)]),
        el('div', { class: 'sub' }, [k.sub]),
      ]));
    }

    $('#dashboard-sub').textContent = `${data.puntos.length} puntos · ${totalMediciones} mediciones`;

    // ---- Donut (keep): criticidad actual por punto ----
    // Based on each point's MOST RECENT measurement, regardless of date.
    // Points are not necessarily wells — can be plant, pipeline, etc.
    const counts = { critico: 0, moderado: 0, bajo: 0, sin: 0 };
    for (const { stats } of allStats) counts[stats.crit]++;
    const donutRow = $('#donut-row');
    donutRow.innerHTML = '';
    donutRow.appendChild(donut({
      segments: [
        { value: counts.critico, color: PAL.critico },
        { value: counts.moderado, color: PAL.moderado },
        { value: counts.bajo, color: PAL.bajo },
        { value: counts.sin, color: PAL.sin },
      ],
      size: 120, thickness: 20,
      centerValue: data.puntos.length, centerLabel: 'PUNTOS',
    }));
    const legend = el('div', { class: 'donut-legend' });
    const rng = data.umbralesCriticidad;
    const legendRows = [
      ['Crítica', counts.critico, PAL.critico, `≥ ${rng.critico.toFixed(2)}`],
      ['Moderada', counts.moderado, PAL.moderado, `${rng.moderado.toFixed(2)} – ${rng.critico.toFixed(2)}`],
      ['Baja', counts.bajo, PAL.bajo, `< ${rng.moderado.toFixed(2)}`],
    ];
    if (counts.sin > 0) legendRows.push(['Sin datos', counts.sin, PAL.sin, '—']);
    for (const [l, v, c, range] of legendRows) {
      legend.appendChild(el('div', { class: 'donut-legend-item' }, [
        el('div', { class: 'left' }, [
          el('span', { class: 'swatch', style: { background: c } }),
          el('span', {}, [l]),
          el('span', { class: 'range' }, [range]),
        ]),
        el('span', { class: 'count', style: { color: c } }, [String(v)]),
      ]));
    }
    donutRow.appendChild(legend);

    // ---- Group all measurements by campaign (ISO week) ----
    const campaigns = groupByCampaign(allStats);
    const stackedData = campaigns.map(c => {
      const cnts = { critico: 0, moderado: 0, bajo: 0 };
      for (const m of c.mediciones) cnts[criticidad(m.velCorrosion)]++;
      return {
        label: campaignLabel(c),
        segments: [
          // Bottom to top: bajo, moderado, crítico.
          { value: cnts.bajo, color: PAL.bajo },
          { value: cnts.moderado, color: PAL.moderado },
          { value: cnts.critico, color: PAL.critico },
        ],
      };
    });
    const campaignBarData = campaigns.map(c => ({
      label: campaignLabel(c),
      value: c.mediciones.length,
      color: PAL.accent,
    }));
    $('#campaign-meta').textContent = campaigns.length
      ? `${campaigns.length} campaña${campaigns.length === 1 ? '' : 's'}`
      : '—';

    // ---- Global trend: all measurements + global linear fit ----
    const allM = [];
    for (const { stats } of allStats) for (const m of stats.mediciones) allM.push(m);
    allM.sort((a, b) => parseFecha(a.fecha) - parseFecha(b.fecha));
    const globalStats = { mediciones: allM, fit: linearFit(allM) };

    // Clear hosts so they don't show stale content during the showView swap.
    $('#agg-stacked-host').innerHTML = '';
    $('#agg-global-host').innerHTML = '';
    $('#agg-campaign-host').innerHTML = '';

    showView('dashboard');

    // Charts drawn after layout so they measure their real host size.
    requestAnimationFrame(() => {
      drawIntoHost($('#agg-stacked-host'), (w, h) => stackedBarChart({ data: stackedData, width: w, height: h }));
      drawIntoHost($('#agg-campaign-host'), (w, h) => barChart({ data: campaignBarData, width: w, height: h, valueFormat: (v) => Math.round(v).toString() }));
      drawIntoHost($('#agg-global-host'), (w, h) => trendChart({ stats: globalStats, width: w, height: h, showZones: true, showForecast: false }));
    });
  }

  // ---------- Navigation ----------
  function showView(name) {
    const map = $('#view-map');
    const detail = $('#view-detail');
    const dash = $('#view-dashboard');
    map.classList.toggle('hidden', name !== 'map');
    detail.classList.toggle('hidden', name !== 'detail');
    dash.classList.toggle('hidden', name !== 'dashboard');
    $$('.hdr-nav-item').forEach(it => it.classList.toggle('active', it.dataset.nav === (name === 'detail' ? 'mapa' : name)));
  }

  function setupNav() {
    $$('[data-close]').forEach(b => {
      b.onclick = () => {
        showView('map');
        // keep selectedId so the user knows which point they came from
        renderPointsList();
        renderMapPoints();
      };
    });
    $('#open-dashboard').onclick = openDashboard;
    $$('.hdr-nav-item').forEach(it => {
      it.onclick = () => {
        if (it.dataset.nav === 'mapa') showView('map');
        else if (it.dataset.nav === 'dashboard') openDashboard();
      };
    });
  }

  // ---------- Resize ----------
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!$('#view-detail').classList.contains('hidden') && state.selectedId) openDetail(state.selectedId);
      else if (!$('#view-dashboard').classList.contains('hidden')) openDashboard();
      updateScaleBar();
    }, 150);
  });

  // ---------- Init ----------
  function init() {
    applyBindings();
    renderLegend();
    setupMap();
    setupFilters();
    setupNav();
    renderPointsList();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
