// Esri World Imagery tile fetcher + stitcher.
// Given geographic bounds, downloads enough satellite tiles, stitches them
// into one PNG and crops to the exact bounds. Tiles are cached on disk so
// subsequent builds are instant. Tiles are Web Mercator (EPSG:3857) — the
// returned crop preserves that projection; callers must use Mercator math
// to place lat/lon points on it.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const TILE_SIZE = 256;
const CONCURRENCY = 6;
const USER_AGENT = 'dashboard-mediciones-build/0.1 (offline engineering report tool)';

// ---------- Web Mercator math ----------
export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
export function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

// Pick zoom level so the resulting cropped image is ~targetWidth pixels wide.
function pickZoom(bounds, targetWidth) {
  for (let z = 0; z <= 19; z++) {
    const w = (lonToTileX(bounds.east, z) - lonToTileX(bounds.west, z)) * TILE_SIZE;
    if (w >= targetWidth) return z;
  }
  return 19;
}

// ---------- Fetch with cache + retries ----------
async function fetchTile(z, x, y, cacheDir) {
  const path = resolve(cacheDir, `${z}_${x}_${y}.png`);
  if (existsSync(path)) {
    return await readFile(path);
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(TILE_URL(z, x, y), { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path, buf);
      return buf;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Tile ${z}/${x}/${y} failed: ${lastErr.message}`);
}

async function pool(items, n, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------- Raster composition (format-agnostic RGBA buffers) ----------
// Each helper works on { data: Uint8Array (RGBA), width, height }.
// Tiles come as either PNG or JPEG depending on the source (Esri World
// Imagery returns JPEG); we decode both into RGBA and composite uniformly.

function decodeTile(buf) {
  // JPEG starts with FF D8 FF; PNG with 89 50 4E 47.
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    const out = jpeg.decode(buf, { useTArray: true });
    return Promise.resolve({ data: out.data, width: out.width, height: out.height });
  }
  return new Promise((resolveP, rejectP) => {
    new PNG().parse(buf, (err, png) => err ? rejectP(err)
      : resolveP({ data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), width: png.width, height: png.height }));
  });
}

function blank(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 12; data[i + 1] = 16; data[i + 2] = 22; data[i + 3] = 255;
  }
  return { data, width, height };
}

function pasteRaster(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const srcOff = y * src.width * 4;
    const dstOff = ((dy + y) * dst.width + dx) * 4;
    dst.data.set(src.data.subarray(srcOff, srcOff + src.width * 4), dstOff);
  }
}

function cropRaster(src, x, y, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const srcOff = ((y + yy) * src.width + x) * 4;
    data.set(src.data.subarray(srcOff, srcOff + w * 4), yy * w * 4);
  }
  return { data, width: w, height: h };
}

function encodeJpeg(raster, quality = 82) {
  // jpeg-js wants RGBA in a Buffer; pass quality 1-100. Satellite imagery
  // compresses very well at 80-85, with no visible artifacts at our zoom.
  const buf = Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
  return jpeg.encode({ data: buf, width: raster.width, height: raster.height }, quality).data;
}

// ---------- Main entry ----------
export async function buildSatelliteMap({ bounds, targetWidth = 1500, cacheDir, log = () => {} }) {
  await mkdir(cacheDir, { recursive: true });

  const z = pickZoom(bounds, targetWidth);

  const txMin = lonToTileX(bounds.west, z);
  const txMax = lonToTileX(bounds.east, z);
  const tyMin = latToTileY(bounds.north, z);  // north has smaller y
  const tyMax = latToTileY(bounds.south, z);

  const tileXmin = Math.floor(txMin);
  const tileXmax = Math.floor(txMax);
  const tileYmin = Math.floor(tyMin);
  const tileYmax = Math.floor(tyMax);

  const cols = tileXmax - tileXmin + 1;
  const rows = tileYmax - tileYmin + 1;
  const totalTiles = cols * rows;

  log(`  zoom z=${z} · grid ${cols}×${rows} = ${totalTiles} tiles`);

  const tasks = [];
  for (let ty = tileYmin; ty <= tileYmax; ty++) {
    for (let tx = tileXmin; tx <= tileXmax; tx++) {
      tasks.push({ x: tx, y: ty });
    }
  }

  let fetched = 0;
  let cached = 0;
  const t0 = Date.now();
  const buffers = await pool(tasks, CONCURRENCY, async (t) => {
    const cachePath = resolve(cacheDir, `${z}_${t.x}_${t.y}.png`);
    const wasCached = existsSync(cachePath);
    const buf = await fetchTile(z, t.x, t.y, cacheDir);
    if (wasCached) cached++; else fetched++;
    return { ...t, buf };
  });
  log(`  ${fetched} bajados · ${cached} desde cache · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Stitch
  const stitched = blank(cols * TILE_SIZE, rows * TILE_SIZE);
  for (const { x, y, buf } of buffers) {
    try {
      const tile = await decodeTile(buf);
      pasteRaster(stitched, tile, (x - tileXmin) * TILE_SIZE, (y - tileYmin) * TILE_SIZE);
    } catch (e) {
      log(`  ! tile ${z}/${x}/${y} no se pudo decodificar (${e.message})`);
    }
  }

  // Crop to exact bounds
  const cropX = Math.round((txMin - tileXmin) * TILE_SIZE);
  const cropY = Math.round((tyMin - tileYmin) * TILE_SIZE);
  const cropW = Math.round((txMax - txMin) * TILE_SIZE) + 1;
  const cropH = Math.round((tyMax - tyMin) * TILE_SIZE) + 1;
  const cw = Math.min(cropW, stitched.width - cropX);
  const ch = Math.min(cropH, stitched.height - cropY);
  const cropped = cropRaster(stitched, cropX, cropY, cw, ch);

  const buffer = encodeJpeg(cropped, 82);
  return { buffer, mime: 'image/jpeg', width: cw, height: ch, zoom: z };
}
