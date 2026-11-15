/**
 * Globe view math (PRD §3): selenographic ↔ Cartesian conversions, sphere
 * raycasting and coordinate formatting.
 *
 * Two Cartesian conventions appear here and they must not be confused:
 *
 *  1. **ME (Moon-fixed) frame** — the algebraic/HORIZONS frame used everywhere
 *     else in the project: `+Z` = north pole, `+X` toward the mean sub-Earth
 *     point (lat 0, lon 0), right-handed. See `frames.ts`.
 *
 *  2. **Render frame** — THREE.js is `+Y`-up, so the globe mesh stores its north
 *     pole along `+Y`. `latLonToGlobe` / `globeToLatLon` are the bridge between
 *     the two: the same sphere, spun 90° about X so the pole points up.
 *
 * All angles are radians. All distances are metres unless stated otherwise.
 */

import { R_MOON } from "./constants";
import { DEG2RAD, RAD2DEG, type Vec3, v3 } from "./frames";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// --------------------------------------------------------------- ME frame
/**
 * Selenographic (latRad, lonRad) → Moon-fixed Cartesian **ME** frame.
 *
 *   x = r·cosφ·cosλ      y = r·cosφ·sinλ      z = r·sinφ
 *
 * `r` defaults to the mean lunar radius, so the result is a point on the mean
 * sphere; add a height by passing `R_MOON + h`.
 */
export function latLonToME(latRad: number, lonRad: number, r: number = R_MOON): Vec3 {
  const cl = Math.cos(latRad);
  return v3(r * cl * Math.cos(lonRad), r * cl * Math.sin(lonRad), r * Math.sin(latRad));
}

/** Inverse of {@link latLonToME}. Returns the radius as well as the angles. */
export function meToLatLon(p: Vec3): { latRad: number; lonRad: number; radius: number } {
  const radius = Math.hypot(p.x, p.y, p.z) || 1;
  return {
    latRad: Math.asin(clamp(p.z / radius, -1, 1)),
    lonRad: Math.atan2(p.y, p.x),
    radius,
  };
}

// ------------------------------------------------------------ render frame
/**
 * ME-frame vector → render-frame vector. Both frames share the `+X` axis (the
 * lon-0 meridian) and differ only in which axis carries the pole: ME uses `+Z`,
 * the THREE.js globe uses `+Y`. So the mapping is a pure axis swap:
 *
 *   (x, y, z)_ME → (x, z, y)_render
 *
 * This is the bridge for feeding external ephemerides (e.g. `skyState().sunME`)
 * into globe lighting without re-deriving the IAU orientation.
 */
export function meToGlobe(p: Vec3): Vec3 {
  return v3(p.x, p.z, p.y);
}

/** Inverse of {@link meToGlobe}. */
export function globeToME(p: Vec3): Vec3 {
  return v3(p.x, p.z, p.y);
}

/**
 * Selenographic (latRad, lonRad) → **render frame** vector (Y = north pole),
 * which is what the THREE.js globe mesh uses.
 *
 *   x = r·cosφ·cosλ      y = r·sinφ      z = r·cosφ·sinλ
 *
 * Longitude 0 lies along `+X`, longitude +90° along `+Z`, and the north pole is
 * `+Y`. {@link meToGlobe} converts to and from the ME frame.
 */
export function latLonToGlobe(latRad: number, lonRad: number, r: number = R_MOON): Vec3 {
  const cl = Math.cos(latRad);
  return v3(r * cl * Math.cos(lonRad), r * Math.sin(latRad), r * cl * Math.sin(lonRad));
}

/** Inverse of {@link latLonToGlobe}: Cartesian (X, Y, Z) → selenographic lat/lon. */
export function globeToLatLon(p: Vec3): { latRad: number; lonRad: number; radius: number } {
  const radius = Math.hypot(p.x, p.y, p.z) || 1;
  return {
    latRad: Math.asin(clamp(p.y / radius, -1, 1)),
    lonRad: Math.atan2(p.z, p.x),
    radius,
  };
}

/** Normalise a longitude to (-180°, +180°]. */
export function wrapLonRad(lonRad: number): number {
  let l = ((lonRad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // The modulo above yields [-π, π); map the -π edge to +π so the range is (-π, π].
  if (l <= -Math.PI + 1e-12) l = Math.PI;
  return l;
}

// ------------------------------------------------------------- sphere rays
/**
 * Ray ∩ sphere of radius `r` centred on the origin.
 *
 * Solves |o + t·d|² = r², i.e. `a·t² + b·t + c = 0` with a = d·d, b = 2·o·d,
 * c = o·o − r². Returns the **nearest non-negative** root `t` (so a camera
 * inside the sphere still finds the surface in front of it), or `null` on a
 * miss. `d` need not be unit length.
 */
export function raySphereIntersect(o: Vec3, d: Vec3, r: number = R_MOON): number | null {
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  if (a < 1e-18) return null;
  const b = 2 * (o.x * d.x + o.y * d.y + o.z * d.z);
  const c = o.x * o.x + o.y * o.y + o.z * o.z - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}

/**
 * Surface-snapping raycast used to place/lock props onto the globe.
 *
 * A probe sits `standoffM` above the target coordinate and is aimed straight
 * **inward toward the sphere centre (0, 0, 0)**; the returned point is
 * `intersects[0]` expressed in the render frame, and `normal` is the surface
 * unit normal (radial out) the prop's local UP should be aligned to. Because the
 * ray is radial, the resolved coordinate is guaranteed to be the requested
 * lat/lon to numerical precision — the intersection is the snap, not a guess.
 */
export function snapToMoonSurface(
  latRad: number,
  lonRad: number,
  standoffM = 10_000,
  r: number = R_MOON,
): { point: Vec3; normal: Vec3; latRad: number; lonRad: number; distance: number } {
  const origin = latLonToGlobe(latRad, lonRad, r + Math.max(0, standoffM));
  const inv = -1 / (r + Math.max(0, standoffM));
  const dir = v3(origin.x * inv, origin.y * inv, origin.z * inv); // unit, toward centre
  const t = raySphereIntersect(origin, dir, r);
  const d = t ?? Math.max(0, standoffM);
  const point = v3(origin.x + dir.x * d, origin.y + dir.y * d, origin.z + dir.z * d);
  const len = Math.hypot(point.x, point.y, point.z) || 1;
  const ll = globeToLatLon(point);
  return { point, normal: v3(point.x / len, point.y / len, point.z / len), latRad: ll.latRad, lonRad: ll.lonRad, distance: d };
}

// --------------------------------------------------------------- distances
/** Great-circle (surface arc) distance [m] between two selenographic points. */
export function greatCircleDistance(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  r: number = R_MOON,
): number {
  const dLat = latB - latA;
  const dLon = lonB - lonA;
  // Haversine — numerically stable for the tiny separations a lunar traverse
  // involves, where the naive acos of a dot product loses precision.
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(clamp(Math.sqrt(h), -1, 1));
}

// ------------------------------------------------------------ formatting
/**
 * NASA/LRO display form for a selenographic coordinate pair, e.g.
 * `89.900° S | 0.000° E`. Latitude carries an explicit N/S hemisphere letter and
 * longitude an E/W one, matching the LRO/JPL product convention (longitude is
 * normalised to (-180°, +180°]).
 */
export function formatSelenographic(latRad: number, lonRad: number, digits = 3): string {
  const lat = latRad * RAD2DEG;
  const lon = wrapLonRad(lonRad) * RAD2DEG;
  const latHemi = lat < 0 ? "S" : "N";
  const lonHemi = lon < 0 ? "W" : "E";
  return `${Math.abs(lat).toFixed(digits)}° ${latHemi} | ${Math.abs(lon).toFixed(digits)}° ${lonHemi}`;
}

/** Degrees helper mirroring {@link formatSelenographic} for callers with degrees. */
export function formatSelenographicDeg(latDeg: number, lonDeg: number, digits = 3): string {
  return formatSelenographic(latDeg * DEG2RAD, lonDeg * DEG2RAD, digits);
}

/**
 * Lunar map-scale reference: the ground size of one degree of latitude at the
 * given latitude, and of one degree of longitude (which shrinks toward the
 * poles). Used by the minimap scale bar.
 */
export function degGroundMetres(latRad: number, r: number = R_MOON): { lat: number; lon: number } {
  return { lat: (Math.PI / 180) * r, lon: (Math.PI / 180) * r * Math.max(0, Math.cos(latRad)) };
}
