/**
 * Scene mapping and the CPU mirror of the shader's horizon math.
 * Scene frame: meters, origin at AOI center, Y up, X = grid +X, Z = −grid +Y.
 */

import { THETA_MIN_DEG, THETA_STEP_DEG } from "@helios/core";
import type { TerrainData } from "./data";

export interface Heightfield {
  px: number;
  texelM: number;
  bounds: [number, number, number, number];
  heights: Float32Array;
}

export const AOI_HALF = 20_000;

/** Terrain render-mesh resolution (PRD §8 "balanced" tier): 40 km / 256 = 156 m
 *  per quad. The GPU displaces only these vertices and interpolates linearly
 *  between them, so anything meant to touch the *visible* surface must sample
 *  the mesh, not the full-resolution DEM. */
export const MESH_SEG = 256;

export function gridToScene(x: number, y: number): [number, number, number] {
  return [x, 0, -y];
}

export function sceneToGridXZ(sx: number, sz: number): { x: number; y: number } {
  return { x: sx, y: -sz };
}

/** Heightfield bilinear sample in grid meters (CPU mirror of worker + shader). */
export function sampleHeight(hf: Heightfield, x: number, y: number): number {
  const fx = (x - hf.bounds[0]) / hf.texelM - 0.5;
  const fy = (y - hf.bounds[1]) / hf.texelM - 0.5;
  const px = hf.px;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 >= px - 1 || y0 >= px - 1) {
    const cx = Math.min(px - 1, Math.max(0, Math.round(fx)));
    const cy = Math.min(px - 1, Math.max(0, Math.round(fy)));
    return hf.heights[cy * px + cx] ?? 0;
  }
  const tx = fx - x0, ty = fy - y0;
  const i00 = y0 * px + x0;
  const h = hf.heights;
  return (
    h[i00]! * (1 - tx) * (1 - ty) + h[i00 + 1]! * tx * (1 - ty) +
    h[i00 + px]! * (1 - tx) * ty + h[i00 + px + 1]! * tx * ty
  );
}

export function sceneHeightAt(terrain: TerrainData, sx: number, sz: number): number {
  const { x, y } = sceneToGridXZ(sx, sz);
  return sampleHeight(terrain.hf, x, y);
}

/**
 * Height of the *rendered* terrain mesh at a grid point.
 *
 * The viewport's PlaneGeometry has only `seg`×`seg` quads, so the GPU displaces
 * the DEM at those vertices and interpolates linearly across the two triangles
 * per quad. `sampleHeight` instead bilinearly reads the full-resolution DEM, so
 * on the roughest rims it sits up to ~28 m (mean ~1 m) away from the surface the
 * user actually sees. Objects that must appear to rest on the terrain — the
 * rover, its Sun/Earth rays and the waypoint path — sample this mesh instead, so
 * they stay glued to the visible surface at any zoom.
 *
 * Vertex/grid mapping mirrors the vertex shader: plane vertex (i, j) is grid
 * (x0 + i·segX, y1 − j·segY), and PlaneGeometry splits each quad into the
 * triangles (a,b,d) and (b,c,d) with a=(i,j), b=(i,j+1), c=(i+1,j+1), d=(i+1,j).
 */
export function meshSurfaceHeight(
  hf: Heightfield,
  x: number,
  y: number,
  seg: number = MESH_SEG,
): number {
  const [x0, , x1, y1] = hf.bounds;
  const segX = (x1 - x0) / seg;
  const segY = (hf.bounds[3] - hf.bounds[1]) / seg;
  const gx = (x - x0) / segX;
  const gy = (y1 - y) / segY;
  const i = Math.min(seg - 1, Math.max(0, Math.floor(gx)));
  const j = Math.min(seg - 1, Math.max(0, Math.floor(gy)));
  // Clamp the in-cell fractions so coordinates just outside the AOI (e.g. a
  // hand-edited ?rx/ry) clamp to the edge instead of extrapolating.
  const tx = Math.min(1, Math.max(0, gx - i));
  const ty = Math.min(1, Math.max(0, gy - j));
  const vx = (ii: number) => x0 + ii * segX;
  const vy = (jj: number) => y1 - jj * segY;
  const hA = sampleHeight(hf, vx(i), vy(j));
  const hB = sampleHeight(hf, vx(i), vy(j + 1));
  const hC = sampleHeight(hf, vx(i + 1), vy(j + 1));
  const hD = sampleHeight(hf, vx(i + 1), vy(j));
  return tx + ty <= 1
    ? (1 - tx - ty) * hA + tx * hD + ty * hB
    : (tx + ty - 1) * hC + (1 - tx) * hB + (1 - ty) * hD;
}

/**
 * Unit normal of the *rendered* terrain mesh at a grid point, in scene space
 * (X = grid X, Y = up, Z = −grid Y).
 *
 * This is the normal of the actual triangle the GPU rasterised, not a
 * finite-difference approximation from the DEM, so a prop oriented to it lies
 * flush with the visible surface. `exaggeration` scales the vertical axis only,
 * matching the vertex shader and the normal it derives per fragment.
 *
 * NOTE: this is deliberately computed on the CPU. A THREE.Raycaster against the
 * terrain mesh cannot be used here: the displacement happens in the vertex
 * shader, so the CPU-side BufferGeometry the raycaster tests is the flat plane
 * (y = 0, normal = +Y) and every "surface" hit would be wrong.
 */
export function meshSurfaceNormal(
  hf: Heightfield,
  x: number,
  y: number,
  seg: number = MESH_SEG,
  exaggeration = 1,
): [number, number, number] {
  const [x0, , x1, y1] = hf.bounds;
  const segX = (x1 - x0) / seg;
  const segY = (hf.bounds[3] - hf.bounds[1]) / seg;
  const gx = (x - x0) / segX;
  const gy = (y1 - y) / segY;
  const i = Math.min(seg - 1, Math.max(0, Math.floor(gx)));
  const j = Math.min(seg - 1, Math.max(0, Math.floor(gy)));
  const tx = Math.min(1, Math.max(0, gx - i));
  const ty = Math.min(1, Math.max(0, gy - j));
  const vx = (ii: number) => x0 + ii * segX;
  const vy = (jj: number) => y1 - jj * segY;
  // Scene-space corner of a mesh vertex: (grid X, exaggerated height, -grid Y).
  const v = (ii: number, jj: number): [number, number, number] => [
    vx(ii),
    sampleHeight(hf, vx(ii), vy(jj)) * exaggeration,
    -vy(jj),
  ];
  const A = v(i, j);
  const B = v(i, j + 1);
  const C = v(i + 1, j + 1);
  const D = v(i + 1, j);
  // Same triangle split as meshSurfaceHeight / PlaneGeometry.
  const [p, q, r] = tx + ty <= 1 ? [A, B, D] : [B, C, D];
  const e1: [number, number, number] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const e2: [number, number, number] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  let nx = e1[1] * e2[2] - e1[2] * e2[1];
  let ny = e1[2] * e2[0] - e1[0] * e2[2];
  let nz = e1[0] * e2[1] - e1[1] * e2[0];
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  // The mesh is closed and upward-facing; force the outward (up) hemisphere.
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  return [nx, ny, nz];
}

/**
 * First terrain intersection along a *scene-space* ray (FR-R3: "the hit point lies
 * on the terrain surface ±1 texel").
 *
 * The ray is marched against the rendered mesh (`meshSurfaceHeight`) in the same
 * exaggerated scene space the lasers are drawn in, so the red line terminates
 * exactly on the visible surface rather than on the undisplaced DEM. The crossing
 * is refined by bisection, so the returned distance is well inside one mesh texel.
 *
 * Returns `dHit` = distance along the ray from the origin to the surface.
 */
export function sceneRayTerrainHit(
  hf: Heightfield,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  hMin: number,
  exaggeration = 1,
  maxD = 80_000,
): { blocked: boolean; dHit: number } {
  // scene X = grid X, scene Z = -grid Y.
  const surfY = (sx: number, sz: number) => (meshSurfaceHeight(hf, sx, -sz) - hMin) * exaggeration;
  const inside = (d: number) => oy + dy * d <= surfY(ox + dx * d, oz + dz * d);
  let dPrev = 0;
  let d = Math.max(hf.texelM * 0.5, 0.5);
  while (d <= maxD) {
    if (inside(d)) {
      let lo = dPrev;
      let hi = d;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (inside(mid)) hi = mid;
        else lo = mid;
      }
      return { blocked: true, dHit: hi };
    }
    dPrev = d;
    d += Math.max(hf.texelM * 0.25, 0.003 * d);
  }
  return { blocked: false, dHit: 0 };
}

/** Horizon angle [rad] at grid point (x,y) for azimuth azRad, from the packed bin.
 *  Az 0 = +Y (grid north), toward +X. Bin layout: layer = az>>2, comp = az&3.
 *
 *  `azRad` is an ENU azimuth (0 = local north, toward local east, as returned by
 *  skyAzEl). The stereographic grid is conformal, so the grid azimuth differs by
 *  exactly the selenographic longitude of the observer; that conversion happens
 *  here so every caller can pass a plain ENU azimuth.
 *
 *  The horizon map spans `bounds` at `px` resolution with its OWN texel size —
 *  the bake downsamples the DEM (e.g. 1024² → 512²), so it is NOT the height
 *  texture's texel. It is derived here from bounds/px so callers cannot supply
 *  the wrong one (doing so used to clamp every lookup into the map corner). */
export function horizonAngleBin(
  horizon: ArrayBuffer,
  px: number,
  nAz: number,
  x: number,
  y: number,
  azRad: number,
  bounds: [number, number, number, number],
): number {
  const bytes = new Uint8Array(horizon);
  const azGrid = azRad + Math.atan2(x, y); // ENU -> grid azimuth
  const a = ((azGrid % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const af = (a / (2 * Math.PI)) * nAz;
  const i0 = Math.floor(af), i1 = (i0 + 1) % nAz;
  const t = af - i0;
  const texelM = (bounds[2] - bounds[0]) / px;
  const fx = (x - bounds[0]) / texelM - 0.5;
  const fy = (y - bounds[1]) / texelM - 0.5;
  const xi = Math.min(px - 1, Math.max(0, Math.round(fx)));
  const yi = Math.min(px - 1, Math.max(0, Math.round(fy)));
  const ti = yi * px + xi;
  const layerPx = px * px * 4;
  const read = (azBin: number) => bytes[(azBin >> 2) * layerPx + ti * 4 + (azBin & 3)]!;
  const b = read(i0) * (1 - t) + read(i1) * t;
  return (THETA_MIN_DEG + b * THETA_STEP_DEG) * (Math.PI / 180);
}

/**
 * Position along the rover's waypoint path after `elapsedSec` of driving
 * (PRD FR-B4). Shared by the rover worker and the 3D view so the animated
 * rover traces exactly the trajectory the simulation assumed.
 */
export function pathPositionAt(
  site: { x: number; y: number },
  path: { x: number; y: number }[],
  speedMps: number,
  elapsedSec: number,
): { x: number; y: number; moving: boolean; heading: number; slopeRad: number } {
  const wpts = [site, ...path];
  const still = { x: site.x, y: site.y, moving: false, heading: 0, slopeRad: 0 };
  if (wpts.length < 2 || speedMps <= 0) return still;

  const segLen: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < wpts.length; i++) {
    const L = Math.hypot(wpts[i]!.x - wpts[i - 1]!.x, wpts[i]!.y - wpts[i - 1]!.y);
    segLen.push(L);
    totalLen += L;
  }
  if (totalLen <= 0) return still;

  const sTrav = Math.min(totalLen, speedMps * elapsedSec);
  let acc = 0;
  for (let k = 0; k < segLen.length; k++) {
    const L = segLen[k]!;
    if (sTrav <= acc + L || k === segLen.length - 1) {
      const f = L > 0 ? Math.min(1, (sTrav - acc) / L) : 1;
      const a = wpts[k]!, b = wpts[k + 1]!;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        moving: sTrav < totalLen - 1,
        heading: Math.atan2(b.x - a.x, b.y - a.y),
        slopeRad: 0,
      };
    }
    acc += L;
  }
  return still;
}

/** Slope of the segment currently being driven (rad above horizontal). */
export function segmentSlopeRad(
  a: { x: number; y: number },
  b: { x: number; y: number },
  hA: number,
  hB: number,
): number {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  return L > 0 ? Math.atan2(Math.abs(hB - hA), L) : 0;
}

/** Classification per PRD §7.1. 0 red, 1 yellow, 2 green, 3 comm-only (hatch). */
export function classify(fSun: number, fEarth: number, thSun = 0.1, thEarth = 0.5): 0 | 1 | 2 | 3 {
  if (fSun >= thSun && fEarth >= thEarth) return 2;
  if (fSun >= thSun) return 1;
  if (fEarth >= thEarth) return 3;
  return 0;
}

export const CLASS_COLORS: Record<number, [number, number, number]> = {
  0: [1.0, 0.231, 0.302],  // #FF3B4D
  1: [1.0, 0.839, 0.039],  // #FFD60A
  2: [0.133, 1.0, 0.533],  // #22FF88
  3: [1.0, 0.231, 0.302],  // red + hatch in shader
};
