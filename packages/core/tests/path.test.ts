import { describe, expect, it } from "vitest";
import {
  PATH_COLORS,
  SLOPE_LETHAL_DEG,
  SLOPE_SAFE_DEG,
  classifySlope,
  drapeRoute,
  drapeSegment,
  gradeSamples,
  planSubdivision,
  subdivideSegment,
} from "../src/index";

const deg = (d: number) => (d * Math.PI) / 180;

/** Flat ground. */
const flat = () => 0;
/** Ground rising at `grade` along +y, so the slope of a northward leg is known. */
const ramp = (grade: number) => (_x: number, y: number) => y * grade;

describe("terrain-conforming path", () => {
  it("subdivides at the requested spacing, inclusive of both ends", () => {
    const { points, stepM, coarseStep } = subdivideSegment({ x: 0, y: 0 }, { x: 0, y: 100 }, { segmentM: 0.5 });
    expect(points.length).toBe(201);
    expect(stepM).toBeCloseTo(0.5, 9);
    expect(coarseStep).toBe(false);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[200]!.y).toBeCloseTo(100, 9);
    // Uniform spacing all the way along.
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.y - points[i - 1]!.y).toBeCloseTo(0.5, 9);
    }
  });

  it("honours an explicit segment count", () => {
    const { points, stepM } = subdivideSegment({ x: 0, y: 0 }, { x: 0, y: 1000 }, { segments: 10 });
    expect(points.length).toBe(11);
    expect(stepM).toBeCloseTo(100, 9);
  });

  it("coarsens the step instead of allocating past maxPoints", () => {
    // 40 km at 0.5 m would be 80 001 samples.
    const plan = planSubdivision({ x: -20_000, y: 0 }, { x: 20_000, y: 0 }, { segmentM: 0.5, maxPoints: 5000 });
    expect(plan.count).toBe(5000);
    expect(plan.coarseStep).toBe(true);
    expect(plan.stepM).toBeCloseTo(40_000 / 4999, 9);
    expect(subdivideSegment({ x: -20_000, y: 0 }, { x: 20_000, y: 0 }, { segmentM: 0.5, maxPoints: 5000 }).points.length).toBe(5000);
  });

  it("collapses a degenerate leg to a single sample rather than dividing by zero", () => {
    const r = drapeSegment({ x: 5, y: 5 }, { x: 5, y: 5 }, () => 42, { segmentM: 0.5 });
    expect(r.samples.length).toBe(1);
    expect(r.samples[0]).toEqual({ x: 5, y: 5, h: 42 });
    expect(r.stepM).toBe(0);
    expect(r.classes).toEqual([0]);
  });

  it("samples the terrain at every subdivided point", () => {
    const r = drapeSegment({ x: 0, y: 0 }, { x: 0, y: 200 }, ramp(0.2), { segmentM: 1 });
    expect(r.samples.length).toBe(201);
    for (const s of r.samples) expect(s.h).toBeCloseTo(s.y * 0.2, 9);
  });

  it("grades a known ramp correctly", () => {
    const r = drapeSegment({ x: 0, y: 0 }, { x: 0, y: 400 }, ramp(Math.tan(deg(10))), { segmentM: 2 });
    for (const s of r.slopesDeg.slice(0, -1)) expect(s).toBeCloseTo(10, 6);
    expect(r.classes.every((c) => c === 0)).toBe(true);
  });

  it("classifies the 15°/25° limits with the boundaries inclusive on caution", () => {
    expect(SLOPE_SAFE_DEG).toBe(15);
    expect(SLOPE_LETHAL_DEG).toBe(25);
    expect(classifySlope(0)).toBe(0);
    expect(classifySlope(14.99)).toBe(0);
    expect(classifySlope(15)).toBe(1);
    expect(classifySlope(25)).toBe(1);
    expect(classifySlope(25.01)).toBe(2);
  });

  it("provides one colour per grade class", () => {
    expect(PATH_COLORS.length).toBe(3);
    for (const c of PATH_COLORS) {
      expect(c.length).toBe(3);
      for (const ch of c) expect(ch).toBeGreaterThanOrEqual(0), expect(ch).toBeLessThanOrEqual(1);
    }
  });

  it("grades across leg boundaries so a waypoint cannot hide a grade jump", () => {
    // Flat approach, then a 30° wall starting exactly at the waypoint.
    const sample = (_x: number, y: number) => (y <= 0 ? 0 : y * Math.tan(deg(30)));
    const r = drapeRoute({ x: 0, y: -500 }, [{ x: 0, y: 0 }, { x: 0, y: 500 }], sample, {
      segmentM: 2,
      maxPoints: 4000,
    });
    expect(r.samples.length).toBeGreaterThan(300);
    expect(r.slopesDeg.length).toBe(r.samples.length);
    expect(r.classes.length).toBe(r.samples.length);
    // First span flat, last span lethal, and the transition happens at the joint.
    expect(r.classes[0]).toBe(0);
    expect(r.classes[r.classes.length - 2]).toBe(2);
    const joint = r.samples.findIndex((s) => s.y === 0);
    expect(joint).toBeGreaterThan(0);
    expect(r.classes[joint]!).toBe(2);
  });

  it("splits the sample budget across legs", () => {
    const r = drapeRoute({ x: 0, y: 0 }, Array.from({ length: 4 }, (_, i) => ({ x: 0, y: (i + 1) * 5000 })), flat, {
      segmentM: 0.5,
      maxPoints: 4000,
    });
    expect(r.samples.length).toBeLessThanOrEqual(4000);
    expect(r.coarseStep).toBe(true);
  });

  it("keeps the junction sample once when legs are concatenated", () => {
    const r = drapeRoute({ x: 0, y: 0 }, [{ x: 0, y: 100 }, { x: 100, y: 100 }], flat, { segments: 10 });
    // 10 segments per leg (11 samples) minus the shared joint = 21 samples.
    expect(r.samples.length).toBe(21);
    expect(r.samples[10]).toEqual({ x: 0, y: 100, h: 0 });
  });

  it("returns a single graded sample for a route with only a start point", () => {
    const r = drapeRoute({ x: 1, y: 2 }, [], () => 7, {});
    expect(r.samples).toEqual([{ x: 1, y: 2, h: 7 }]);
    expect(r.classes).toEqual([0]);
  });

  it("grades from the supplied heights, rejecting exaggerated input", () => {
    // Same 10° terrain, once with true heights and once 5× exaggerated: the caller
    // must pass true heights, so the exaggerated run is expected to read ~45°.
    const trueH = gradeSamples([{ x: 0, y: 0, h: 0 }, { x: 0, y: 100, h: 100 * Math.tan(deg(10)) }]);
    const exag = gradeSamples([{ x: 0, y: 0, h: 0 }, { x: 0, y: 100, h: 5 * 100 * Math.tan(deg(10)) }]);
    expect(trueH.slopesDeg[0]!).toBeCloseTo(10, 6);
    expect(exag.slopesDeg[0]!).toBeGreaterThan(40);
    expect(trueH.classes[0]).toBe(0);
  });
});
