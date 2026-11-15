/**
 * Tier B: exact heightfield visibility marcher (PRD Part B §7.3) and
 * analytic disc visibility (§7.2 discVisible, §7.4 eclipse overlap).
 */

import { HORIZON_MAX_DISTANCE_M, R_MOON } from "./constants";
import { curvatureElevation } from "./frames";

export interface Heightfield {
  /** Grid size (square) */
  px: number;
  /** Meters per texel */
  texelM: number;
  /** Grid bounds [xmin, ymin, xmax, ymax] in polar-stereographic meters */
  bounds: [number, number, number, number];
  /** Row-major heights [m], index = y*px + x, y=0 at bounds ymin */
  heights: Float32Array;
}

/** Bilinear sample of the heightfield at grid coordinates (x, y) in meters. */
export function sampleBilinear(hf: Heightfield, x: number, y: number): number {
  const fx = (x - hf.bounds[0]) / hf.texelM;
  const fy = (y - hf.bounds[1]) / hf.texelM;
  const px = hf.px;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 >= px - 1 || y0 >= px - 1) {
    // Edge clamp:
    const cx = Math.min(px - 1, Math.max(0, Math.round(fx)));
    const cy = Math.min(px - 1, Math.max(0, Math.round(fy)));
    return hf.heights[cy * px + cx] ?? 0;
  }
  const tx = fx - x0;
  const ty = fy - y0;
  const h = hf.heights;
  const i00 = y0 * px + x0;
  const h00 = h[i00] as number;
  const h10 = h[i00 + 1] as number;
  const h01 = h[i00 + px] as number;
  const h11 = h[i00 + px + 1] as number;
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

export interface HorizonResult {
  /** Maximum terrain elevation angle along the ray [rad] */
  theta: number;
  /** Distance of the obstruction producing theta [m] */
  dHit: number;
}

/** March along an azimuth and return the max curvature-corrected elevation angle (§7.3). */
export function horizonAngleAlong(
  hf: Heightfield,
  x0: number,
  y0: number,
  hObs: number,
  azRad: number,
  maxD: number = HORIZON_MAX_DISTANCE_M,
  R: number = R_MOON,
): HorizonResult {
  let theta = -Infinity;
  let dHit = 0;
  const step0 = Math.max(hf.texelM, 1);
  for (let d = step0; d <= maxD; d += Math.max(hf.texelM, 0.01 * d)) {
    const x = x0 + d * Math.sin(azRad);
    const y = y0 + d * Math.cos(azRad);
    if (
      x < hf.bounds[0] || x > hf.bounds[2] || y < hf.bounds[1] || y > hf.bounds[3]
    ) {
      if (d > 20_000) break; // outside the AOI and no context DEM loaded
    }
    const ht = sampleBilinear(hf, x, y);
    const th = curvatureElevation(d, hObs, ht, R);
    if (th > theta) {
      theta = th;
      dHit = d;
    }
  }
  return { theta, dHit };
}

/**
 * First terrain intersection along a sight line from (x0, y0, h) toward (dx, dy, dz)
 * in the grid frame (dz up). Used for laser hit points and validation.
 */
export function rayTerrainHit(
  hf: Heightfield,
  x0: number,
  y0: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
  maxD: number = HORIZON_MAX_DISTANCE_M,
): { blocked: boolean; dHit: number } {
  // dz is a direction cosine along local up; treat the ray in the grid frame:
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return { blocked: false, dHit: 0 };
  let d = Math.max(hf.texelM, 1);
  while (d <= maxD) {
    const x = x0 + dx * d;
    const y = y0 + dy * d;
    const z = z0 + dz * d;
    const ht = sampleBilinear(hf, x, y);
    if (z < ht) return { blocked: true, dHit: d };
    // Adaptive step: finer near the observer
    d += Math.max(hf.texelM, 0.005 * d);
  }
  return { blocked: false, dHit: 0 };
}

/**
 * Fraction of a disc of angular radius r [rad] whose center is at elevation e [rad],
 * above a horizon line at h [rad] (§7.2). Horizon assumed locally straight.
 */
export function discVisible(e: number, h: number, r: number): number {
  const d = Math.min(1, Math.max(-1, (e - h) / r));
  const f = 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
  // Clamp away floating-point excursions outside [0, 1]:
  return Math.min(1, Math.max(0, f));
}

/**
 * Overlap fraction of the Sun's disc occluded by the Earth's disc (lunar eclipse
 * geometry, PRD §7.4). δ = center separation, rS = Sun radius, rE = Earth radius (rad).
 */
export function eclipseOcclusion(delta: number, rS: number, rE: number): number {
  if (delta >= rS + rE) return 0;
  if (delta <= Math.abs(rE - rS)) {
    const r = Math.min(rS, rE);
    return (r * r) / (rS * rS);
  }
  // Lens area between two circles:
  const d = delta;
  const r1 = rS;
  const r2 = rE;
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const a3 = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return Math.min(1, (a1 + a2 - a3) / (Math.PI * r1 * r1));
}
