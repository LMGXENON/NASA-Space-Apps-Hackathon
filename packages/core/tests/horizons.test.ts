import { describe, expect, it } from "vitest";
import {
  HORIZONS_BAKED,
  bakedCovers,
  bakedEndMs,
  bakedIcrf,
  bakedSkyState,
  bakedStartMs,
  buildValidationRows,
  ephemerisAgreement,
  type HorizonsProbeSample,
} from "../src/index";

const { validation } = HORIZONS_BAKED;

/** Angle between two Cartesian vectors [deg] (independent re-derivation). */
function angDeg(a: number[], b: number[]): number {
  const cross = Math.hypot(
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  );
  const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function probeErr(sample: HorizonsProbeSample): { sun: number; earth: number } {
  const t = Date.parse(sample.epochIso);
  const v = bakedIcrf(t);
  expect(v).not.toBeNull();
  return {
    sun: angDeg([v!.sun.x, v!.sun.y, v!.sun.z], sample.sun),
    earth: angDeg([v!.earth.x, v!.earth.y, v!.earth.z], sample.earth),
  };
}

describe("baked JPL HORIZONS table", () => {
  it("has the expected shape and a uniform 6 h grid", () => {
    expect(HORIZONS_BAKED.schema).toBe(1);
    expect(HORIZONS_BAKED.center).toBe("500@301");
    expect(HORIZONS_BAKED.frame).toBe("ICRF");
    expect(HORIZONS_BAKED.stepSec).toBe(21600);
    expect(HORIZONS_BAKED.sun.length).toBe(3 * HORIZONS_BAKED.count);
    expect(HORIZONS_BAKED.earth.length).toBe(3 * HORIZONS_BAKED.count);
    expect(HORIZONS_BAKED.count).toBe(2921); // 2026–2028 at 6 h
    expect(bakedEndMs - bakedStartMs).toBe((HORIZONS_BAKED.count - 1) * 21600 * 1000);
    expect(new Date(bakedStartMs).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(bakedEndMs).toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("carries plausible JPL magnitudes (Moon-centred, KM-S)", () => {
    for (const iso of ["2026-01-01T00:00:00Z", "2026-07-04T00:00:00Z", "2027-12-31T18:00:00Z"]) {
      const s = bakedSkyState(Date.parse(iso))!;
      expect(s.earthDistKm).toBeGreaterThan(356_000);
      expect(s.earthDistKm).toBeLessThan(407_000);
      // Sun–Moon distance: Earth's 0.9833–1.0167 AU heliocentric range plus
      // the Moon's ±0.0026 AU offset from Earth.
      expect(s.sunDistAU).toBeGreaterThan(0.98);
      expect(s.sunDistAU).toBeLessThan(1.02);
      expect(Math.hypot(s.sunME.x, s.sunME.y, s.sunME.z)).toBeCloseTo(1, 12);
      expect(Math.hypot(s.earthME.x, s.earthME.y, s.earthME.z)).toBeCloseTo(1, 12);
    }
  });

  it("interpolates exactly at the knots (including both window ends)", () => {
    for (const k of [0, 1, 500, HORIZONS_BAKED.count - 2, HORIZONS_BAKED.count - 1]) {
      const t = bakedStartMs + k * 21600 * 1000;
      const v = bakedIcrf(t)!;
      expect(v.sun.x).toBeCloseTo(HORIZONS_BAKED.sun[3 * k]!, 6);
      expect(v.sun.y).toBeCloseTo(HORIZONS_BAKED.sun[3 * k + 1]!, 6);
      expect(v.sun.z).toBeCloseTo(HORIZONS_BAKED.sun[3 * k + 2]!, 6);
      expect(v.earth.z).toBeCloseTo(HORIZONS_BAKED.earth[3 * k + 2]!, 6);
    }
  });

  it("reproduces exact HORIZONS probe values within the measured bake error", () => {
    // Cross-checks the TypeScript interpolator against the Python one that
    // measured and recorded `validation`: same probes must give the same answer.
    expect(validation.probeSamples.length).toBeGreaterThanOrEqual(8);
    for (const sample of validation.probeSamples) {
      const e = probeErr(sample);
      expect(e.sun).toBeLessThanOrEqual(validation.maxSunAngErrDeg + 1e-6);
      expect(e.earth).toBeLessThanOrEqual(validation.maxEarthAngErrDeg + 1e-6);
    }
  });

  it("records a milli-degree interpolation accuracy from the midpoint probes", () => {
    expect(validation.probeCount).toBe(HORIZONS_BAKED.count - 1);
    expect(validation.probeOffsetSec).toBe(10800); // grid midpoints
    expect(validation.maxSunAngErrDeg).toBeLessThan(0.005);
    expect(validation.maxEarthAngErrDeg).toBeLessThan(0.005);
    expect(validation.maxSunDistErrKm).toBeLessThan(100);
    expect(validation.maxEarthDistErrKm).toBeLessThan(5);
  });

  it("covers exactly the mission window and nothing outside", () => {
    expect(bakedCovers(bakedStartMs)).toBe(true);
    expect(bakedCovers(bakedEndMs)).toBe(true);
    expect(bakedCovers(bakedStartMs - 1)).toBe(false);
    expect(bakedCovers(bakedEndMs + 1)).toBe(false);
    expect(bakedIcrf(bakedStartMs - 3600e3)).toBeNull();
    expect(bakedSkyState(bakedEndMs + 3600e3)).toBeNull();
  });
});

describe("ephemerisAgreement (analytic model vs baked JPL)", () => {
  it("keeps the model within the validation row's acceptance bound over 2026", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const t1 = Date.parse("2027-01-01T00:00:00Z");
    const a = ephemerisAgreement(t0, t1, 6 * 3600e3);
    expect(a.samples).toBeGreaterThan(1000);
    // Both sides share the IAU ME rotation, so this is the raw state-vector
    // difference. Accept bound of the ephemerisJpl row: 0.05°.
    expect(a.maxAngErrDeg).toBeLessThan(0.05);
    expect(a.maxAngErrDeg).toBeGreaterThan(0); // it measures something real
    expect(a.maxSunAngErrDeg).toBeLessThanOrEqual(a.maxAngErrDeg);
    expect(a.maxEarthAngErrDeg).toBeLessThanOrEqual(a.maxAngErrDeg);
    // Moon-range agreement: sub-0.5% of the distance.
    expect(a.maxEarthDistErrKm).toBeLessThan(2000);
    expect(a.samples).toBe(t1 / (6 * 3600e3) - t0 / (6 * 3600e3) + 1);
  });

  it("classifies as agreement in the published metric table", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const a = ephemerisAgreement(t0, t0 + 30 * 86400e3, 6 * 3600e3);
    const rows = buildValidationRows({ ephemerisJpl: a.maxAngErrDeg });
    const row = rows.find((r) => r.metric.id === "ephemerisJpl")!;
    expect(row.status).toBe("pass");
    expect(row.computed).toBe(a.maxAngErrDeg);
    expect(row.delta).toBeCloseTo(a.maxAngErrDeg - 0.05, 12);
  });
});
