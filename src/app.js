(function () {
  'use strict';

  const data = window.__PROYECTO__;
  const mapDataUri = window.__MAPA_DATA_URI__;

  // ---------- State ----------
  const state = {
    search: '',
    filterFecha: 'all',
    filterCrit: 'all',
    selectedId: null,
    detailChart: null,
    aggCharts: [],
  };

  // ---------- Pure helpers ----------
  const MS_DAY = 86400000;
  const parseFecha = (s) => new Date(s + 'T00:00:00Z').getTime();
  const fmtFecha = (s) => {
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  };

  function criticidad(vel) {
    if (vel == null) return 'sin';
    const u = data.umbralesCriticidad;
    if (vel >= u.critico) return 'critico';
    if (vel >= u.moderado) return 'moderado';
    return 'bajo';
  }

  function pointStats(p) {
    const ms = [...p.mediciones].sort((a, b) => parseFecha(a.fecha) - parseFecha(b.fecha));
    if (ms.length === 0) return { ultimaFecha: null, ultimaVel: null, n: 0, frecuenciaDias: null, criticidad: 'sin', tendencia: null };
    const ultima = ms[ms.length - 1];
    let freq = null;
    if (ms.length >= 2) {
      const span = parseFecha(ms[ms.length - 1].fecha) - parseFecha(ms[0].fecha);
      freq = Math.round(span / MS_DAY / (ms.length - 1));
    }
    return {
      ultimaFecha: ultima.fecha,
      ultimaVel: ultima.velCorrosion,
      n: ms.length,
      frecuenciaDias: freq,
      criticidad: criticidad(ultima.velCorrosion),
      mediciones: ms,
      tendencia: linearFit(ms),
    };
  }

  function linearFit(ms) {
    if (ms.length < 2) return null;
    const t0 = parseFecha(ms[0].fecha);
    const xs = ms.map(m => (parseFecha(m.fecha) - t0) / MS_DAY);
    const ys = ms.map(m => m.velCorrosion);
    const n = xs.length;
    const sx = xs.reduce((a, b) => a + b, 0);
    const sy = ys.reduce((a, b) => a + b, 0);
    const sxy = xs.reduce((a, _, i) => a + xs[i] * ys[i], 0);
    const sxx = xs.reduce((a, x) => a + x * x, 0);
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    const m = (n * sxy - sx * sy) / denom;
    const b = (sy - m * sx) / n;
    const yMean = sy / n;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const yPred = m * xs[i] + b;
      ssRes += (ys[i] - yPred) ** 2;
      ssTot += (ys[i] - yMean) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    const rmse = Math.sqrt(ssRes / n);
    return { slopePerDay: m, slopePerYear: m * 365.25, intercept: b, r2, rmse, t0 };
  }

  // ---------- Lat/Lon → pixel ----------
  let mapImgSize = { w: 0, h: 0 };
  function latLonToPixel(lat, lon) {
    const b = data.mapa.bounds;
    const x = ((lon - b.west) / (b.east - b.west)) * mapImgSize.w;
    const y = ((b.north - lat) / (b.north - b.south)) * mapImgSize.h;
    return { x, y };
  }

  // ---------- Filters ----------
  function filterPoints() {
    const q = state.search.trim().toLowerCase();
    const now = Date.now();
    let cutoff = null;
    if (state.filterFecha === '1y') cutoff = now - 365 * MS_DAY;
    else if (state.filterFecha === '6m') cutoff = now - 182 * MS_DAY;
    else if (state.filterFecha === '3m') cutoff = now - 91 * MS_DAY;

    return data.puntos
      .map(p => ({ p, stats: pointStats(p) }))
      .filter(({ p, stats }) => {
        if (q && !(p.pozo.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))) return false;
        if (cutoff != null) {
          if (!stats.ultimaFecha || parseFecha(stats.ultimaFecha) < cutoff) return false;
        }
        if (state.filterCrit !== 'all' && stats.criticidad !== state.filterCrit) return false;
        return true;
      });
  }

  // ---------- Data binding ----------
  function applyBindings() {
    document.querySelectorAll('[data-bind]').forEach(el => {
      const path = el.getAttribute('data-bind').split('.');
      let v = data;
      for (const k of path) v = v ? v[k] : undefined;
      el.textContent = v ?? '';
    });
    document.title = `${data.proyecto.nombre} · ${data.proyecto.yacimiento} · ${data.proyecto.fecha}`;
  }

  // ---------- Map render ----------
  let panzoomInstance = null;
  function setupMap() {
    const img = document.getElementById('map-bg');
    img.onload = () => {
      mapImgSize = { w: img.naturalWidth, h: img.naturalHeight };
      const svg = document.getElementById('points-layer');
      svg.setAttribute('width', mapImgSize.w);
      svg.setAttribute('height', mapImgSize.h);
      svg.setAttribute('viewBox', `0 0 ${mapImgSize.w} ${mapImgSize.h}`);
      renderMapPoints();
      initPanzoom();
      fitMapToStage();
    };
    img.src = mapDataUri;
  }

  function initPanzoom() {
    if (panzoomInstance || !window.panzoom) return;
    panzoomInstance = window.panzoom(document.getElementById('map-zoomer'), {
      minZoom: 0.1,
      maxZoom: 10,
      smoothScroll: false,
      beforeWheel: () => false,
    });
    document.getElementById('zoom-in').onclick = () => panzoomInstance.smoothZoom(window.innerWidth / 2, window.innerHeight / 2, 1.3);
    document.getElementById('zoom-out').onclick = () => panzoomInstance.smoothZoom(window.innerWidth / 2, window.innerHeight / 2, 0.7);
    document.getElementById('zoom-reset').onclick = fitMapToStage;
  }

  function fitMapToStage() {
    if (!panzoomInstance) return;
    const stage = document.getElementById('map-stage');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const scale = Math.min(sw / mapImgSize.w, sh / mapImgSize.h) * 0.9;
    panzoomInstance.zoomAbs(0, 0, scale);
    const offsetX = (sw - mapImgSize.w * scale) / 2 - sw / 2;
    const offsetY = (sh - mapImgSize.h * scale) / 2 - sh / 2;
    panzoomInstance.moveTo(offsetX, offsetY);
  }

  function renderMapPoints() {
    const svg = document.getElementById('points-layer');
    svg.innerHTML = '';
    const visible = filterPoints();
    const visibleIds = new Set(visible.map(v => v.p.id));
    for (const { p, stats } of data.puntos.map(p => ({ p, stats: pointStats(p) }))) {
      const { x, y } = latLonToPixel(p.lat, p.lon);
      const r = visibleIds.has(p.id) ? 10 : 5;
      const opacity = visibleIds.has(p.id) ? 1 : 0.25;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r', r);
      circle.setAttribute('class', `point point-${stats.criticidad}`);
      circle.setAttribute('opacity', opacity);
      circle.dataset.id = p.id;
      circle.addEventListener('click', (e) => {
        e.stopPropagation();
        showPopover(p, stats, e);
      });
      svg.appendChild(circle);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x + 14);
      label.setAttribute('y', y + 4);
      label.setAttribute('class', 'point-label');
      label.setAttribute('opacity', opacity);
      label.textContent = p.pozo;
      svg.appendChild(label);
    }
  }

  // ---------- Popover ----------
  function showPopover(p, stats, event) {
    const pop = document.getElementById('point-popover');
    const unidad = data.umbralesCriticidad.unidad || 'mm/año';
    pop.innerHTML = `
      <div class="pop-title">${p.pozo} <span style="color:var(--text-dim);font-weight:400">· ${p.id}</span></div>
      <div class="pop-row">Última: <strong>${stats.ultimaVel != null ? stats.ultimaVel.toFixed(3) : '–'} ${unidad}</strong></div>
      <div class="pop-row">Fecha: <strong>${stats.ultimaFecha ? fmtFecha(stats.ultimaFecha) : '–'}</strong></div>
      <div class="pop-row">Criticidad: <strong style="color:var(--crit-${stats.criticidad})">${stats.criticidad.toUpperCase()}</strong></div>
      <div class="pop-row">Mediciones: <strong>${stats.n}</strong></div>
      <div class="pop-actions">
        <button class="pop-close">Cerrar</button>
        <button class="pop-more">Ver más</button>
      </div>`;
    pop.classList.remove('hidden');
    const stageRect = document.getElementById('map-stage').getBoundingClientRect();
    const x = Math.min(event.clientX - stageRect.left + 16, stageRect.width - 240);
    const y = Math.min(event.clientY - stageRect.top + 16, stageRect.height - 200);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.querySelector('.pop-close').onclick = () => pop.classList.add('hidden');
    pop.querySelector('.pop-more').onclick = () => {
      pop.classList.add('hidden');
      openDetail(p.id);
    };
  }

  document.addEventListener('click', (e) => {
    const pop = document.getElementById('point-popover');
    if (!pop.contains(e.target) && !e.target.classList.contains('point')) {
      pop.classList.add('hidden');
    }
  });

  // ---------- Side panel list ----------
  function renderPointsList() {
    const ul = document.getElementById('points-list');
    const items = filterPoints();
    const unidad = data.umbralesCriticidad.unidad || 'mm/año';
    ul.innerHTML = '';
    if (items.length === 0) {
      ul.innerHTML = '<li style="padding:24px 12px;color:var(--text-dim);text-align:center;font-size:13px">Sin resultados</li>';
      return;
    }
    for (const { p, stats } of items) {
      const li = document.createElement('li');
      li.className = 'point-row' + (state.selectedId === p.id ? ' selected' : '');
      li.innerHTML = `
        <span class="point-dot" style="background:var(--crit-${stats.criticidad})"></span>
        <div class="point-info">
          <div class="point-info-pozo">${p.pozo}</div>
          <div class="point-info-meta">${p.id} · ${stats.n} med. · ${stats.ultimaFecha ? fmtFecha(stats.ultimaFecha) : '—'}</div>
        </div>
        <div class="point-info-vel">${stats.ultimaVel != null ? stats.ultimaVel.toFixed(3) : '—'}<br><span style="color:var(--text-dim);font-size:10px">${unidad}</span></div>`;
      li.onclick = () => openDetail(p.id);
      ul.appendChild(li);
    }
  }

  // ---------- Filters wiring ----------
  function setupFilters() {
    document.getElementById('search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderPointsList();
      renderMapPoints();
    });
    document.querySelectorAll('#chips-fecha .chip').forEach(c => {
      c.onclick = () => {
        document.querySelectorAll('#chips-fecha .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        state.filterFecha = c.dataset.fecha;
        renderPointsList();
        renderMapPoints();
      };
    });
    document.querySelectorAll('#chips-criticidad .chip').forEach(c => {
      c.onclick = () => {
        document.querySelectorAll('#chips-criticidad .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        state.filterCrit = c.dataset.crit;
        renderPointsList();
        renderMapPoints();
      };
    });
  }

  // ---------- Detail view ----------
  function openDetail(id) {
    state.selectedId = id;
    const p = data.puntos.find(x => x.id === id);
    if (!p) return;
    const stats = pointStats(p);
    const unidad = data.umbralesCriticidad.unidad || 'mm/año';

    document.getElementById('detail-title').textContent = `${p.pozo} · ${p.id}`;

    const info = document.getElementById('detail-info');
    info.innerHTML = '';
    const rows = [
      ['Pozo', p.pozo],
      ['ID', p.id],
      ['Yacimiento', p.yacimiento],
      ['Coordenadas', `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`],
      ['Última medición', stats.ultimaFecha ? fmtFecha(stats.ultimaFecha) : '—'],
      ['Última velocidad', stats.ultimaVel != null ? `${stats.ultimaVel.toFixed(3)} ${unidad}` : '—'],
      ['Total mediciones', stats.n],
      ['Frecuencia promedio', stats.frecuenciaDias != null ? `${stats.frecuenciaDias} días` : '—'],
      ['Criticidad actual', stats.criticidad.toUpperCase()],
      ['Tendencia anual', stats.tendencia ? `${(stats.tendencia.slopePerYear >= 0 ? '+' : '')}${stats.tendencia.slopePerYear.toFixed(3)} ${unidad}/año` : '—'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      info.append(dt, dd);
    }

    renderDetailChart(stats, unidad);
    renderDetailTable(stats, unidad);
    renderDetailFit(stats, unidad);

    document.getElementById('detail-notes').textContent = p.notas || '';
    document.getElementById('export-csv').onclick = () => exportCSV(p, stats);

    showView('detail');
    renderPointsList();
  }

  function renderDetailChart(stats, unidad) {
    if (state.detailChart) { state.detailChart.destroy(); state.detailChart = null; }
    const ctx = document.getElementById('detail-chart');
    const points = stats.mediciones.map(m => ({ x: parseFecha(m.fecha), y: m.velCorrosion }));
    const datasets = [{
      label: 'Mediciones',
      data: points,
      backgroundColor: '#4a9eff',
      borderColor: '#4a9eff',
      pointRadius: 5,
      showLine: false,
    }];
    if (stats.tendencia) {
      const t0 = stats.tendencia.t0;
      const xMin = points[0].x;
      const xMax = points[points.length - 1].x;
      const yFor = (x) => {
        const days = (x - t0) / MS_DAY;
        return stats.tendencia.slopePerDay * days + stats.tendencia.intercept;
      };
      datasets.push({
        label: 'Tendencia (mín. cuadrados)',
        data: [{ x: xMin, y: yFor(xMin) }, { x: xMax, y: yFor(xMax) }],
        borderColor: '#fbbf24',
        borderDash: [6, 4],
        pointRadius: 0,
        showLine: true,
        fill: false,
      });
    }
    state.detailChart = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: 'linear',
            ticks: { color: '#8b95a3', callback: (v) => fmtFecha(new Date(v).toISOString().slice(0, 10)) },
            grid: { color: '#2d3744' },
          },
          y: {
            title: { display: true, text: unidad, color: '#8b95a3' },
            ticks: { color: '#8b95a3' },
            grid: { color: '#2d3744' },
            beginAtZero: true,
          },
        },
        plugins: {
          legend: { labels: { color: '#e6e9ee' } },
          tooltip: { callbacks: { title: (items) => fmtFecha(new Date(items[0].parsed.x).toISOString().slice(0, 10)) } },
        },
      },
    });
  }

  function renderDetailTable(stats, unidad) {
    const tbody = document.querySelector('#detail-table tbody');
    tbody.innerHTML = '';
    for (const m of stats.mediciones) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmtFecha(m.fecha)}</td><td>${m.velCorrosion.toFixed(3)}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderDetailFit(stats, unidad) {
    const el = document.getElementById('detail-fit');
    if (!stats.tendencia) {
      el.innerHTML = stats.n === 1
        ? '<em>Se requieren ≥2 mediciones para calcular tendencia.</em>'
        : '<em>No hay datos suficientes para ajuste.</em>';
      return;
    }
    const t = stats.tendencia;
    el.innerHTML = `
      <div>Pendiente: <strong>${(t.slopePerYear >= 0 ? '+' : '')}${t.slopePerYear.toFixed(4)} ${unidad}/año</strong></div>
      <div>R²: <strong>${t.r2.toFixed(4)}</strong></div>
      <div>Error (RMSE): <strong>${t.rmse.toFixed(4)} ${unidad}</strong></div>`;
  }

  function exportCSV(p, stats) {
    const lines = ['fecha,vel_corrosion_mm_anio'];
    for (const m of stats.mediciones) lines.push(`${m.fecha},${m.velCorrosion}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.id}_mediciones.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Dashboard view ----------
  function openDashboard() {
    state.aggCharts.forEach(c => c.destroy());
    state.aggCharts = [];
    const allStats = data.puntos.map(p => ({ p, stats: pointStats(p) }));

    const unidad = data.umbralesCriticidad.unidad || 'mm/año';
    state.aggCharts.push(renderAggMedicionesPorTrimestre(allStats));
    state.aggCharts.push(renderAggCriticidad(allStats));
    state.aggCharts.push(renderAggTendencias(allStats));
    state.aggCharts.push(renderAggDispersion(allStats, unidad));

    showView('dashboard');
  }

  function renderAggMedicionesPorTrimestre(allStats) {
    const counts = {};
    for (const { stats } of allStats) {
      for (const m of stats.mediciones || []) {
        const d = new Date(m.fecha);
        const q = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        counts[q] = (counts[q] || 0) + 1;
      }
    }
    const labels = Object.keys(counts).sort();
    return new Chart(document.getElementById('agg-chart-1'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Mediciones', data: labels.map(l => counts[l]), backgroundColor: '#4a9eff' }] },
      options: baseChartOpts(),
    });
  }

  function renderAggCriticidad(allStats) {
    const c = { bajo: 0, moderado: 0, critico: 0, sin: 0 };
    for (const { stats } of allStats) c[stats.criticidad]++;
    return new Chart(document.getElementById('agg-chart-2'), {
      type: 'doughnut',
      data: {
        labels: ['Baja', 'Moderada', 'Crítica', 'Sin datos'],
        datasets: [{ data: [c.bajo, c.moderado, c.critico, c.sin], backgroundColor: ['#4ade80', '#fbbf24', '#ef4444', '#6b7280'] }],
      },
      options: { ...baseChartOpts(), scales: {} },
    });
  }

  function renderAggTendencias(allStats) {
    const labels = [], values = [], colors = [];
    for (const { p, stats } of allStats) {
      if (!stats.tendencia) continue;
      labels.push(p.pozo);
      values.push(+(stats.tendencia.slopePerYear).toFixed(4));
      colors.push(stats.tendencia.slopePerYear > 0 ? '#ef4444' : '#4ade80');
    }
    return new Chart(document.getElementById('agg-chart-3'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Pendiente anual', data: values, backgroundColor: colors }] },
      options: baseChartOpts(),
    });
  }

  function renderAggDispersion(allStats, unidad) {
    const points = [];
    for (const { stats } of allStats) {
      for (const m of stats.mediciones || []) points.push({ x: parseFecha(m.fecha), y: m.velCorrosion });
    }
    return new Chart(document.getElementById('agg-chart-4'), {
      type: 'scatter',
      data: { datasets: [{ label: 'Todas las mediciones', data: points, backgroundColor: 'rgba(74,158,255,0.6)', pointRadius: 3 }] },
      options: {
        ...baseChartOpts(),
        scales: {
          x: { type: 'linear', ticks: { color: '#8b95a3', callback: (v) => fmtFecha(new Date(v).toISOString().slice(0, 10)) }, grid: { color: '#2d3744' } },
          y: { title: { display: true, text: unidad, color: '#8b95a3' }, ticks: { color: '#8b95a3' }, grid: { color: '#2d3744' }, beginAtZero: true },
        },
      },
    });
  }

  function baseChartOpts() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e6e9ee' } } },
      scales: {
        x: { ticks: { color: '#8b95a3' }, grid: { color: '#2d3744' } },
        y: { ticks: { color: '#8b95a3' }, grid: { color: '#2d3744' }, beginAtZero: true },
      },
    };
  }

  // ---------- View navigation ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const target = name === 'map' ? 'view-map' : name === 'detail' ? 'view-detail' : 'view-dashboard';
    document.getElementById(target).classList.remove('hidden');
  }

  function setupNav() {
    document.querySelectorAll('[data-close]').forEach(b => {
      b.onclick = () => {
        showView('map');
        state.selectedId = null;
        renderPointsList();
      };
    });
    document.getElementById('open-dashboard').onclick = openDashboard;
  }

  // ---------- Init ----------
  function init() {
    applyBindings();
    setupMap();
    setupFilters();
    setupNav();
    renderPointsList();
    window.addEventListener('resize', () => {
      // Re-fit on rotate / window resize would be nice but keep it simple
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
