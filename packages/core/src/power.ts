/**
 * Rover power, battery and DTE link models (PRD Part B §8–9).
 * Pure, deterministic functions — no DOM, no Three.js.
 */

import { AU_KM, C_LIGHT, G_MOON, SOLAR_CONSTANT, BOLTZMANN_DB } from "./constants";

export type ArrayMode = "horizontal" | "vertical-fixed" | "vertical-tracking";

export interface RoverLoads {
  idleW: number;
  commW: number;
  driveBaseW: number;
  heaterShadowW: number;
}

export interface RoverProfile {
  name: string;
  batteryWh: number;
  socMinOperating: number;
  chargeEff: number;
  dischargeEff: number;
  arrayAreaM2: number;
  arrayEff: number;
  dustFactor: number;
  arrayMode: ArrayMode;
  mastHeightM: number;
  loads: RoverLoads;
  speedMps: number;
  maxSlopeDeg: number;
  massKg: number;
  antenna: { band: "S" | "X" | "Ka"; txPowerW: number; gainDbi: number; pointingLossDb: number };
}

export const DEFAULT_ROVER_PROFILE: RoverProfile = {
  name: "Helios-1",
  batteryWh: 8000,
  socMinOperating: 0.15,
  chargeEff: 0.95,
  dischargeEff: 0.97,
  arrayAreaM2: 2.5,
  arrayEff: 0.28,
  dustFactor: 0.92,
  arrayMode: "vertical-tracking",
  mastHeightM: 2,
  loads: { idleW: 120, commW: 40, driveBaseW: 450, heaterShadowW: 230 },
  speedMps: 1.0,
  maxSlopeDeg: 20,
  massKg: 300,
  antenna: { band: "X", txPowerW: 20, gainDbi: 30, pointingLossDb: 1 },
};

/** Solar irradiance at the Moon's distance [W/m²]. */
export function solarIrradiance(sunDistAU: number): number {
  return SOLAR_CONSTANT / (sunDistAU * sunDistAU);
}

/** cos(incidence) on the array for the given mode (§8.2). */
export function arrayCosIncidence(mode: ArrayMode, elRad: number, azRad: number, headingRad: number): number {
  switch (mode) {
    case "horizontal":
      return Math.max(0, Math.sin(elRad));
    case "vertical-fixed":
      return Math.max(0, Math.cos(elRad) * Math.cos(azRad - headingRad));
    case "vertical-tracking":
      return Math.max(0, Math.cos(elRad));
  }
}

export interface SolarInput {
  sunDistAU: number;
  sunEl: number;
  sunAz: number;
  fSun: number;
  heading: number;
}

/** Array output power [W] (§8.2). */
export function solarPower(profile: RoverProfile, inp: SolarInput): number {
  const G = solarIrradiance(inp.sunDistAU);
  const cosInc = arrayCosIncidence(profile.arrayMode, inp.sunEl, inp.sunAz, inp.heading);
  return G * profile.arrayAreaM2 * profile.arrayEff * profile.dustFactor * cosInc * inp.fSun;
}

export interface LoadInput {
  linkOn: boolean;
  moving: boolean;
  slopeRad: number;
  fSun: number;
  thetaSunMin: number;
  speedMps: number;
}

/** Total electrical load [W] (§8.3). */
export function loadPower(profile: RoverProfile, inp: LoadInput): number {
  const l = profile.loads;
  let p = l.idleW + (inp.linkOn ? l.commW : 0);
  if (inp.moving) {
    const v = inp.speedMps;
    p += l.driveBaseW + profile.massKg * G_MOON * v * Math.max(0, Math.sin(inp.slopeRad));
  }
  if (inp.fSun < inp.thetaSunMin) p += l.heaterShadowW;
  return p;
}

/** Integrate one battery step [dt seconds]; returns energy [Wh] (§8.3). */
export function batteryStep(energyWh: number, pNetW: number, dtSec: number, profile: RoverProfile): number {
  const dWh = (pNetW >= 0 ? pNetW * profile.chargeEff : pNetW / profile.dischargeEff) * (dtSec / 3600);
  return Math.min(profile.batteryWh, Math.max(0, energyWh + dWh));
}

// ---------------------------------------------------------------------------
// DTE link budget (§9)
// ---------------------------------------------------------------------------

export const BAND_FREQ_HZ: Record<RoverProfile["antenna"]["band"], number> = {
  S: 2.2e9,
  X: 8.4e9,
  Ka: 26e9,
};

/** Free-space path loss [dB] for distance d [m] and carrier f [Hz] (§9). */
export function fsplDb(dMeters: number, fHz: number): number {
  return 20 * Math.log10((4 * Math.PI * dMeters * fHz) / C_LIGHT);
}

export interface LinkInput {
  earthDistKm: number;
  fEarth: number; // Earth visibility fraction 0..1
  band: RoverProfile["antenna"]["band"];
  txPowerW: number;
  txGainDbi: number;
  pointingLossDb: number;
  rxGainDbi?: number;
  tSysK?: number;
  dataRateBps?: number;
  ebNoReqDb?: number;
}

export interface LinkResult {
  fsplDb: number;
  prDbw: number;
  cn0DbHz: number;
  marginDb: number;
  blocked: boolean;
}

/** DTE link margin (default) for the given geometry (§9). */
export function linkBudget(inp: LinkInput): LinkResult {
  const f = BAND_FREQ_HZ[inp.band];
  const d = inp.earthDistKm * 1000;
  const F = fsplDb(d, f);
  const rxGain = inp.rxGainDbi ?? 68; // DSN 34 m
  const tSys = inp.tSysK ?? 25;
  const rate = inp.dataRateBps ?? 1e6;
  const ebNoReq = inp.ebNoReqDb ?? 2.5;
  const epsilon = 0.01;
  const blocked = inp.fEarth < epsilon;
  const lDiff = blocked ? 60 : inp.fEarth < 1 ? -10 * Math.log10(Math.max(inp.fEarth, epsilon)) : 0;
  const eirp = 10 * Math.log10(inp.txPowerW) + inp.txGainDbi;
  const pr = eirp + rxGain - F - inp.pointingLossDb - lDiff;
  const cn0 = pr - (BOLTZMANN_DB + 10 * Math.log10(tSys));
  const margin = cn0 - 10 * Math.log10(rate) - ebNoReq;
  return { fsplDb: F, prDbw: pr, cn0DbHz: cn0, marginDb: blocked ? -60 : margin, blocked };
}
