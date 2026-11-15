/**
 * Terrain-conforming route maths (pure — no THREE, no DOM).
 *
 * A route between two waypoints is subdivided into dense samples and every sample
 * is draped onto a supplied height sampler, then each span is graded so an operator
 * can see where a rover would tip. Ground height is injected as a callback rather
 * than a heightfield type, so this stays in the science core and the app supplies
 * whichever surface it actually renders.
 *
 * Grid convention: `x`/`y` are the same planar grid metres used by
 * `latLonToGrid`; `h` is the true (unexaggerated) ground height in metres.
 */

/** Grade severity of a span. */
export type SlopeClass = 0 | 1 | 2;

/** Mission slope limits [deg]: below safe is traversable, above lethal is not. */
export const SLOPE_SAFE_DEG = 15;
export const SLOPE_LETHAL_DEG = 25;

/**
 * Span colours: glowing cyan (traversable), Kapton Gold (marginal), NASA Red
 * (lethal). Cyan rather than NASA Midnight Blue for the safe case because the rope
 * is drawn over the classified heat overlay, where #0B3D91 is nearly
 * indistinguishable from the dead/red patches.
 */
export const PATH_COLORS: readonly [number, number, number][] = [
  [0.133, 0.863, 0.933], // #22D3EE cyan
  [0.831, 0.686, 0.216], // #D4AF37 Kapton Gold
  [0.988, 0.239, 0.129], // #FC3D21 NASA Red
];

/** Legend text matching {@link PATH_COLORS}, index for index. */
export const PATH_COLOR_LABELS: readonly string[] = [
  "≤ 15° traversable",
  "15–25° marginal",
  "> 25° lethal",
];

/** Ground-height sampler: returns true height [m] at grid (x, y). */
export type PathSampler = (x: number, y: number) => number;

export interface DrapedPathOptions {
  /** Horizontal spacing between samples [m]. Default 0.5 m. */
  segmentM?: number;
  /** Explicit sample count, overriding `segmentM`. */
  segments?: number;
  /** Hard cap on samples; the step coarsens to respect it. Default 20 000. */
  maxPoints?: number;
  safeDeg?: number;
  lethalDeg?: number;
}

export interface PathSample {
  x: number;
  y: number;
  h: number;
}

export interface DrapedPath {
  samples: PathSample[];
  /** Grade magnitude [deg] from sample i to i+1; the last entry repeats. */
  slopesDeg: number[];
  /** `classes[i]` describes the i → i+1 span. */
  classes: SlopeClass[];
  /** Effective horizontal step actually used [m]; 0 for a degenerate leg. */
  stepM: number;
  /** True when `maxPoints` forced a coarser step than requested. */
  coarseStep: boolean;
}

/** Grade class for a slope magnitude [deg] under the mission limits. */
export function classifySlope(
  deg: number,
  safeDeg: number = SLOPE_SAFE_DEG,
  lethalDeg: number = SLOPE_LETHAL_DEG,
): SlopeClass {
  if (deg < safeDeg) return 0;
  if (deg <= lethalDeg) return 1;
  return 2;
}

/**
 * Sample plan for one leg: either an explicit count or one sample per `segmentM`,
 * clamped so the sample count never exceeds `maxPoints`.
 */
export function planSubdivision(
  a: { x: number; y: number },
  b: { x: number; y: number },
  opts: DrapedPathOptions = {},
): { count: number; stepM: number; coarseStep: boolean } {
  const maxPoints = Math.max(2, Math.floor(opts.maxPoints ?? 20_000));
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(dist > 0)) return { count: 1, stepM: 0, coarseStep: false };

  let stepM =
    opts.segments != null ? dist / Math.max(1, opts.segments) : Math.max(0, opts.segmentM ?? 0.5);
  // A zero/negative step would divide by zero; fall back to the whole leg.
  if (!(stepM > 0)) return { count: Math.min(maxPoints, 2), stepM: dist, coarseStep: maxPoints < 2 };

  let count = Math.floor(dist / stepM) + 1;
  let coarseStep = false;
  if (count > maxPoints) {
    coarseStep = true;
    count = maxPoints;
    stepM = dist / (count - 1);
  }
  return { count: Math.max(1, count), stepM, coarseStep };
}

/** Uniformly spaced grid points along A → B, inclusive of both ends. */
export function subdivideSegment(
  a: { x: number; y: number },
  b: { x: number; y: number },
  opts: DrapedPathOptions = {},
): { points: { x: number; y: number }[]; stepM: number; coarseStep: boolean } {
  const { count, stepM, coarseStep } = planSubdivision(a, b, opts);
  const points: { x: number; y: number }[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    points[i] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return { points, stepM, coarseStep };
}

/**
 * Grade each sample against its neighbour.
 *
 * Slopes come from the **true** heights the sampler returns. Callers that render
 * with a vertical exaggeration must not hand in exaggerated values: a 5× scene
 * scale would report a harmless 6° grade as 30° and paint the whole route lethal.
 */
export function gradeSamples(
  samples: PathSample[],
  safeDeg: number = SLOPE_SAFE_DEG,
  lethalDeg: number = SLOPE_LETHAL_DEG,
): { slopesDeg: number[]; classes: SlopeClass[] } {
  const n = samples.length;
  const slopesDeg = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const p = samples[i]!;
    const q = samples[i + 1]!;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    slopesDeg[i] = d > 0 ? (Math.atan2(Math.abs(q.h - p.h), d) * 180) / Math.PI : 0;
  }
  if (n > 1) slopesDeg[n - 1] = slopesDeg[n - 2]!;
  return { slopesDeg, classes: slopesDeg.map((d) => classifySlope(d, safeDeg, lethalDeg)) };
}

/** Subdivide A → B and drape it onto `sample`. */
export function drapeSegment(
  a: { x: number; y: number },
  b: { x: number; y: number },
  sample: PathSampler,
  opts: DrapedPathOptions = {},
): DrapedPath {
  const { points, stepM, coarseStep } = subdivideSegment(a, b, opts);
  const samples = points.map((p) => ({ x: p.x, y: p.y, h: sample(p.x, p.y) }));
  // A degenerate leg still needs a height, hence the single sample above.
  const { slopesDeg, classes } = gradeSamples(samples, opts.safeDeg, opts.lethalDeg);
  return { samples, slopesDeg, classes, stepM, coarseStep };
}

/**
 * Drape a whole route (start + waypoints) as one continuous ribbon and grade it
 * across the legs as well as within them, so a hard turn onto a slope at a
 * waypoint is not hidden by the leg boundary.
 */
export function drapeRoute(
  start: { x: number; y: number },
  waypoints: { x: number; y: number }[],
  sample: PathSampler,
  opts: DrapedPathOptions = {},
): DrapedPath {
  const legs = Math.max(1, waypoints.length);
  // Split the vertex budget across the legs so a long multi-waypoint route cannot
  // allocate unbounded geometry.
  const legOpts: DrapedPathOptions = { ...opts, maxPoints: Math.max(2, Math.floor((opts.maxPoints ?? 20_000) / legs)) };

  const nodes = [start, ...waypoints];
  const samples: PathSample[] = [];
  let stepM = 0;
  let coarseStep = false;
  for (let i = 1; i < nodes.length; i++) {
    const leg = drapeSegment(nodes[i - 1]!, nodes[i]!, sample, legOpts);
    stepM = Math.max(stepM, leg.stepM);
    coarseStep = coarseStep || leg.coarseStep;
    // Skip the duplicated joint sample on every leg after the first.
    for (let k = i === 1 ? 0 : 1; k < leg.samples.length; k++) samples.push(leg.samples[k]!);
  }
  if (samples.length === 0) {
    samples.push({ x: start.x, y: start.y, h: sample(start.x, start.y) });
  }
  const { slopesDeg, classes } = gradeSamples(samples, opts.safeDeg, opts.lethalDeg);
  return { samples, slopesDeg, classes, stepM, coarseStep };
}
