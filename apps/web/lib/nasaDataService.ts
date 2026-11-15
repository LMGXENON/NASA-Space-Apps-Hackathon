/**
 * NASA data integration layer (Project Helios).
 *
 * 1. `NasaDataService.fetchEphemerisData()` queries the official JPL HORIZONS
 *    API (https://ssd.jpl.nasa.gov/api/horizons.api) for the Sun (target 10) and
 *    Earth (target 399) relative to the Moon's centre (CENTER 500@301), as ICRF
 *    state vectors (REF_PLANE=FRAME — verified numerically against DE441),
 *    parses the text-stream output into 3D Cartesian coordinates, rotates them
 *    into the Moon-fixed ME frame with the same IAU lunar orientation model
 *    `@helios/core` uses, and scales them onto the Three.js 100-unit scene
 *    radius (SCENE_RADIUS).
 *
 * 2. **Pre-baked JPL vectors** (the primary path) — browsers cannot call
 *    ssd.jpl.nasa.gov (no Access-Control-Allow-Origin header), so the live
 *    fetch can never succeed in the deployed static app. `tools/prep_ephemeris.py`
 *    therefore pre-bakes the identical query into `@helios/core` on a 6 h grid
 *    across the mission window, and `bakedEphemeris()` interpolates it
 *    (Catmull-Rom, measured ≤ 0.001° against exact HORIZONS vectors). This is
 *    real JPL data — the panel labels it "JPL HORIZONS", not "fallback".
 *
 * 3. **Fallback engine** — a deterministic astronomical calculation
 *    (astronomy-engine's physical ephemeris + the IAU/IAG lunar orientation
 *    model, the same SPICE-grade ground truth `@helios/core` is tested against
 *    JPL Horizons fixtures) answers outside the baked window or if the table
 *    is unavailable. The live parser is exercised from Node/tests.
 *
 * 3. `calculateLinkBudget()` — S-band (2200 MHz) Direct-To-Earth budget:
 *    FSPL = 20·log10(d_km) + 20·log10(f_MHz) + 32.44 dB, light-time latency
 *    d/c, and an SNR estimate against a 34-m DSN downlink.
 *
 * 4. `getMoonTrekTileUrl()` — NASA Moon Trek / LRO LOLA DEM WMTS tiles for the
 *    lunar south pole (Shackleton −89.9° is inside the 87.5°S→pole coverage),
 *    verified live against trek.nasa.gov (256² gray+alpha PNG, zooms 0–9).
 *
 * 5. `fetchSpaceWeather()` — NASA DONKI (Database of Notifications, Knowledge,
 *    Information), served by the CCMC API since NASA's 2026-09-30 migration
 *    (api.nasa.gov/DONKI now redirects there; query/response formats are
 *    unchanged). Geomagnetic storms (GST, planetary Kp) and coronal mass
 *    ejections (CME) are the disturbances that erode S-band DTE margin and DSN
 *    scheduling windows, so the report annotates the Earth-link panel. The
 *    api.nasa.gov key (see .env.example) rides along on every request: DONKI
 *    has been keyless since the migration, so the key is optional today and
 *    future-proofs the app if NASA re-gates the API.
 */

import * as THREE from "three";
import {
  AU_KM,
  BOLTZMANN_DB,
  R_MOON,
  azEl,
  bakedIcrf,
  eqjToMe,
  localFrame,
  skyState,
  type Vec3,
} from "@helios/core";

// ------------------------------------------------------------------ constants

/** JPL HORIZONS API endpoint (JSON envelope around the classic text ephemeris). */
export const HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api";

/** Three.js scene radius [scene units]; HORIZONS vectors are scaled onto it. */
export const SCENE_RADIUS = 100;

/** S-band Direct-To-Earth carrier [MHz] (PRD: 2200 MHz DTE link). */
export const DEFAULT_FREQUENCY_MHZ = 2200;

const SPEED_OF_LIGHT_KM_S = 299_792.458;

// Link-budget model constants (documented so the numbers are auditable):
/** Rover EIRP: 20 W TWTA (13.0 dBW) + 3 dBi patch antenna. */
export const DTE_EIRP_DBW = 16.0;
/** 34-m DSN BWG aperture G/T at S-band [dB/K]. */
export const DSN34_G_OVER_T_DB_K = 57.2;
/** Telemetry noise bandwidth: 1 MHz [dB·Hz]. */
export const DTE_NOISE_BW_DB_HZ = 10 * Math.log10(1e6);
/** Pointing + polarization implementation losses [dB]. */
export const DTE_IMPLEMENTATION_LOSS_DB = 2.5;

/** Moon Trek WMTS base for the south-pole (SP) tile matrix set. */
export const MOON_TREK_SP_BASE = "https://trek.nasa.gov/tiles/Moon/SP";
/**
 * LRO LOLA 5 m/px grayscale south-pole DEM (87.5°S → pole), the product that
 * covers Shackleton Crater (−89.9°). Layer id confirmed via the Trek search API.
 */
export const MOON_TREK_SP_DEM = "LRO_LOLA_Gray_SPole875_5mp_v04";
/** WMTS style / matrix-set identifiers from the layer's GetCapabilities. */
export const MOON_TREK_STYLE = "default";
export const MOON_TREK_MATRIX_SET = "default028mm";
/** Zoom range advertised by the layer's TileMatrixSetLink (verified). */
export const MOON_TREK_MIN_ZOOM = 0;
export const MOON_TREK_MAX_ZOOM = 9;

// ------------------------------------------------------------- parsed vectors

/** One row of a HORIZONS VECTOR ephemeris, Moon-centred body-fixed (ME) frame. */
export interface HorizonsVector {
  /** Julian date (TDB) of the row, when the epoch line was present. */
  jdTdb: number | null;
  /** Raw epoch label from the stream, e.g. "A.D. 2026-Nov-20 00:00:00.0000 TDB". */
  epochLabel: string | null;
  /** Position [km]. */
  x: number;
  y: number;
  z: number;
  /** Velocity [km/s] when the response carried it (VEC_TABLE ≥ 2). */
  vx: number | null;
  vy: number | null;
  vz: number | null;
  /** Light time [s], range [km], range rate [km/s] when present. */
  ltSec: number | null;
  rangeKm: number | null;
  rangeRateKps: number | null;
}

/** Result of `fetchEphemerisData`, always usable — even fully offline. */
export interface EphemerisData {
  /** ISO instant that was evaluated (UTC label for the query epoch). */
  date: string;
  /** "horizons" = JPL data; "fallback" = deterministic engine. */
  source: "horizons" | "fallback";
  /** Provenance detail: pre-baked JPL table, live JPL parse, or the model. */
  origin: "baked" | "live" | "model";
  /** Sun direction from the Moon's centre, scaled to SCENE_RADIUS. */
  sunPosition: THREE.Vector3;
  /** Earth direction from the Moon's centre, scaled to SCENE_RADIUS. */
  earthPosition: THREE.Vector3;
  /** Moon-centred ME-frame Cartesian vector [km] (HORIZONS native units). */
  sunPositionKm: THREE.Vector3;
  earthPositionKm: THREE.Vector3;
  sunDistanceKm: number;
  earthDistanceKm: number;
  /** Set when the live API could not be used and the fallback engine answered. */
  error: string | null;
}

export interface LinkBudget {
  frequencyMhz: number;
  distanceKm: number;
  /** Free-space path loss [dB]. */
  fsplDb: number;
  /** One-way light time [s] (d / c). */
  latencySeconds: number;
  /** Estimated carrier-to-noise density [dB·Hz]. */
  cN0DbHz: number;
  /** Estimated SNR in the 1 MHz telemetry channel [dB]. */
  snrDb: number;
}

// -------------------------------------------------------------- HORIZONS text

const NUM = String.raw`([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)`;
const XYZ_RE = new RegExp(String.raw`X\s*=\s*${NUM}\s*Y\s*=\s*${NUM}\s*Z\s*=\s*${NUM}`);
const VXYZ_RE = new RegExp(
  String.raw`VX\s*=\s*${NUM}\s*VY\s*=\s*${NUM}\s*VZ\s*=\s*${NUM}`,
);
const LT_RG_RR_RE = new RegExp(String.raw`LT\s*=\s*${NUM}\s*RG\s*=\s*${NUM}\s*RR\s*=\s*${NUM}`);
const EPOCH_RE = /^\s*(\d+(?:\.\d+)?)\s*=\s*(A\.D\..*?)\s*$/;

/**
 * Parse the classic HORIZONS text stream (the JSON `result` field) into
 * Cartesian rows. The `$$SOE … $$EOE` block is honoured when present; a bare
 * stream (fixtures) is accepted too.
 */
export function parseHorizonsVectors(result: string): HorizonsVector[] {
  const start = result.indexOf("$$SOE");
  const end = result.indexOf("$$EOE");
  const body = start >= 0 && end > start ? result.slice(start + 5, end) : result;

  const rows: HorizonsVector[] = [];
  let current: HorizonsVector | null = null;
  for (const line of body.split("\n")) {
    const epoch = EPOCH_RE.exec(line);
    if (epoch && !XYZ_RE.test(line)) {
      current = {
        jdTdb: Number(epoch[1]),
        epochLabel: epoch[2] ?? null,
        x: 0,
        y: 0,
        z: 0,
        vx: null,
        vy: null,
        vz: null,
        ltSec: null,
        rangeKm: null,
        rangeRateKps: null,
      };
      continue;
    }
    const xyz = XYZ_RE.exec(line);
    if (xyz) {
      const row: HorizonsVector = current ?? {
        jdTdb: null,
        epochLabel: null,
        x: 0,
        y: 0,
        z: 0,
        vx: null,
        vy: null,
        vz: null,
        ltSec: null,
        rangeKm: null,
        rangeRateKps: null,
      };
      row.x = Number(xyz[1]);
      row.y = Number(xyz[2]);
      row.z = Number(xyz[3]);
      const v = VXYZ_RE.exec(line);
      if (v) {
        row.vx = Number(v[1]);
        row.vy = Number(v[2]);
        row.vz = Number(v[3]);
      }
      rows.push(row);
      current = null;
      continue;
    }
    const lrr = LT_RG_RR_RE.exec(line);
    if (lrr && rows.length > 0) {
      const row = rows[rows.length - 1]!;
      row.ltSec = Number(lrr[1]);
      row.rangeKm = Number(lrr[2]);
      row.rangeRateKps = Number(lrr[3]);
    }
  }
  return rows;
}

/** Build the HORIZONS vector query URL for one target seen from the Moon. */
export function horizonsVectorUrl(command: string, isoDate: string, stopIso: string): string {
  const p = new URLSearchParams({
    format: "json",
    COMMAND: `'${command}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'",
    CENTER: "'500@301'",
    START_TIME: `'${isoDate}'`,
    STOP_TIME: `'${stopIso}'`,
    STEP_SIZE: "'1h'",
    // FRAME = ICRF (verified numerically vs DE441/astronomy-engine). The
    // result is rotated into the ME frame after parsing. Position-only table
    // keeps the payload lean.
    REF_PLANE: "'FRAME'",
    VEC_TABLE: "'1'",
    OUT_UNITS: "'KM-S'",
    CSV_FORMAT: "'NO'",
  });
  return `${HORIZONS_URL}?${p.toString()}`;
}

// ------------------------------------------------------- scene-frame mapping

/**
 * Map a Moon-fixed (ME) unit vector into the Three.js scene frame used by the
 * viewport: X = grid east, Y = up, Z = −grid north (flat-ENU mapping, the same
 * convention `Lasers`/`PropSunLight` render with). Defaults to the AOI centre
 * (south pole); pass the rover's selenodetic site for site-relative rays.
 * Result length is `radius` (the 100-unit scene radius).
 */
export function sceneVectorFromMe(
  unitMe: Vec3,
  latRad = -Math.PI / 2,
  lonRad = 0,
  radius = SCENE_RADIUS,
): THREE.Vector3 {
  const f = localFrame(latRad, lonRad);
  const { az, el } = azEl(unitMe, f);
  const ce = Math.cos(el);
  return new THREE.Vector3(
    ce * Math.sin(az) * radius,
    Math.sin(el) * radius,
    -ce * Math.cos(az) * radius,
  );
}

function normalizeMe(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

// ---------------------------------------------------------- fallback engine

/** Tiny last-N cache so several hook consumers share one computation per epoch. */
function memoizeByInt<A>(fn: (key: number) => A, size = 64): (key: number) => A {
  const cache = new Map<number, A>();
  return (key: number) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const val = fn(key);
    cache.set(key, val);
    if (cache.size > size) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return val;
  };
}

/**
 * Deterministic astronomical fallback: Sun/Earth state in the ME frame from
 * analytic planetary/lunar theory + the IAU lunar rotation model (the
 * SPICE-grade mechanics @helios/core validates against JPL Horizons fixtures).
 * Instant and offline-safe.
 */
function fallbackEphemerisUncached(epochMs: number): EphemerisData {
  const sky = skyState(new Date(epochMs));
  const sunUnit = normalizeMe(sky.sunME);
  const earthUnit = normalizeMe(sky.earthME);
  const sunDistanceKm = sky.sunDistAU * AU_KM;
  return {
    date: new Date(epochMs).toISOString(),
    source: "fallback",
    origin: "model",
    sunPosition: sceneVectorFromMe(sunUnit),
    earthPosition: sceneVectorFromMe(earthUnit),
    sunPositionKm: new THREE.Vector3(
      sunUnit.x * sunDistanceKm,
      sunUnit.y * sunDistanceKm,
      sunUnit.z * sunDistanceKm,
    ),
    earthPositionKm: new THREE.Vector3(
      earthUnit.x * sky.earthDistKm,
      earthUnit.y * sky.earthDistKm,
      earthUnit.z * sky.earthDistKm,
    ),
    sunDistanceKm,
    earthDistanceKm: sky.earthDistKm,
    error: null,
  };
}

// Memo key is epoch seconds; the engine works in milliseconds.
const fallbackBySecond = memoizeByInt(
  (epochSec: number) => fallbackEphemerisUncached(epochSec * 1000),
  32,
);

/** Public deterministic fallback (memoised per epoch second). */
export function fallbackEphemeris(date: string | number | Date): EphemerisData {
  const ms = typeof date === "number" ? date : Date.parse(String(date instanceof Date ? date.toISOString() : date));
  return fallbackBySecond(Math.round(ms / 1000));
}

// ------------------------------------------------------- pre-baked JPL table

/**
 * Sun + Earth state from the pre-baked JPL HORIZONS table (the exact query
 * `fetchEphemerisData` would send, baked by tools/prep_ephemeris.py because
 * browsers cannot reach ssd.jpl.nasa.gov). Interpolated at `epochMs` and
 * rotated ICRF → ME by the same IAU model as the live parse, so the two paths
 * are frame-identical. Returns null outside the baked window.
 */
function bakedEphemerisUncached(epochMs: number): EphemerisData | null {
  const v = bakedIcrf(epochMs);
  if (!v) return null;
  const toMe = eqjToMe(new Date(epochMs));
  const sunRow = toMe(v.sun);
  const earthRow = toMe(v.earth);
  const sunUnit = normalizeMe(sunRow);
  const earthUnit = normalizeMe(earthRow);
  return {
    date: new Date(epochMs).toISOString(),
    source: "horizons",
    origin: "baked",
    sunPosition: sceneVectorFromMe(sunUnit),
    earthPosition: sceneVectorFromMe(earthUnit),
    sunPositionKm: new THREE.Vector3(sunRow.x, sunRow.y, sunRow.z),
    earthPositionKm: new THREE.Vector3(earthRow.x, earthRow.y, earthRow.z),
    sunDistanceKm: Math.hypot(sunRow.x, sunRow.y, sunRow.z),
    earthDistanceKm: Math.hypot(earthRow.x, earthRow.y, earthRow.z),
    error: null,
  };
}

const bakedBySecond = memoizeByInt(
  (epochSec: number) => bakedEphemerisUncached(epochSec * 1000),
  64,
);

/** Pre-baked JPL answer for `date`, or null outside the baked mission window. */
export function bakedEphemeris(date: string | number | Date): EphemerisData | null {
  const ms = typeof date === "number" ? date : Date.parse(String(date instanceof Date ? date.toISOString() : date));
  return bakedBySecond(Math.round(ms / 1000));
}

/**
 * The ephemeris every local caller should use: pre-baked JPL HORIZONS inside
 * the mission window, the deterministic engine outside it.
 */
export function localEphemeris(date: string | number | Date): EphemerisData {
  return bakedEphemeris(date) ?? fallbackEphemeris(date);
}

// -------------------------------------------------------------------- service

export interface NasaDataServiceOptions {
  /** Injectable fetch (tests / offline stubs). */
  fetchFn?: typeof fetch;
  /** Per-request timeout [ms] before the fallback engine takes over. */
  timeoutMs?: number;
  /** api.nasa.gov key; defaults to the build-time env config. */
  apiKey?: string;
}

export class NasaDataService {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly cache = new Map<string, EphemerisData>();

  constructor(options: NasaDataServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.apiKey = options.apiKey ?? nasaApiKey();
  }

  /**
   * Sun + Earth as seen from the Moon at `targetDate` (ISO, 2026–2028 mission
   * range). Always resolves: on API limits, CORS failures, timeouts or parse
   * misses the deterministic fallback engine answers immediately.
   */
  async fetchEphemerisData(targetDate: string): Promise<EphemerisData> {
    const epochMs = Date.parse(targetDate);
    if (!Number.isFinite(epochMs)) {
      throw new TypeError(`fetchEphemerisData: invalid targetDate "${targetDate}"`);
    }
    const iso = new Date(epochMs).toISOString();
    const cacheKey = String(Math.round(epochMs / 1000));
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;

    try {
      const [sunIcrf, earthIcrf] = await Promise.all([
        this.fetchVector("10", iso),
        this.fetchVector("399", iso),
      ]);
      // HORIZONS ICRF → Moon-fixed ME frame (IAU lunar orientation model).
      const toMe = eqjToMe(new Date(epochMs));
      const sunRow = toMe(sunIcrf);
      const earthRow = toMe(earthIcrf);
      const sunUnit = normalizeMe(sunRow);
      const earthUnit = normalizeMe(earthRow);
      const data: EphemerisData = {
        date: iso,
        source: "horizons",
        origin: "live",
        sunPosition: sceneVectorFromMe(sunUnit),
        earthPosition: sceneVectorFromMe(earthUnit),
        sunPositionKm: new THREE.Vector3(sunRow.x, sunRow.y, sunRow.z),
        earthPositionKm: new THREE.Vector3(earthRow.x, earthRow.y, earthRow.z),
        sunDistanceKm: Math.hypot(sunRow.x, sunRow.y, sunRow.z),
        earthDistanceKm: Math.hypot(earthRow.x, earthRow.y, earthRow.z),
        error: null,
      };
      this.remember(cacheKey, data);
      return data;
    } catch (e) {
      const data: EphemerisData = {
        ...fallbackEphemeris(epochMs),
        error: e instanceof Error ? e.message : String(e),
      };
      this.remember(cacheKey, data);
      return data;
    }
  }

  /**
   * S-band Direct-To-Earth link budget at `distanceKm`:
   * FSPL = 20·log10(d) + 20·log10(f) + 32.44 dB, latency = d / c, SNR against
   * a 34-m DSN downlink in a 1 MHz telemetry channel.
   */
  calculateLinkBudget(distanceKm: number, frequencyMhz = DEFAULT_FREQUENCY_MHZ): LinkBudget {
    return computeLinkBudget(distanceKm, frequencyMhz);
  }

  /**
   * NASA Moon Trek / LRO LOLA south-pole DEM WMTS tile URL.
   * `x` is the tile column and `y` the tile row (WMTS serves
   * {TileMatrix}/{TileRow}/{TileCol} = zoom/y/x).
   */
  getMoonTrekTileUrl(zoom: number, x: number, y: number): string {
    return moonTrekTileUrl(zoom, x, y);
  }

  /**
   * NASA DONKI space-weather report for the window (geomagnetic storms + CMEs).
   * Never rejects: on API limits, CORS or timeouts it returns an explicit
   * `source: "unavailable"` report so the panel never guesses "quiet". Works
   * keyless; when an api.nasa.gov key is configured it is sent along.
   */
  async fetchSpaceWeather(
    startMs: number,
    endMs: number,
    mode: SpaceWeatherWindow["mode"] = "epoch",
  ): Promise<SpaceWeatherReport> {
    const win = clampSpaceWeatherWindow(startMs, endMs, mode);
    try {
      const [gsts, cmes] = await Promise.all([
        this.fetchDonki<DonkiGstEvent[]>("GST", win),
        this.fetchDonki<DonkiCmeEvent[]>("CME", win),
      ]);
      return rateSpaceWeather(gsts, cmes, win);
    } catch (e) {
      return {
        ...rateSpaceWeather([], [], win),
        source: "unavailable",
        level: "unknown",
        headline: "Space weather unavailable",
        impact: "NASA DONKI could not be reached — no link-weather context for this window.",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ------------------------------------------------------------------ internals

  /** Fetch one DONKI event list for the window. Throws on any miss. */
  private async fetchDonki<T>(endpoint: DonkiEndpoint, win: SpaceWeatherWindow): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(donkiEventsUrl(endpoint, win.startMs, win.endMs, this.apiKey), {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`DONKI ${endpoint} HTTP ${res.status}`);
      const json: unknown = await res.json();
      // DONKI answers with a JSON array; tolerate empty/odd bodies.
      return (Array.isArray(json) ? json : []) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch one body's ME-frame position vector at `iso` [km]. Throws on any miss. */
  private async fetchVector(command: string, iso: string): Promise<Vec3> {
    // HORIZONS wants "YYYY-MM-DDTHH:MM:SS" — strip ms and the trailing Z.
    const clean = (s: string) => s.replace(/\.\d+Z$/, "").replace(/Z$/, "");
    const stop = clean(new Date(Date.parse(iso) + 3_600_000).toISOString());
    const url = horizonsVectorUrl(command, clean(iso), stop);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HORIZONS HTTP ${res.status}`);
      const json = (await res.json()) as { result?: string; error?: string };
      if (typeof json.result !== "string") {
        throw new Error(`HORIZONS: ${json.error ?? "missing result stream"}`);
      }
      const rows = parseHorizonsVectors(json.result);
      const row = rows[0];
      if (!row || !Number.isFinite(row.x) || !Number.isFinite(row.y) || !Number.isFinite(row.z)) {
        throw new Error("HORIZONS: no vector rows in $$SOE block");
      }
      return { x: row.x, y: row.y, z: row.z };
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, data: EphemerisData): void {
    this.cache.set(key, data);
    if (this.cache.size > 64) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

/** Pure link-budget math (shared by the service and tests). */
export function computeLinkBudget(
  distanceKm: number,
  frequencyMhz = DEFAULT_FREQUENCY_MHZ,
): LinkBudget {
  if (!(distanceKm > 0) || !Number.isFinite(distanceKm)) {
    throw new RangeError(`computeLinkBudget: distanceKm must be > 0 (got ${distanceKm})`);
  }
  if (!(frequencyMhz > 0) || !Number.isFinite(frequencyMhz)) {
    throw new RangeError(`computeLinkBudget: frequencyMhz must be > 0 (got ${frequencyMhz})`);
  }
  const fsplDb = 20 * Math.log10(distanceKm) + 20 * Math.log10(frequencyMhz) + 32.44;
  const latencySeconds = distanceKm / SPEED_OF_LIGHT_KM_S;
  const cN0DbHz =
    DTE_EIRP_DBW - fsplDb - DTE_IMPLEMENTATION_LOSS_DB + DSN34_G_OVER_T_DB_K - BOLTZMANN_DB;
  const snrDb = cN0DbHz - DTE_NOISE_BW_DB_HZ;
  return { frequencyMhz, distanceKm, fsplDb, latencySeconds, cN0DbHz, snrDb };
}

/**
 * Moon Trek LRO LOLA south-pole DEM tile URL, e.g. Shackleton (−89.9°) tiles at
 * zooms 0–9. Verified live: 1.0.0/default/default028mm/{z}/{row}/{col}.png
 * returns 256² gray+alpha PNGs.
 */
export function moonTrekTileUrl(zoom: number, x: number, y: number): string {
  const z = Math.min(MOON_TREK_MAX_ZOOM, Math.max(MOON_TREK_MIN_ZOOM, Math.round(zoom)));
  const col = Math.max(0, Math.round(x));
  const row = Math.max(0, Math.round(y));
  return (
    `${MOON_TREK_SP_BASE}/${MOON_TREK_SP_DEM}/1.0.0/` +
    `${MOON_TREK_STYLE}/${MOON_TREK_MATRIX_SET}/${z}/${row}/${col}.png`
  );
}

/** Shared singleton used by the React hook and the panels. */
export const nasaDataService = new NasaDataService();

/** Moon mean radius [km] — rover-relative range refinement for the hook. */
export const R_MOON_KM = R_MOON / 1000;

// ----------------------------------------------------- space weather (DONKI)

/**
 * NASA DONKI — solar-activity context for the S-band DTE link. Served by the
 * CCMC API since the 2026-09-30 migration away from api.nasa.gov (which now
 * 301s DONKI calls to the CCMC announcement page). CORS-enabled, so the static
 * export calls it directly from the browser.
 */
export const DONKI_URL = "https://ccmc.gsfc.nasa.gov/DONKI-API/get";

/** DONKI rejects queries spanning more than 30 days. */
export const DONKI_MAX_SPAN_DAYS = 30;

export type DonkiEndpoint = "GST" | "CME";

export interface DonkiKpSample {
  kpIndex: number;
  observedTime: string;
}

/** DONKI geomagnetic-storm event (subset the app needs). */
export interface DonkiGstEvent {
  gstID: string;
  startTime: string;
  allKpIndex?: DonkiKpSample[] | null;
}

export interface DonkiCmeAnalysis {
  speed?: number | null;
  isMostAccurate?: boolean;
}

/** DONKI coronal-mass-ejection event (subset the app needs). */
export interface DonkiCmeEvent {
  activityID: string;
  startTime: string;
  cmeAnalyses?: DonkiCmeAnalysis[] | null;
}

export type SpaceWeatherLevel = "unknown" | "quiet" | "watch" | "storm";

export interface SpaceWeatherWindow {
  startMs: number;
  endMs: number;
  /** "epoch" = window around the mission date; "latest" = most recent
   *  observations, used when the mission epoch is in the future (no data can
   *  exist for it yet). */
  mode: "epoch" | "latest";
}

export interface SpaceWeatherReport {
  windowStart: string;
  windowEnd: string;
  mode: SpaceWeatherWindow["mode"];
  /** Geomagnetic storms logged in the window. */
  gstCount: number;
  /** Highest planetary Kp index seen in the window, when any was logged. */
  maxKp: number | null;
  cmeCount: number;
  /** Fastest analysed CME speed [km/s], when any CME was logged. */
  fastestCmeKms: number | null;
  level: SpaceWeatherLevel;
  headline: string;
  impact: string;
  source: "donki" | "unavailable";
  error: string | null;
}

/**
 * Pure DONKI → link-impact rating. Thresholds (documented for audit):
 *  - Kp ≥ 5 is a G1+ geomagnetic storm: expect S-band scintillation and DSN
 *    scheduling constraints.
 *  - Kp 4, or a ≥ 500 km/s CME, is a watch: margin wobble worth monitoring.
 *  - Anything else (including an empty window) is quiet.
 */
export function rateSpaceWeather(
  gsts: DonkiGstEvent[],
  cmes: DonkiCmeEvent[],
  window: SpaceWeatherWindow,
): SpaceWeatherReport {
  let maxKp: number | null = null;
  for (const gst of gsts) {
    for (const s of gst.allKpIndex ?? []) {
      if (Number.isFinite(s.kpIndex) && (maxKp === null || s.kpIndex > maxKp)) maxKp = s.kpIndex;
    }
  }
  let fastest: number | null = null;
  for (const cme of cmes) {
    for (const a of cme.cmeAnalyses ?? []) {
      const v = a.speed;
      if (typeof v === "number" && Number.isFinite(v) && (fastest === null || v > fastest)) fastest = v;
    }
  }

  let level: SpaceWeatherLevel = "quiet";
  if ((maxKp ?? 0) >= 5) level = "storm";
  else if ((maxKp ?? 0) >= 4 || (fastest ?? 0) >= 500) level = "watch";

  let headline: string;
  let impact: string;
  if (level === "storm") {
    headline = `Geomagnetic storm — Kp ${maxKp}`;
    impact = "Expect S-band scintillation and DSN scheduling constraints; re-check link margin before long drives.";
  } else if (level === "watch") {
    headline = (maxKp ?? 0) >= 4 ? `Active window — Kp ${maxKp} logged` : `Fast CME — ${fastest} km/s`;
    impact = "Minor link degradation possible; monitor margin during long passes.";
  } else {
    headline = "Quiet — no disturbances logged";
    impact = "Nominal link conditions in this window.";
  }

  return {
    windowStart: new Date(window.startMs).toISOString(),
    windowEnd: new Date(window.endMs).toISOString(),
    mode: window.mode,
    gstCount: gsts.length,
    maxKp,
    cmeCount: cmes.length,
    fastestCmeKms: fastest,
    level,
    headline,
    impact,
    source: "donki",
    error: null,
  };
}

/** Clamp a requested window to DONKI's 30-day limit (keeping the end bound). */
export function clampSpaceWeatherWindow(
  startMs: number,
  endMs: number,
  mode: SpaceWeatherWindow["mode"],
): SpaceWeatherWindow {
  const span = DONKI_MAX_SPAN_DAYS * 86_400_000;
  let s = Math.min(startMs, endMs);
  const e = Math.max(startMs, endMs);
  if (e - s > span) s = e - span;
  return { startMs: s, endMs: e, mode };
}

/**
 * Build one DONKI event-list query URL (dates are YYYY-MM-DD per the API).
 * `apiKey` is optional: DONKI has been keyless since the 2026-09-30 CCMC
 * migration, but a configured key rides along (ignored today, required if
 * NASA re-gates the API).
 */
export function donkiEventsUrl(
  endpoint: DonkiEndpoint,
  startMs: number,
  endMs: number,
  apiKey = "",
): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const p = new URLSearchParams({
    startDate: day(startMs),
    endDate: day(endMs),
  });
  if (apiKey) p.set("api_key", apiKey);
  return `${DONKI_URL}/${endpoint}?${p.toString()}`;
}

/**
 * api.nasa.gov key lookup (`NEXT_PUBLIC_*` is inlined into the static bundle at
 * build time since the app is `output: "export"`; `NASA_API_KEY` is the
 * tooling / test-runner alias and is undefined in browser builds). Optional:
 * DONKI accepts keyless requests, the key is sent along when present.
 */
function nasaApiKey(): string {
  try {
    return process.env.NEXT_PUBLIC_NASA_API_KEY || process.env.NASA_API_KEY || "";
  } catch {
    return "";
  }
}
