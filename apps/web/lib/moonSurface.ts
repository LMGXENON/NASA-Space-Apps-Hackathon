"use client";

/**
 * Procedural lunar surface (upgrade §2).
 *
 * A deterministic, LRO-shaped synthesised selenographic surface: fbm mare /
 * highland albedo plus a power-law crater field with dark floors and bright rims.
 * Shared by the 3D globe texture and the 2D minimap disc so the two always agree.
 *
 * The real 24k/64k LRO "CGI Moon Kit" products are hundreds of megabytes and are
 * intentionally not bundled into the static export; point
 * `NEXT_PUBLIC_MOON_ALBEDO` at a real equirectangular albedo to replace this.
 */

export interface Crater {
  lat: number;
  lon: number;
  r: number;
}

/** Deterministic PRNG so the synthesised surface is identical every load. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash2 = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Cheap value noise, adequate for a shaded lunar surface. */
export function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

export function fbm(x: number, y: number, octaves = 5): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f);
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

/** Power-law crater field: many small, few large, uniform over the sphere. */
export function buildCraters(count = 900, seed = 20261010): Crater[] {
  const rnd = mulberry32(seed);
  const craters: Crater[] = [];
  for (let i = 0; i < count; i++) {
    const v = Math.acos(2 * rnd() - 1) / Math.PI; // uniform on the sphere
    const size = rnd() ** 3.2;
    craters.push({
      lat: Math.PI * (0.5 - v),
      lon: (2 * rnd() - 1) * Math.PI,
      r: (0.004 + size * 0.09) * (Math.PI / 2),
    });
  }
  return craters;
}

/**
 * Crater-free base albedo `g` (0..1): maria flooded lowlands versus brighter
 * highlands, plus fine regolith speckle. `lat`/`lon` in radians.
 *
 * Kept separate from the crater field so large rasters can evaluate this per
 * pixel (two fbm evaluations) and then stamp craters with canvas primitives —
 * an O(pixels · craters) loop is what makes a naive implementation unusable.
 */
export function baseAlbedo(lat: number, lon: number, fine = true): number {
  const cl = Math.cos(lat);
  const nx = cl * Math.cos(lon);
  const ny = Math.sin(lat);
  const nz = cl * Math.sin(lon);
  const maria = fbm(nx * 2.1 + 5, nz * 2.1 + ny * 1.4, 4);
  let g = 0.52 + 0.3 * maria;
  if (maria < 0.42) g -= 0.13 * (0.42 - maria);
  if (fine) g += (fbm(nx * 90, nz * 90 + ny * 40, 2) - 0.5) * 0.06;
  return Math.min(1, Math.max(0.02, g));
}

/**
 * Surface albedo `g` (0..1) and a signed relief term at a selenographic point,
 * including the crater field. `lat`/`lon` in radians.
 *
 * Each crater is rejected by a cheap latitude-band bounding test before the
 * distance is evaluated, so this stays usable for the small minimap disc where
 * the O(pixels · craters) cost is only ~30 M operations.
 */
export function moonAlbedo(lat: number, lon: number, craters: Crater[], fine = true): { g: number; relief: number } {
  let g = baseAlbedo(lat, lon, fine);
  const cl = Math.cos(lat);
  const span = Math.max(0.05, Math.abs(cl));
  let relief = 0;
  for (const c of craters) {
    // Bounding rejection before the (modulo-heavy) longitude delta.
    if (Math.abs(lat - c.lat) > c.r * 1.35) continue;
    const dLon = (((lon - c.lon + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const d = Math.hypot(lat - c.lat, dLon * span);
    if (d < c.r * 1.35) {
      const t = d / c.r;
      if (t < 0.82) { g -= 0.1; relief -= 0.35; }
      else if (t < 1.05) { g += 0.13; relief += 0.5; }
      else relief += 0.12 * (1 - (t - 1.05) / 0.3);
    }
  }
  return { g: Math.min(1, Math.max(0.02, g)), relief };
}
