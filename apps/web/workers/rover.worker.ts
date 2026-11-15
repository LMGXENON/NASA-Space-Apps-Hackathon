/**
 * Rover Agent (PRD Part D AG-3): battery/power/link sim, survival ribbon,
 * duty-cycle computation, exact ray hits. Latest-wins ids; deterministic.
 * Message protocol: {id, fn, payload} -> {id, ok, result|error}.
 */

import {
  discVisible,
  eclipseOcclusion,
  ephemerisAgreement,
  gridToLatLon,
  linkBudget,
  loadPower,
  polarSkyExtremes,
  skyAzEl,
  skyState,
  solarPower,
  type RoverProfile,
  type SkyState,
} from "@helios/core";
import { horizonAngleBin, pathPositionAt, segmentSlopeRad, type Heightfield } from "../lib/sceneMath";

const S: { hf: Heightfield | null; horizon: ArrayBuffer | null; nAz: number; hPx: number } = {
  hf: null,
  horizon: null,
  nAz: 64,
  hPx: 512,
};

export function loadTerrain(req: {
  hf: Heightfield;
  horizon: ArrayBuffer;
  nAz: number;
  hPx: number;
}): void {
  S.hf = req.hf;
  S.horizon = req.horizon;
  S.nAz = req.nAz;
  S.hPx = req.hPx;
}

function sampleH(x: number, y: number): number {
  if (!S.hf) return 0;
  const { px, texelM, bounds, heights } = S.hf;
  const fx = (x - bounds[0]) / texelM - 0.5;
  const fy = (y - bounds[1]) / texelM - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 >= px - 1 || y0 >= px - 1) {
    const cx = Math.min(px - 1, Math.max(0, Math.round(fx)));
    const cy = Math.min(px - 1, Math.max(0, Math.round(fy)));
    return heights[cy * px + cx] ?? 0;
  }
  const tx = fx - x0, ty = fy - y0;
  const i00 = y0 * px + x0;
  const h = heights;
  return (
    h[i00]! * (1 - tx) * (1 - ty) + h[i00 + 1]! * tx * (1 - ty) +
    h[i00 + px]! * (1 - tx) * ty + h[i00 + px + 1]! * tx * ty
  );
}

// --------------------------------------------------- cached sky state (AG-1)
const SKY_DT = 30 * 60 * 1000; // 30-min grid; lerp error < 0.01°
const skyCache = new Map<number, SkyState>();

function skyCached(tMs: number): SkyState {
  const k0 = Math.floor(tMs / SKY_DT) * SKY_DT;
  let a = skyCache.get(k0);
  if (!a) {
    a = skyState(new Date(k0));
    if (skyCache.size > 4000) skyCache.clear();
    skyCache.set(k0, a);
  }
  const frac = (tMs - k0) / SKY_DT;
  if (frac < 1e-6) return a;
  const b = skyCache.get(k0 + SKY_DT) ?? skyState(new Date(k0 + SKY_DT));
  skyCache.set(k0 + SKY_DT, b);
  const lerp = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => {
    const x = p.x + (q.x - p.x) * frac, y = p.y + (q.y - p.y) * frac, z = p.z + (q.z - p.z) * frac;
    const n = Math.hypot(x, y, z);
    return { x: x / n, y: y / n, z: z / n };
  };
  const li = (u: number, v: number) => u + (v - u) * frac;
  return {
    sunME: lerp(a.sunME, b.sunME),
    earthME: lerp(a.earthME, b.earthME),
    sunDistAU: li(a.sunDistAU, b.sunDistAU),
    earthDistKm: li(a.earthDistKm, b.earthDistKm),
    sunAngRadius: li(a.sunAngRadius, b.sunAngRadius),
    earthAngRadius: li(a.earthAngRadius, b.earthAngRadius),
  };
}

/** Sun/Earth visibility fractions at a grid point (mirrors the GPU path, §7.2/§7.4). */
function fractionsAt(
  x: number,
  y: number,
  hObs: number,
  sky: SkyState,
): { fSun: number; fEarth: number; sunEl: number; sunAz: number; earthEl: number; earthAz: number } {
  const { latRad, lonRad } = gridToLatLon(x, y);
  const { sun, earth } = skyAzEl(sky, latRad, lonRad);
  const hSun = horizonAngleBin(S.horizon!, S.hPx, S.nAz, x, y, sun.az, S.hf!.bounds);
  const hEarth = horizonAngleBin(S.horizon!, S.hPx, S.nAz, x, y, earth.az, S.hf!.bounds);
  const fSunT = discVisible(sun.el, hSun, sky.sunAngRadius);
  const fEarthT = discVisible(earth.el, hEarth, sky.earthAngRadius);
  const a = sky.sunME, b = sky.earthME;
  const sep = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));
  const occ = eclipseOcclusion(sep, sky.sunAngRadius, sky.earthAngRadius);
  return {
    fSun: Math.max(0, fSunT * (1 - occ)),
    fEarth: fEarthT,
    sunEl: sun.el, sunAz: sun.az, earthEl: earth.el, earthAz: earth.az,
  };
}

// --------------------------------------------------------------- simulate
export interface SimRequest {
  profile: RoverProfile;
  path: { x: number; y: number }[];
  site: { x: number; y: number };
  /** Mission epoch the drive starts from (FR-B4); defaults to t0. */
  departTMs?: number;
  t0: number;
  t1: number;
  dtSec: number;
  e0Wh: number;
}

export interface SimResult {
  t0: number; dtSec: number; n: number;
  soc: Float32Array; pSolar: Float32Array; pLoad: Float32Array;
  linkMarginDb: Float32Array; fSun: Float32Array; fEarth: Float32Array;
  cls: Uint8Array;
  events: { t: number; kind: string; msg: string }[];
  timeToDeadH: number | null;
}

export function simulate(req: SimRequest): SimResult {
  const p = req.profile;
  const n = Math.max(1, Math.floor((req.t1 - req.t0) / (req.dtSec * 1000)));
  const soc = new Float32Array(n), pSolar = new Float32Array(n), pLoad = new Float32Array(n);
  const linkMargin = new Float32Array(n), fSunA = new Float32Array(n), fEarthA = new Float32Array(n);
  const cls = new Uint8Array(n);
  const events: { t: number; kind: string; msg: string }[] = [];

  const wpts = [{ x: req.site.x, y: req.site.y }, ...req.path];
  const segLen: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < wpts.length; i++) {
    const L = Math.hypot(wpts[i]!.x - wpts[i - 1]!.x, wpts[i]!.y - wpts[i - 1]!.y);
    segLen.push(L);
    totalLen += L;
  }
  const speed = p.speedMps;
  let E = req.e0Wh;
  let prevCls = -1;
  // FR-B5: time-to-dead tracking.
  let deadIdx = -1;
  let netDischargeWh = 0; // accumulated discharge over the window
  let dischargeSamples = 0;
  let prevSlopeViolation = false;
  const SLOPE_LIMIT_RAD = (20 * Math.PI) / 180;

  for (let i = 0; i < n; i++) {
    const tMs = req.t0 + i * req.dtSec * 1000;
    const sky = skyCached(tMs);

    // Shared with the 3D view (FR-B4) so the animated rover matches the sim.
    const depart = req.departTMs ?? req.t0;
    const isPreDepart = tMs < depart;

    // Before departure, rover is on the lander power bus, keeping initial flight SOC.
    if (isPreDepart) {
      E = req.e0Wh;
    }

    // Zero-Battery Interlock: If battery drops to <=15% SOC, wheel drives lock (rover cannot move)
    const isActuatorLocked = !isPreDepart && (E / p.batteryWh) <= (p.socMinOperating ?? 0.15);
    const pos = pathPositionAt(req.site, req.path, speed, (tMs - depart) / 1000);
    const x = pos.x, y = pos.y, moving = pos.moving && !isActuatorLocked;
    let slope = 0;
    if (moving && totalLen > 0) {
      // Slope of whichever segment is being driven right now.
      let acc = 0;
      const sTrav = Math.min(totalLen, speed * ((tMs - depart) / 1000));
      for (let k = 0; k < segLen.length; k++) {
        const L = segLen[k]!;
        if (sTrav <= acc + L || k === segLen.length - 1) {
          const a = wpts[k]!, b = wpts[k + 1]!;
          slope = segmentSlopeRad(a, b, sampleH(a.x, a.y), sampleH(b.x, b.y));
          break;
        }
        acc += L;
      }
    }
    const hObs = sampleH(x, y) + p.mastHeightM;
    const fr = fractionsAt(x, y, hObs, sky);

    const heading = moving ? Math.atan2(wpts[wpts.length - 1]!.x - x, wpts[wpts.length - 1]!.y - y) : 0;
    const link = linkBudget({
      earthDistKm: sky.earthDistKm, fEarth: fr.fEarth, band: p.antenna.band,
      txPowerW: p.antenna.txPowerW, txGainDbi: p.antenna.gainDbi, pointingLossDb: p.antenna.pointingLossDb,
    });
    const ps = solarPower(p, { sunDistAU: sky.sunDistAU, sunEl: fr.sunEl, sunAz: fr.sunAz, fSun: fr.fSun, heading });
    const pl = loadPower(p, { linkOn: true, moving, slopeRad: slope, fSun: fr.fSun, thetaSunMin: 0.1, speedMps: speed });
    const pNet = ps - pl;
    if (pNet < 0) {
      netDischargeWh += -pNet * (req.dtSec / 3600);
      dischargeSamples++;
    }

    if (!isPreDepart) {
      // In darkness, thermal heaters and standby systems actively drain the battery down to 0 Wh
      E = Math.min(
        p.batteryWh,
        Math.max(0, E + (pNet >= 0 ? pNet * p.chargeEff : pNet / p.dischargeEff) * (req.dtSec / 3600)),
      );
    }

    soc[i] = E / p.batteryWh;
    pSolar[i] = ps; pLoad[i] = pl; linkMargin[i] = link.marginDb;
    fSunA[i] = fr.fSun; fEarthA[i] = fr.fEarth;
    cls[i] = fr.fSun >= 0.1 && fr.fEarth >= 0.5 ? 2 : fr.fSun >= 0.1 ? 1 : fr.fEarth >= 0.5 ? 3 : 0;

    const c = cls[i]!;
    if (prevCls >= 0 && c !== prevCls) {
      const names = ["solar lost — comm only", "solar lost (dark)", "sunrise / comm acq", "GREEN window opens"];
      events.push({ t: tMs, kind: "class", msg: names[c]! });
    }
    prevCls = c;
    if (soc[i]! < 0.15 && (i === 0 || soc[i - 1]! >= 0.15))
      events.push({ t: tMs, kind: "alert", msg: "SOC critical (<15%)" });
    else if (soc[i]! < 0.3 && (i === 0 || soc[i - 1]! >= 0.3))
      events.push({ t: tMs, kind: "alert", msg: "SOC warning (<30%)" });
    if (soc[i]! <= 0 && deadIdx < 0) {
      deadIdx = i;
      events.push({ t: tMs, kind: "alert", msg: "Battery depleted — time-to-dead reached" });
    }

    // FR-B4: flag slope-limit violations as the rover drives.
    const slopeViolation = moving && slope > SLOPE_LIMIT_RAD;
    if (slopeViolation && !prevSlopeViolation) {
      events.push({ t: tMs, kind: "alert", msg: `Slope limit exceeded (${((slope * 180) / Math.PI).toFixed(0)}° > 20°)` });
    }
    prevSlopeViolation = slopeViolation;
  }

  // FR-B5: hours from the window start until the battery is empty.
  let timeToDeadH: number | null = null;
  if (deadIdx >= 0) {
    timeToDeadH = (deadIdx * req.dtSec) / 3600;
  } else if (dischargeSamples > 0 && netDischargeWh > 0) {
    // Extrapolate from the mean discharge rate across the simulated window.
    const meanDischargeW = netDischargeWh / ((n * req.dtSec) / 3600);
    if (meanDischargeW > 1e-6) {
      const hoursLeft = E / meanDischargeW;
      if (hoursLeft < 24 * 365) timeToDeadH = ((n * req.dtSec) / 3600) + hoursLeft;
    }
  }

  return { t0: req.t0, dtSec: req.dtSec, n, soc, pSolar, pLoad, linkMarginDb: linkMargin, fSun: fSunA, fEarth: fEarthA, cls, events, timeToDeadH };
}

// ---------------------------------------------------------------- ribbon
export interface RibbonRequest { x: number; y: number; hObsM: number; t0: number; t1: number; dtSec: number; }

export function ribbon(req: RibbonRequest): { classes: Uint8Array; dtSec: number; t0: number } {
  const n = Math.max(1, Math.floor((req.t1 - req.t0) / (req.dtSec * 1000)));
  const classes = new Uint8Array(n);
  const hObs = sampleH(req.x, req.y) + req.hObsM;
  for (let i = 0; i < n; i++) {
    const fr = fractionsAt(req.x, req.y, hObs, skyCached(req.t0 + i * req.dtSec * 1000));
    classes[i] = fr.fSun >= 0.1 && fr.fEarth >= 0.5 ? 2 : fr.fSun >= 0.1 ? 1 : fr.fEarth >= 0.5 ? 3 : 0;
  }
  return { classes, dtSec: req.dtSec, t0: req.t0 };
}

// --------------------------------------------------------------- duty map
export interface DutyMapRequest { gridN: number; t0: number; t1: number; dtSec: number; }

/** Duty-cycle over the AOI on a coarse grid. Returns Float32 [g, s, e] per texel. */
export function dutyMap(req: DutyMapRequest): { w: number; data: Float32Array } {
  const wN = req.gridN;
  const step = (2 * 20_000) / wN;
  const texels: { x: number; y: number; hObs: number; up: [number, number, number]; east: [number, number, number]; north: [number, number, number] }[] = [];
  const cl = Math.cos, sl = Math.sin;
  for (let iy = 0; iy < wN; iy++) {
    for (let ix = 0; ix < wN; ix++) {
      const x = -20_000 + (ix + 0.5) * step;
      const y = -20_000 + (iy + 0.5) * step;
      const { latRad, lonRad } = gridToLatLon(x, y);
      const phi = latRad, lam = lonRad;
      const cphi = cl(phi), sphi = sl(phi), clam = cl(lam), slam = sl(lam);
      texels.push({
        x, y, hObs: sampleH(x, y) + 2,
        up: [cphi * clam, cphi * slam, sphi],
        east: [-slam, clam, 0],
        north: [-sphi * clam, -sphi * slam, cphi],
      });
    }
  }
  const nT = texels.length;
  const g = new Float32Array(nT), sArr = new Float32Array(nT), eArr = new Float32Array(nT);
  const nT_samples = Math.max(1, Math.floor((req.t1 - req.t0) / (req.dtSec * 1000)));
  for (let i = 0; i < nT_samples; i++) {
    const sky = skyCached(req.t0 + i * req.dtSec * 1000);
    const a = sky.sunME, b = sky.earthME;
    const sep = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));
    const occ = eclipseOcclusion(sep, sky.sunAngRadius, sky.earthAngRadius);
    for (let t = 0; t < nT; t++) {
      const T = texels[t]!;
      const su = a.x * T.up[0]! + a.y * T.up[1]! + a.z * T.up[2]!;
      const se = a.x * T.east[0]! + a.y * T.east[1]! + a.z * T.east[2]!;
      const sn = a.x * T.north[0]! + a.y * T.north[1]! + a.z * T.north[2]!;
      const sunEl = Math.asin(Math.min(1, Math.max(-1, su)));
      const sunAz = Math.atan2(se, sn);
      const eu = b.x * T.up[0]! + b.y * T.up[1]! + b.z * T.up[2]!;
      const ee = b.x * T.east[0]! + b.y * T.east[1]! + b.z * T.east[2]!;
      const en = b.x * T.north[0]! + b.y * T.north[1]! + b.z * T.north[2]!;
      const earthEl = Math.asin(Math.min(1, Math.max(-1, eu)));
      const earthAz = Math.atan2(ee, en);
      const hSun = horizonAngleBin(S.horizon!, S.hPx, S.nAz, T.x, T.y, sunAz, S.hf!.bounds);
      const hEarth = horizonAngleBin(S.horizon!, S.hPx, S.nAz, T.x, T.y, earthAz, S.hf!.bounds);
      const fS = Math.max(0, discVisible(sunEl, hSun, sky.sunAngRadius) * (1 - occ));
      const fE = discVisible(earthEl, hEarth, sky.earthAngRadius);
      if (fS >= 0.1 && fE >= 0.5) g[t]!++;
      if (fS >= 0.1) sArr[t]!++;
      if (fE >= 0.5) eArr[t]!++;
    }
  }
  const data = new Float32Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    data[3 * t] = g[t]! / nT_samples;
    data[3 * t + 1] = sArr[t]! / nT_samples;
    data[3 * t + 2] = eArr[t]! / nT_samples;
  }
  return { w: wN, data };
}

// ----------------------------------------------------------------- rayHit
export interface RayHitRequest { x: number; y: number; hObsM: number; azRad: number; elRad: number; maxD: number; }

export function rayHit(req: RayHitRequest): { blocked: boolean; dHit: number } {
  const h0 = sampleH(req.x, req.y) + req.hObsM;
  let d = (S.hf?.texelM ?? 40);
  const R = 1_737_400;
  while (d <= req.maxD) {
    const x = req.x + d * Math.sin(req.azRad);
    const y = req.y + d * Math.cos(req.azRad);
    // Ray height above the local tangent, minus curvature drop:
    const rayZ = h0 + d * Math.tan(req.elRad);
    const drop = (d * d) / (2 * R);
    const ht = sampleH(x, y);
    if (rayZ - drop < ht) return { blocked: true, dHit: d };
    d += Math.max(S.hf?.texelM ?? 40, 0.01 * d);
  }
  return { blocked: false, dHit: 0 };
}

// ------------------------------------------- jump-to-event search (FR-E5)
export type EventKind = "sunrise" | "sunset" | "earthrise" | "earthset" | "eclipse";
export interface NextEventRequest {
  kind: EventKind;
  fromMs: number;
  x: number;
  y: number;
  /** Search horizon [days]; default 730 (the full mission range). */
  maxDays?: number;
}

/**
 * Find the next event of the given kind at (x, y): horizon crossings of the
 * Sun/Earth discs use the baked horizon map; eclipse is Sun occluded by Earth.
 * Coarse 30-min scan + bisection to < 1 min (FR-E5 acceptance).
 */
export function nextEvent(req: NextEventRequest): { t: number; kind: EventKind } | null {
  const t0 = req.fromMs;
  const tEnd = t0 + (req.maxDays ?? 730) * 86400_000;
  const { latRad, lonRad } = gridToLatLon(req.x, req.y);
  const isSun = req.kind === "sunrise" || req.kind === "sunset";
  const isRise = req.kind === "sunrise" || req.kind === "earthrise";

  // Signed "height above (+) / below (-) the horizon" for the target body.
  // Eclipse uses (rS + rE − separation): positive while the discs overlap.
  const f = (tMs: number): number => {
    const sky = skyState(new Date(tMs));
    if (req.kind === "eclipse") {
      const a = sky.sunME, b = sky.earthME;
      const sep = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));
      return sky.sunAngRadius + sky.earthAngRadius - sep;
    }
    const { sun, earth } = skyAzEl(sky, latRad, lonRad);
    const v = isSun ? sun : earth;
    const h = horizonAngleBin(S.horizon!, S.hPx, S.nAz, req.x, req.y, v.az, S.hf!.bounds);
    return v.el - h;
  };

  // Coarse scan on the 30-min sky-cache grid.
  const dtCoarse = 30 * 60 * 1000;
  let prevT = t0;
  let prevF = f(t0);
  for (let t = t0 + dtCoarse; t <= tEnd; t += dtCoarse) {
    const cur = f(t);
    const crossed = isRise || req.kind === "eclipse" ? prevF <= 0 && cur > 0 : prevF > 0 && cur <= 0;
    if (crossed) {
      // Bisect to < 1 min.
      let lo = prevT, hi = t;
      while (hi - lo > 60_000) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if ((fm <= 0) === (prevF <= 0)) lo = mid;
        else hi = mid;
      }
      return { t: hi, kind: req.kind };
    }
    prevT = t;
    prevF = cur;
  }
  return null;
}

// ------------------------------------------------------ auto-planner (FR-B7)
export interface AutoPlanRequest {
  site: { x: number; y: number };
  /** Search radius [m] (default 12 km). */
  radiusM?: number;
  /** Candidate cells per side (default 24). */
  gridN?: number;
  /** Evaluation time ("now"). */
  t0: number;
  /** Green must hold over this window [s] (default 6 h). */
  windowSec?: number;
  /** Energy currently in the battery [Wh]. */
  availableWh: number;
  /** Energy kept in reserve [Wh]. */
  reserveWh: number;
  speedMps: number;
  driveW: number;
}

export interface PlanCandidate {
  x: number; y: number; lat: number; lon: number;
  distM: number; driveH: number; energyWh: number;
  fSun: number; fEarth: number;
}

/**
 * "Find the nearest green spot reachable with the current SOC" (FR-B7):
 * scans a coarse grid around the site, keeps cells that are green (Sun + comm)
 * now and still green at the end of the window, ranks by drive distance.
 */
export function autoPlan(req: AutoPlanRequest): { candidates: PlanCandidate[] } {
  const radiusM = req.radiusM ?? 12_000;
  const gridN = req.gridN ?? 24;
  const windowSec = req.windowSec ?? 6 * 3600;
  const step = (2 * radiusM) / gridN;
  const budgetWh = Math.max(0, req.availableWh - req.reserveWh);
  const out: PlanCandidate[] = [];

  for (let iy = 0; iy < gridN; iy++) {
    for (let ix = 0; ix < gridN; ix++) {
      const x = req.site.x - radiusM + (ix + 0.5) * step;
      const y = req.site.y - radiusM + (iy + 0.5) * step;
      const distM = Math.hypot(x - req.site.x, y - req.site.y);
      if (distM > radiusM || distM < step * 0.5) continue;
      const driveH = distM / req.speedMps / 3600;
      const energyWh = driveH * req.driveW;
      if (energyWh > budgetWh) continue; // unreachable with the current SOC

      // Green now and at the end of the window (persistence check).
      const hObs = sampleH(x, y) + 2;
      const now = fractionsAt(x, y, hObs, skyCached(req.t0));
      const isGreen = (f: { fSun: number; fEarth: number }) => f.fSun >= 0.1 && f.fEarth >= 0.5;
      if (!isGreen(now)) continue;
      const later = fractionsAt(x, y, hObs, skyCached(req.t0 + windowSec * 1000));
      if (!isGreen(later)) continue;

      const { latRad, lonRad } = gridToLatLon(x, y);
      out.push({
        x, y, lat: latRad, lon: lonRad,
        distM, driveH, energyWh,
        fSun: Math.min(now.fSun, later.fSun),
        fEarth: Math.min(now.fEarth, later.fEarth),
      });
    }
  }
  out.sort((a, b) => a.distM - b.distM);
  return { candidates: out.slice(0, 12) };
}

// --------------------------------------------------------------- validate
export interface ValidateRequest {
  /** Candidate rim sites; the best-illuminated one is compared with the
   *  published "most illuminated point near the rim" values. */
  rimCandidates: { x: number; y: number }[];
  floor: { x: number; y: number };
  hObsM: number;
  t0: number;
  t1: number;
  dtSec: number;
}

export interface ValidateResult {
  /** Values keyed by `MetricId` from @helios/core (degrees / percent of year). */
  computed: Record<string, number>;
  /** Extra diagnostics the panel prints as sub-notes. */
  extras: {
    rimBestPct: number;
    rimMeanPct: number;
    rimUsefulPct: number;
    rimLongestDarkH: number;
    floorLongestDarkH: number;
    samples: number;
    wallMs: number;
  };
}

/**
 * Model-vs-published validation run (PRD FR-D2).
 *
 * Computes, with the same horizon map and ephemeris the rest of the app uses:
 *  - the polar Sun/Earth elevation extremes (astrometry only), and
 *  - the share of the window in which the rim and the crater floor see the Sun.
 * The results are paired with the published reference table in the UI; nothing
 * here is pre-baked.
 */
export function validate(req: ValidateRequest): ValidateResult {
  // The panel can fire before `loadTerrain` lands (the client boots the worker
  // asynchronously); fail fast with a retryable error instead of dereferencing
  // null below.
  if (!S.hf || !S.horizon) throw new Error("validate: terrain not loaded");
  const tStart = Date.now();
  const n = Math.max(2, Math.floor((req.t1 - req.t0) / (req.dtSec * 1000)));
  const sites = req.rimCandidates.map((p) => ({
    x: p.x,
    y: p.y,
    hObs: sampleH(p.x, p.y) + req.hObsM,
    lit: 0,
    useful: 0,
    darkRun: 0,
    darkMax: 0,
  }));
  const floorH = sampleH(req.floor.x, req.floor.y) + req.hObsM;

  let floorLit = 0, floorDarkRun = 0, floorDarkMax = 0;
  for (let i = 0; i < n; i++) {
    const sky = skyCached(req.t0 + i * req.dtSec * 1000);
    for (const s of sites) {
      const fr = fractionsAt(s.x, s.y, s.hObs, sky);
      if (fr.fSun > 0) {
        s.lit++;
        s.darkRun = 0;
      } else {
        s.darkRun++;
        if (s.darkRun > s.darkMax) s.darkMax = s.darkRun;
      }
      if (fr.fSun >= 0.1) s.useful++;
    }
    const fo = fractionsAt(req.floor.x, req.floor.y, floorH, sky);
    if (fo.fSun > 0) {
      floorLit++;
      floorDarkRun = 0;
    } else {
      floorDarkRun++;
      if (floorDarkRun > floorDarkMax) floorDarkMax = floorDarkRun;
    }
  }

  // The published figures quote the *most illuminated* point near the rim, so
  // compare best-against-best and report the ring mean as the spread.
  const shares = sites.map((s) => (100 * s.lit) / n);
  let bestIdx = 0;
  for (let k = 1; k < shares.length; k++) if (shares[k]! > shares[bestIdx]!) bestIdx = k;
  const best = sites[bestIdx]!;
  const rimMean = shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length);

  // Astrometry-only extremes at the pole, from the same ephemeris.
  const sky = polarSkyExtremes(req.t0, req.t1, 6 * 3600e3);
  // Model-vs-JPL: the analytic engine (which drives this sweep) against the
  // pre-baked JPL HORIZONS vectors that answer the app's other ephemeris calls.
  const agree = ephemerisAgreement(req.t0, req.t1, 6 * 3600e3);
  const hoursPerSample = req.dtSec / 3600;
  return {
    computed: {
      ephemerisJpl: agree.maxAngErrDeg,
      sunElPole: sky.maxSunElDeg,
      earthElPole: sky.maxEarthElDeg,
      rimIllumination: shares[bestIdx]!,
      floorShadow: (100 * floorLit) / n,
    },
    extras: {
      rimBestPct: shares[bestIdx]!,
      rimMeanPct: rimMean,
      rimUsefulPct: (100 * best.useful) / n,
      rimLongestDarkH: best.darkMax * hoursPerSample,
      floorLongestDarkH: floorDarkMax * hoursPerSample,
      samples: n * sites.length + sky.samples,
      wallMs: Date.now() - tStart,
    },
  };
}

// ----------------------------------------------------- message dispatch
type Fn = (payload: never) => unknown;
const registry: Record<string, Fn> = {
  loadTerrain: loadTerrain as unknown as Fn,
  simulate: simulate as unknown as Fn,
  ribbon: ribbon as unknown as Fn,
  dutyMap: dutyMap as unknown as Fn,
  rayHit: rayHit as unknown as Fn,
  nextEvent: nextEvent as unknown as Fn,
  autoPlan: autoPlan as unknown as Fn,
  validate: validate as unknown as Fn,
};

function transferOf(result: unknown): ArrayBuffer[] {
  const bufs: ArrayBuffer[] = [];
  const scan = (v: unknown, depth = 0) => {
    if (depth > 3 || v == null) return;
    if (v instanceof Float32Array || v instanceof Uint8Array || v instanceof Uint8ClampedArray) {
      if (v.buffer instanceof ArrayBuffer) bufs.push(v.buffer);
    } else if (Array.isArray(v)) v.forEach((x) => scan(x, depth + 1));
    else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => scan(x, depth + 1));
  };
  scan(result);
  return bufs;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, fn, payload } = e.data as { id: number; fn: string; payload: never };
  try {
    const result = await registry[fn]!(payload);
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transferOf(result));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
