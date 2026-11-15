import type { Heightfield } from "../src/index";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROVER_PROFILE,
  DEFAULT_AZ_BINS,
  DEG2RAD,
  RAD2DEG,
  discVisible,
  eclipseOcclusion,
  fsplDb,
  batteryStep,
  linkBudget,
  loadPower,
  solarPower,
  horizonAngleAlong,
  sampleBilinear,
} from "../src/index";

describe("disc visibility (PRD §13.1)", () => {
  it("d=0 → 0.5, d=1 → 1, d=−1 → 0; monotonic", () => {
    const r = 0.265 * DEG2RAD;
    expect(discVisible(0, 0, r)).toBeCloseTo(0.5, 10);
    expect(discVisible(r, 0, r)).toBeCloseTo(1, 6);
    expect(discVisible(-r, 0, r)).toBeCloseTo(0, 6);
    let prev = -1;
    for (let e = -2 * r; e <= 2 * r; e += r / 20) {
      const f = discVisible(e, 0, r);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});

describe("eclipse occlusion", () => {
  it("no overlap when separated, total when concentric equal radii", () => {
    const rS = 0.004;
    expect(eclipseOcclusion(rS * 3, rS, rS)).toBe(0);
    expect(eclipseOcclusion(0, rS, rS)).toBe(1);
  });
  it("partial overlap is between 0 and 1", () => {
    const rS = 0.004;
    const rE = 0.0043; // Earth disc slightly larger: 1.9° vs 0.53° diameter
    const f = eclipseOcclusion(1.2 * rS, rS, rE);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
  });
});

describe("marcher on synthetic terrain", () => {
  const px = 128;
  const texelM = 100;
  const heights = new Float32Array(px * px);
  // A 500 m wall at x=96 texels (grid x = +3200 m):
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      heights[y * px + x] = x === 96 ? 500 : 0;
    }
  }
  const hf: Heightfield = {
    px,
    texelM,
    bounds: [-6400, -6400, 6400, 6400],
    heights,
  };

  it("samples bilinearly", () => {
    expect(sampleBilinear(hf, 0, 0)).toBe(0);
  });

  it("finds the wall to the east (az=90°, offset 500 m) as the horizon", () => {
    // Observer offset from the wall line so the az=90° ray actually crosses it:
    const res = horizonAngleAlong(hf, 0, 500, 0, 90 * DEG2RAD, 15_000);
    expect(res.theta * RAD2DEG).toBeGreaterThan(0);
    expect(res.dHit).toBeCloseTo(3200, -2);
  });

  it("sees open sky to the south (no wall in that direction)", () => {
    const res = horizonAngleAlong(hf, 0, 0, 0, Math.PI, 12_000);
    expect(res.theta * RAD2DEG).toBeLessThan(0.1);
  });
});

describe("battery (PRD §13.1)", () => {
  it("drains to the analytic time at constant load", () => {
    const p = DEFAULT_ROVER_PROFILE;
    // 8000 Wh, 390 W shadow load, discharge eff 0.97 → ~19.9 h
    let e = p.batteryWh;
    const dt = 60;
    const pNet = -390;
    let t = 0;
    while (e > 0 && t < 40 * 3600) {
      e = batteryStep(e, pNet, dt, p);
      t += dt;
    }
    const hours = t / 3600;
    expect(hours).toBeGreaterThan(19);
    expect(hours).toBeLessThan(21);
  });

  it("clamps at full charge and at zero", () => {
    const p = DEFAULT_ROVER_PROFILE;
    expect(batteryStep(p.batteryWh, 500, 60, p)).toBe(p.batteryWh);
    expect(batteryStep(0, -500, 60, p)).toBe(0);
  });
});

describe("link budget (PRD §13.1)", () => {
  it("FSPL spot values: 211.0 / 222.6 / 232.4 dB at 384,400 km", () => {
    const d = 384_400e3;
    expect(fsplDb(d, 2.2e9)).toBeCloseTo(211.0, 0);
    expect(fsplDb(d, 8.4e9)).toBeCloseTo(222.6, 1);
    expect(fsplDb(d, 26e9)).toBeCloseTo(232.4, 0);
  });

  it("blocked link reports blocked and −60 dB margin", () => {
    const r = linkBudget({
      earthDistKm: 384_400,
      fEarth: 0.001,
      band: "X",
      txPowerW: 20,
      txGainDbi: 30,
      pointingLossDb: 1,
    });
    expect(r.blocked).toBe(true);
    expect(r.marginDb).toBe(-60);
  });

  it("clear link has healthy positive margin", () => {
    const r = linkBudget({
      earthDistKm: 384_400,
      fEarth: 1,
      band: "X",
      txPowerW: 20,
      txGainDbi: 30,
      pointingLossDb: 1,
    });
    expect(r.marginDb).toBeGreaterThan(5);
  });
});

describe("power sanity", () => {
  it("horizontal array is nearly useless at el=1.5°, vertical-tracking is not", () => {
    const p = DEFAULT_ROVER_PROFILE;
    const inp = { sunDistAU: 1.0, sunEl: 1.5 * DEG2RAD, sunAz: 0, fSun: 1, heading: 0 };
    const horiz = solarPower({ ...p, arrayMode: "horizontal" }, inp);
    const vert = solarPower({ ...p, arrayMode: "vertical-tracking" }, inp);
    expect(horiz / vert).toBeLessThan(0.05);
    expect(vert).toBeGreaterThan(700);
  });

  it("shadow adds the heater load", () => {
    const p = DEFAULT_ROVER_PROFILE;
    const lit = loadPower(p, { linkOn: false, moving: false, slopeRad: 0, fSun: 1, thetaSunMin: 0.1, speedMps: 1 });
    const dark = loadPower(p, { linkOn: false, moving: false, slopeRad: 0, fSun: 0, thetaSunMin: 0.1, speedMps: 1 });
    expect(dark - lit).toBe(p.loads.heaterShadowW);
  });
});

describe("constants", () => {
  it("az bins default is 64", () => {
    expect(DEFAULT_AZ_BINS).toBe(64);
  });
});
