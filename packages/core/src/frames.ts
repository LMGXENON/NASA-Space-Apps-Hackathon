/**
 * Moon-fixed (ME) frame helpers and polar-stereographic grid math.
 * Frames per PRD Part B §3.1–3.3.
 * ME: +Z = north pole, +X toward mean sub-Earth point (lat 0, lon 0).
 */

import { R_MOON } from "./constants";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / norm(a));

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Local East/North/Up basis at selenographic (lat, lon) in the ME frame (§3.3). */
export function localFrame(latRad: number, lonRad: number): { east: Vec3; north: Vec3; up: Vec3 } {
  const cl = Math.cos(latRad);
  const sl = Math.sin(latRad);
  const co = Math.cos(lonRad);
  const so = Math.sin(lonRad);
  return {
    up: v3(cl * co, cl * so, sl),
    east: v3(-so, co, 0),
    north: v3(-sl * co, -sl * so, cl),
  };
}

/** Azimuth [rad, from north, clockwise] and elevation [rad] of unit vector s in a local frame. */
export function azEl(s: Vec3, f: { east: Vec3; north: Vec3; up: Vec3 }): { az: number; el: number } {
  return {
    az: Math.atan2(dot(s, f.east), dot(s, f.north)),
    el: Math.asin(dot(s, f.up)),
  };
}

/** Selenographic (latRad, lonRad) of a south polar stereographic grid point (x, y) in meters.
 *  South-pole convention (Snyder): φ = −90° + 2·atan(ρ/2R), λ = atan2(x, y).
 *
 *  At the projection origin (ρ = 0) longitude is undefined, so it is pinned to
 *  the central meridian. Relying on atan2 alone there returned +180° whenever the
 *  caller passed a signed negative zero for y (atan2(0, −0) = π), which made the
 *  AOI centre report the far side of the Moon. */
export function gridToLatLon(x: number, y: number): { latRad: number; lonRad: number } {
  const rho = Math.hypot(x, y);
  const c = 2 * Math.atan(rho / (2 * R_MOON));
  return { latRad: -Math.PI / 2 + c, lonRad: rho === 0 ? 0 : Math.atan2(x, y) };
}

/** Inverse of gridToLatLon. */
export function latLonToGrid(latRad: number, lonRad: number): { x: number; y: number } {
  const c = latRad + Math.PI / 2;
  const rho = 2 * R_MOON * Math.tan(c / 2);
  return { x: rho * Math.sin(lonRad), y: rho * Math.cos(lonRad) };
}

/** Elevation angle of a target seen by an observer, curvature-corrected (PRD §3.4).
 *  d: ground arc distance [m]; hObs/hTgt: heights above the sphere [m]. */
export function curvatureElevation(d: number, hObs: number, hTgt: number, R = R_MOON): number {
  const alpha = d / R;
  return Math.atan2(
    (R + hTgt) * Math.cos(alpha) - (R + hObs),
    (R + hTgt) * Math.sin(alpha),
  );
}

/** Horizontal ground distance from the observer at (x0,y0) to a point at azimuth az [rad, grid frame]. */
export function gridOffset(x0: number, y0: number, azRad: number, d: number): { x: number; y: number } {
  // Grid az convention: az measured from grid +Y (north) toward +X (east) — matches atan2(x, y) lon.
  return { x: x0 + d * Math.sin(azRad), y: y0 + d * Math.cos(azRad) };
}
