/**
 * Sun & Earth state in the Moon-fixed (ME) frame via astronomy-engine (PRD Part B §3.2).
 * Ground truth for tests: JPL Horizons fixtures (§13.1).
 */

import * as A from "astronomy-engine";
import { AU_KM, R_EARTH } from "./constants";
import { type Vec3, type azEl, localFrame } from "./frames";

export interface SkyState {
  /** Unit vector toward the Sun in the ME frame */
  sunME: Vec3;
  /** Unit vector toward the Earth in the ME frame */
  earthME: Vec3;
  /** Sun distance from the Moon [AU] */
  sunDistAU: number;
  /** Earth distance from the Moon [km] */
  earthDistKm: number;
  /** Sun angular radius [rad] */
  sunAngRadius: number;
  /** Earth angular radius [rad] */
  earthAngRadius: number;
  /** Lunar phase angle in degrees [0, 360): 0 = New, 90 = 1st Qtr, 180 = Full, 270 = 3rd Qtr */
  phaseAngleDeg?: number;
  /** Lunar illuminated fraction [0, 1] */
  illumFraction?: number;
  /** Sub-Earth point coordinates (optical libration) in selenographic degrees */
  libration?: { latDeg: number; lonDeg: number };
}

export interface LunarOrbitPoint {
  date: Date;
  xKm: number;
  yKm: number;
  zKm: number;
  distKm: number;
  elonDeg: number;
  elatDeg: number;
}

export interface LunarSystemState {
  date: Date;
  distKm: number;
  elonDeg: number;
  elatDeg: number;
  moonPosEclipticKm: Vec3;
  moonPosEqjKm: Vec3;
  phaseAngleDeg: number;
  illumFraction: number;
  phaseName: string;
  libration: { latDeg: number; lonDeg: number };
  orbitalSpeedKmS: number;
  siderealPeriodDays: number;
  synodicPeriodDays: number;
}

interface AxisInfo {
  ra: number; // hours
  dec: number; // degrees
  spin: number; // degrees (W)
  north: { x: number; y: number; z: number };
}

/**
 * IAU lunar orientation matrix: rotates EQJ vectors into the ME frame.
 * Uses the pole vector from RotationAxis directly when available (more accurate
 * than ra/dec re-derivation), then R3(W) about the pole.
 */
function meMatrix(axis: AxisInfo, date: Date): (v: Vec3) => Vec3 {
  // Pole in EQJ:
  const p = { x: axis.north.x, y: axis.north.y, z: axis.north.z } as Vec3;
  // Build an orthonormal triad (X0, Y0) perpendicular to the pole:
  let x0: Vec3;
  if (Math.abs(p.z) < 0.9) {
    x0 = { x: 0, y: 0, z: 1 };
  } else {
    x0 = { x: 1, y: 0, z: 0 };
  }
  // y0 = p × x0, x0 = y0 × p
  const y0 = {
    x: p.y * x0.z - p.z * x0.y,
    y: p.z * x0.x - p.x * x0.z,
    z: p.x * x0.y - p.y * x0.x,
  };
  const x0b = {
    x: y0.y * p.z - y0.z * p.y,
    y: y0.z * p.x - y0.x * p.z,
    z: y0.x * p.y - y0.y * p.x,
  };
  const nx = Math.hypot(x0b.x, x0b.y, x0b.z);
  const ny = Math.hypot(y0.x, y0.y, y0.z);
  const X = { x: x0b.x / nx, y: x0b.y / nx, z: x0b.z / nx };
  const Y = { x: y0.x / ny, y: y0.y / ny, z: y0.z / ny };

  // EQJ → pole-aligned frame:
  const pa = (v: Vec3) => ({ x: dotProd(v, X), y: dotProd(v, Y), z: dotProd(v, p) });

  // R3(W): spin about the pole by the IAU rotation angle W = spin (degrees, from the ME X axis).
  const w = axis.spin * (Math.PI / 180);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  return (v: Vec3): Vec3 => {
    const a = pa(v);
    return {
      x: a.x * cw + a.y * sw,
      y: -a.x * sw + a.y * cw,
      z: a.z,
    };
  };
}

function dotProd(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * EQJ (ICRF/J2000) → ME-frame rotation at `date`, for ingesting external
 * vector ephemerides (e.g. JPL HORIZONS ICRF state vectors) into the frame the
 * rest of the system works in. Reuses the same IAU lunar orientation model as
 * `skyState`.
 */
export function eqjToMe(date: Date): (v: Vec3) => Vec3 {
  const axis = A.RotationAxis(A.Body.Moon, date) as unknown as AxisInfo;
  return meMatrix(axis, date);
}

/** Compute the Sun/Earth state as seen from the Moon at UTC date. */
export function skyState(date: Date): SkyState {
  const sun = A.GeoVector(A.Body.Sun, date, false);
  const moon = A.GeoVector(A.Body.Moon, date, false);

  // Vectors from the Moon toward Sun/Earth (EQJ, AU):
  const sFromMoon = { x: sun.x - moon.x, y: sun.y - moon.y, z: sun.z - moon.z };
  const eFromMoon = { x: -moon.x, y: -moon.y, z: -moon.z };

  const axis = A.RotationAxis(A.Body.Moon, date) as unknown as AxisInfo;
  const R = meMatrix(axis, date);

  const sunME = R(sFromMoon);
  const earthME = R(eFromMoon);

  const sunDistAU = Math.hypot(sFromMoon.x, sFromMoon.y, sFromMoon.z);
  const earthDistKm = Math.hypot(eFromMoon.x, eFromMoon.y, eFromMoon.z) * AU_KM;
  const sunAngRadius = Math.asin(695_700 / (sunDistAU * AU_KM));
  const earthAngRadius = Math.asin((R_EARTH / 1000) * 1.02 / earthDistKm);

  // Normalize directions:
  const nSun = Math.hypot(sunME.x, sunME.y, sunME.z);
  const nEarth = Math.hypot(earthME.x, earthME.y, earthME.z);
  const uEarth = { x: earthME.x / nEarth, y: earthME.y / nEarth, z: earthME.z / nEarth };
  const uSun = { x: sunME.x / nSun, y: sunME.y / nSun, z: sunME.z / nSun };

  const phaseAngleDeg = A.MoonPhase(date);
  const illum = A.Illumination(A.Body.Moon, date);
  const libration = {
    latDeg: Math.asin(uEarth.z) * (180 / Math.PI),
    lonDeg: Math.atan2(uEarth.y, uEarth.x) * (180 / Math.PI),
  };

  return {
    sunME: uSun,
    earthME: uEarth,
    sunDistAU,
    earthDistKm,
    sunAngRadius,
    earthAngRadius,
    phaseAngleDeg,
    illumFraction: illum.phase_fraction,
    libration,
  };
}

export function getLunarPhaseName(phaseDeg: number): string {
  const norm = ((phaseDeg % 360) + 360) % 360;
  if (norm < 15 || norm >= 345) return "New Moon";
  if (norm < 75) return "Waxing Crescent";
  if (norm < 105) return "First Quarter";
  if (norm < 165) return "Waxing Gibbous";
  if (norm < 195) return "Full Moon";
  if (norm < 255) return "Waning Gibbous";
  if (norm < 285) return "Third Quarter";
  return "Waning Crescent";
}

/**
 * Returns comprehensive astronomical state of the Moon-Earth orbital system at UTC date.
 * Explains 1:1 tidal lock, orbital revolution around Earth (27.32d sidereal), and phases (29.53d synodic).
 */
export function lunarSystemState(date: Date): LunarSystemState {
  const moon = A.GeoVector(A.Body.Moon, date, false);
  const ec = A.Ecliptic(moon);
  const distKm = ec.vec.Length() * AU_KM;
  const phaseAngleDeg = A.MoonPhase(date);
  const illum = A.Illumination(A.Body.Moon, date);
  const phaseName = getLunarPhaseName(phaseAngleDeg);

  // Selenographic sub-Earth coordinates (optical libration):
  const sky = skyState(date);
  const libration = sky.libration ?? {
    latDeg: Math.asin(sky.earthME.z) * (180 / Math.PI),
    lonDeg: Math.atan2(sky.earthME.y, sky.earthME.x) * (180 / Math.PI),
  };

  // Vis-viva approximation for instantaneous orbital velocity around Earth:
  // GM_Earth = 398600.4418 km^3/s^2, a_Moon ≈ 384400 km
  const GM_EARTH = 398600.4418;
  const a = 384400;
  const orbitalSpeedKmS = Math.sqrt(GM_EARTH * (2 / distKm - 1 / a));

  return {
    date,
    distKm,
    elonDeg: ec.elon,
    elatDeg: ec.elat,
    moonPosEclipticKm: {
      x: ec.vec.x * AU_KM,
      y: ec.vec.y * AU_KM,
      z: ec.vec.z * AU_KM,
    },
    moonPosEqjKm: {
      x: moon.x * AU_KM,
      y: moon.y * AU_KM,
      z: moon.z * AU_KM,
    },
    phaseAngleDeg,
    illumFraction: illum.phase_fraction,
    phaseName,
    libration,
    orbitalSpeedKmS,
    siderealPeriodDays: 27.32166,
    synodicPeriodDays: 29.53059,
  };
}

/**
 * Computes sampled points along the Moon's 27.32-day elliptical orbit around Earth,
 * showing the true 5.14° inclined trajectory in Ecliptic space.
 */
export function computeLunarOrbitPath(centerDate: Date, samples = 120): LunarOrbitPoint[] {
  const siderealMs = 27.32166 * 86400 * 1000;
  const t0 = centerDate.getTime() - siderealMs / 2;
  const pts: LunarOrbitPoint[] = [];

  for (let i = 0; i < samples; i++) {
    const t = new Date(t0 + (i / (samples - 1)) * siderealMs);
    const moon = A.GeoVector(A.Body.Moon, t, false);
    const ec = A.Ecliptic(moon);
    const distKm = ec.vec.Length() * AU_KM;
    pts.push({
      date: t,
      xKm: ec.vec.x * AU_KM,
      yKm: ec.vec.y * AU_KM,
      zKm: ec.vec.z * AU_KM,
      distKm,
      elonDeg: ec.elon,
      elatDeg: ec.elat,
    });
  }

  return pts;
}

/** Local azimuth/elevation [rad] of the Sun and Earth at a selenographic site. */
export function skyAzEl(
  sky: SkyState,
  latRad: number,
  lonRad: number,
): { sun: ReturnType<typeof azEl>; earth: ReturnType<typeof azEl> } {
  const f = localFrame(latRad, lonRad);
  const proj = (s: Vec3) => ({
    az: Math.atan2(
      s.x * f.east.x + s.y * f.east.y + s.z * f.east.z,
      s.x * f.north.x + s.y * f.north.y + s.z * f.north.z,
    ),
    el: Math.asin(s.x * f.up.x + s.y * f.up.y + s.z * f.up.z),
  });
  return { sun: proj(sky.sunME), earth: proj(sky.earthME) };
}
