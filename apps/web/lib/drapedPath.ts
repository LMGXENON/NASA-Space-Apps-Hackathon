"use client";

/**
 * Terrain-conforming path adapter.
 *
 * The subdivision and grade maths live in `@helios/core` (`drapeSegment` /
 * `drapeRoute`); this module supplies the two things core cannot know: which
 * surface the viewport actually renders, and how grid metres map into scene space.
 *
 * Surface choice: the viewport's terrain is a `ShaderMaterial` whose displacement
 * runs in the vertex shader, so the CPU-side `BufferGeometry` a `THREE.Raycaster`
 * tests is still the flat plane (y = 0, normal +Y). A raycast would report every
 * hit at y = 0 and the rope would hang under the surface. `meshSurfaceHeight` is
 * the CPU mirror of the same displaced mesh — including PlaneGeometry's
 * two-triangle split per quad — so draped samples land on the surface the GPU
 * rasterises rather than on the full-resolution DEM (they differ by up to ~28 m on
 * the steepest rims).
 */

import { drapeRoute, drapeSegment, type DrapedPath, type DrapedPathOptions } from "@helios/core";
import { MESH_SEG, meshSurfaceHeight, type Heightfield } from "./sceneMath";

export {
  PATH_COLORS,
  PATH_COLOR_LABELS,
  SLOPE_LETHAL_DEG,
  SLOPE_SAFE_DEG,
  classifySlope,
} from "@helios/core";
export type { PathSample, SlopeClass } from "@helios/core";

export interface SceneDrapeOptions extends DrapedPathOptions {
  /** Terrain datum, i.e. `terrain.meta.height.min`. */
  hMin: number;
  /** Scene vertical exaggeration (must match the vertex shader). */
  exaggeration?: number;
  /** Scene-Y lift above the surface to avoid z-fighting [scene units]. */
  liftM?: number;
}

export interface SceneDrapedPath extends DrapedPath {
  /** Scene-space points: x = grid X, y = shaped height + lift, z = −grid Y. */
  points: [number, number, number][];
}

/**
 * Scene Y for a true ground height: the shaping the terrain vertex shader applies
 * to the plane (`TerrainMaterial.ts` — `vec3 p = vec3(position.x, (h - uHMin) *
 * uExaggeration, -position.y)`), plus the anti-z-fighting lift. Keep the two in step:
 * if the shader's shaping ever changes, every draped sample (and every surface pin)
 * must change with it.
 */
export function sceneYFromHeight(h: number, hMin: number, exaggeration: number, liftM: number): number {
  return (h - hMin) * exaggeration + liftM;
}

function toScene(path: DrapedPath, opts: SceneDrapeOptions): SceneDrapedPath {
  const ex = opts.exaggeration ?? 1;
  const lift = opts.liftM ?? 0.1;
  return {
    ...path,
    points: path.samples.map((s) => [s.x, sceneYFromHeight(s.h, opts.hMin, ex, lift), -s.y] as [number, number, number]),
  };
}

/** Draped, graded path for a single leg, in scene coordinates. */
export function generateDrapedPath(
  hf: Heightfield,
  a: { x: number; y: number },
  b: { x: number; y: number },
  opts: SceneDrapeOptions,
): SceneDrapedPath {
  const sample = (x: number, y: number) => meshSurfaceHeight(hf, x, y, MESH_SEG);
  return toScene(drapeSegment(a, b, sample, opts), opts);
}

/** Draped, graded ribbon for a whole route (site + waypoints), in scene coordinates. */
export function generateDrapedRoute(
  hf: Heightfield,
  start: { x: number; y: number },
  waypoints: { x: number; y: number }[],
  opts: SceneDrapeOptions,
): SceneDrapedPath {
  const sample = (x: number, y: number) => meshSurfaceHeight(hf, x, y, MESH_SEG);
  return toScene(drapeRoute(start, waypoints, sample, opts), opts);
}
