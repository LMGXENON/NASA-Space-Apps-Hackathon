/**
 * Model validation against published lunar south-pole reference values.
 *
 * Every row pairs a quantity this application *computes* — from its own ephemeris
 * (astronomy-engine, IAU lunar rotation) and horizon model — with a number the
 * literature *publishes* for the same quantity at the lunar south pole. The UI
 * renders these rows; nothing here is a hard-coded "computed" answer.
 *
 * Tolerances exist because the two sides are not measured the same way:
 *  - the polar elevation rows are bounds derived from the Moon's pole geometry,
 *    so the computed extreme must fall under the bound plus periodic allowance;
 *  - the illumination rows compare this app's sweep over the real LOLA DEM
 *    (LDEM_875S_20M, 20 m → 39 m AOI grid) against published studies computed
 *    with different sampling and definitions, so the windows stay loose and
 *    the row carries an "indicative" flag.
 */

import { skyAzEl, skyState } from "./ephemeris";
import { RAD2DEG } from "./frames";

export type MetricId =
  | "ephemerisJpl"
  | "sunElPole"
  | "earthElPole"
  | "rimIllumination"
  | "floorShadow";

export type ValidationStatus = "pass" | "warn" | "fail" | "pending";

export interface PublishedMetric {
  id: MetricId;
  /** What is being compared. */
  label: string;
  /** What this application computes for it. */
  computedLabel: string;
  unit: string;
  /** Published value as printed in the panel, e.g. "≤ 1.54" or "77–88". */
  publishedText: string;
  /** Numeric published reference (bound or range midpoint) for the delta column. */
  published: number;
  /** Computed value inside this inclusive window counts as agreement. */
  accept: [number, number];
  /** Inside this looser window the row is flagged amber; outside it fails. */
  warn: [number, number];
  /** True when the terrain under the metric is synthetic (wider windows). */
  indicative: boolean;
  source: string;
  sourceUrl: string;
  note: string;
}

/**
 * Published reference values.
 *
 *  - Moon Fact Sheet (NASA NSSDC): orbit inclination to the ecliptic 5.145°,
 *    obliquity of the equator to the orbit 6.68° ⇒ the spin axis sits
 *    6.68 − 5.145 ≈ 1.54° from the ecliptic pole, which bounds the polar Sun.
 *  - Gläser et al. 2018 (Planet. Space Sci. 162:170) and Bussey et al. 2010:
 *    annual illumination of the Shackleton / de Gerlache ridge region.
 *  - Paige et al. 2010 (Science 330:483, Diviner): permanently shadowed south
 *    polar interiors hold 20–40 K — the cold-trap regime this planner exists for.
 */
export const PUBLISHED_METRICS: readonly PublishedMetric[] = [
  {
    id: "ephemerisJpl",
    label: "Ephemeris vs JPL HORIZONS",
    computedLabel:
      "worst Sun/Earth direction deviation between the analytic model and the pre-baked JPL vectors over the window",
    unit: "°",
    publishedText: "≤ 0.05",
    published: 0.05,
    accept: [0, 0.05],
    warn: [0, 0.1],
    indicative: false,
    source:
      "JPL HORIZONS (DE441) — Sun/Earth state vectors from the Moon's centre, pre-baked by tools/prep_ephemeris.py; the bake measures its own interpolation error at every grid midpoint",
    sourceUrl: "https://ssd.jpl.nasa.gov/api/horizons.api",
    note: "The horizon sweep runs on the analytic engine; this row proves it tracks the JPL vectors that answer every other ephemeris call in the app.",
  },
  {
    id: "sunElPole",
    label: "Sun elevation at the pole",
    computedLabel: "max |elevation| over the window",
    unit: "°",
    publishedText: "≤ 1.54",
    published: 1.54,
    accept: [0, 1.84],
    warn: [0, 2.3],
    indicative: false,
    source: "NASA NSSDC Moon Fact Sheet — obliquity to orbit 6.68° − orbit inclination 5.145° = 1.54° axis tilt",
    sourceUrl: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html",
    note: "The polar Sun never clears the axial tilt. The +0.30° allowance covers periodic libration terms.",
  },
  {
    id: "earthElPole",
    label: "Earth elevation at the pole",
    computedLabel: "max |elevation| over the window",
    unit: "°",
    publishedText: "≤ 6.68",
    published: 6.68,
    accept: [0, 7.18],
    warn: [0, 7.6],
    indicative: false,
    source: "NASA NSSDC Moon Fact Sheet — obliquity of the equator to the orbit 6.68°",
    sourceUrl: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html",
    note: "Libration bound: Earth stays near the orbital plane, so from the pole it rides the equator-to-orbit tilt.",
  },
  {
    id: "rimIllumination",
    label: "Rim annual sunlight",
    computedLabel: "best point on the rim ring — share of the window with the Sun above the horizon",
    unit: "% of year",
    publishedText: "77–88 (86% peak)",
    published: 82.5,
    accept: [70, 93],
    warn: [55, 98],
    indicative: true,
    source: "Gläser et al. 2018, Planet. Space Sci. 162:170 (Shackleton–de Gerlache ridge 77–88%); Bussey et al. 2010 (86% peak near the rim)",
    sourceUrl: "https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf",
    note: "Indicative: a ring search over this app's real-LOLA horizon map at 2 h sampling vs published studies' own methods and site choices — treat as a consistency check, not a reproduction.",
  },
  {
    id: "floorShadow",
    label: "Floor permanent shadow",
    computedLabel: "share of the window with any sunlight on the crater floor",
    unit: "% of year",
    publishedText: "0 (permanent shadow)",
    published: 0,
    accept: [0, 1],
    warn: [0, 3],
    indicative: false,
    source: "LOLA / Bussey et al. 2010 (interior in permanent shadow); Diviner floor regime 20–40 K (Paige et al. 2010, Science 330:483)",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/20966246/",
    note: "Cold-trap regime: a floor that never sees the Sun is exactly the survival constraint this planner scores.",
  },
] as const;

/** Classify one computed value against its published metric. */
export function classifyMetric(computed: number | null, metric: PublishedMetric): ValidationStatus {
  if (computed == null || !Number.isFinite(computed)) return "pending";
  const [a0, a1] = metric.accept;
  if (computed >= a0 && computed <= a1) return "pass";
  const [w0, w1] = metric.warn;
  if (computed >= w0 && computed <= w1) return "warn";
  return "fail";
}

export interface ValidationRow {
  metric: PublishedMetric;
  /** Null when the value has not been computed (or the run failed). */
  computed: number | null;
  /** computed − published; null while pending. */
  delta: number | null;
  status: ValidationStatus;
}

/** Pair every published metric with its computed value, in display order. */
export function buildValidationRows(
  computed: Partial<Record<MetricId, number | null>>,
): ValidationRow[] {
  return PUBLISHED_METRICS.map((metric) => {
    const v = computed[metric.id] ?? null;
    return {
      metric,
      computed: v,
      delta: v == null || !Number.isFinite(v) ? null : v - metric.published,
      status: classifyMetric(v, metric),
    };
  });
}

export interface SkyExtremes {
  sunElDegMin: number;
  sunElDegMax: number;
  earthElDegMin: number;
  earthElDegMax: number;
  /** Largest |Sun elevation| reached [deg]. */
  maxSunElDeg: number;
  /** Largest |Earth elevation| reached [deg]. */
  maxEarthElDeg: number;
  samples: number;
}

/**
 * Min/max Sun and Earth elevation at a site over a time window.
 *
 * At the lunar south pole this is the direct model-vs-geometry check: the Sun
 * must never exceed the axial tilt and the Earth the equator-to-orbit tilt.
 * Sampled from `skyState`, the same ephemeris the rest of the app renders.
 */
export function polarSkyExtremes(
  t0Ms: number,
  t1Ms: number,
  stepMs: number,
  latRad = -Math.PI / 2,
  lonRad = 0,
): SkyExtremes {
  const step = Math.max(60_000, stepMs);
  let sunMin = Infinity, sunMax = -Infinity;
  let earthMin = Infinity, earthMax = -Infinity;
  let samples = 0;
  for (let t = t0Ms; t <= t1Ms; t += step) {
    const sky = skyState(new Date(t));
    const { sun, earth } = skyAzEl(sky, latRad, lonRad);
    const s = sun.el * RAD2DEG;
    const e = earth.el * RAD2DEG;
    if (s < sunMin) sunMin = s;
    if (s > sunMax) sunMax = s;
    if (e < earthMin) earthMin = e;
    if (e > earthMax) earthMax = e;
    samples++;
  }
  if (samples === 0) {
    return {
      sunElDegMin: 0, sunElDegMax: 0,
      earthElDegMin: 0, earthElDegMax: 0,
      maxSunElDeg: 0, maxEarthElDeg: 0,
      samples: 0,
    };
  }
  return {
    sunElDegMin: sunMin,
    sunElDegMax: sunMax,
    earthElDegMin: earthMin,
    earthElDegMax: earthMax,
    maxSunElDeg: Math.max(Math.abs(sunMin), Math.abs(sunMax)),
    maxEarthElDeg: Math.max(Math.abs(earthMin), Math.abs(earthMax)),
    samples,
  };
}
