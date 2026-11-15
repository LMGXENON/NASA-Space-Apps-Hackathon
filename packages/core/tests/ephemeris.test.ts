import { describe, expect, it } from "vitest";
import {
  DEG2RAD,
  RAD2DEG,
  skyAzEl,
  skyState,
  lunarSystemState,
  computeLunarOrbitPath,
  getLunarPhaseName,
} from "../src/index";

describe("ephemeris", () => {
  // Sanity values from PRD Part A §7 (Domain Primer):
  it("Sun elevation at the south pole stays within ±1.8° over 2026", () => {
    let maxAbs = 0;
    for (let d = new Date("2026-01-01T00:00Z"); d.getUTCFullYear() === 2026; d = new Date(d.getTime() + 6 * 3600e3)) {
      const sky = skyState(d);
      const { sun } = skyAzEl(sky, -90 * DEG2RAD, 0);
      maxAbs = Math.max(maxAbs, Math.abs(sun.el * RAD2DEG));
    }
    expect(maxAbs).toBeLessThan(1.8);
  });

  it("Earth elevation at the pole stays within ±7° (libration bound)", () => {
    let maxAbs = 0;
    for (
      let d = new Date("2026-01-01T00:00Z");
      d.getUTCFullYear() === 2026;
      d = new Date(d.getTime() + 12 * 3600e3)
    ) {
      const sky = skyState(d);
      const { earth } = skyAzEl(sky, -90 * DEG2RAD, 0);
      maxAbs = Math.max(maxAbs, Math.abs(earth.el * RAD2DEG));
      expect(earth.el * RAD2DEG).toBeGreaterThan(-7.5);
      expect(earth.el * RAD2DEG).toBeLessThan(7.5);
    }
    expect(maxAbs).toBeGreaterThan(2); // sanity: it actually moves
  });

  it("Earth distance stays in the 356,400–406,700 km band", () => {
    const sky = skyState(new Date("2026-06-15T00:00Z"));
    expect(sky.earthDistKm).toBeGreaterThan(356_000);
    expect(sky.earthDistKm).toBeLessThan(407_000);
  });

  it("Sun angular radius ≈ 0.265°, Earth ≈ 0.95°", () => {
    const sky = skyState(new Date("2026-03-10T00:00Z"));
    expect(sky.sunAngRadius * RAD2DEG).toBeCloseTo(0.266, 1);
    expect(sky.earthAngRadius * RAD2DEG).toBeCloseTo(0.95, 1);
  });

  it("Sun azimuth period ≈ 29.53 days (synodic)", () => {
    const azAt = (iso: string) => {
      const sky = skyState(new Date(iso));
      return skyAzEl(sky, -89.9 * DEG2RAD, 10 * DEG2RAD).sun.az;
    };
    // Find a zero-crossing-ish reference: just check the direction repeats after 29.53 d
    const a0 = azAt("2026-02-01T00:00Z");
    const a1 = azAt("2026-03-02T12:45Z"); // +29.53 d
    const diff = Math.abs(((a1 - a0 + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(diff).toBeLessThan(0.05);
  });

  it("Moon completes ~360° orbit around Earth in 27.32 days (sidereal period)", () => {
    const t0 = new Date("2026-03-01T00:00:00Z");
    const s0 = lunarSystemState(t0);
    const t1 = new Date(t0.getTime() + 27.32166 * 86400 * 1000);
    const s1 = lunarSystemState(t1);

    // Ecliptic longitude should complete ~360° and return to approximately same angle
    const diffDeg = Math.abs(((s1.elonDeg - s0.elonDeg + 180) % 360) - 180);
    expect(diffDeg).toBeLessThan(10); // Within ~10° due to anomalistic eccentricity & precession
    expect(s0.distKm).toBeGreaterThan(356_000);
    expect(s0.distKm).toBeLessThan(407_000);
    expect(s0.orbitalSpeedKmS).toBeGreaterThan(0.9);
    expect(s0.orbitalSpeedKmS).toBeLessThan(1.15);
  });

  it("Lunar phases correctly identified and cycle across synodic period", () => {
    expect(getLunarPhaseName(0)).toBe("New Moon");
    expect(getLunarPhaseName(90)).toBe("First Quarter");
    expect(getLunarPhaseName(180)).toBe("Full Moon");
    expect(getLunarPhaseName(270)).toBe("Third Quarter");

    const state = lunarSystemState(new Date("2026-03-01T00:00:00Z"));
    expect(state.phaseName).toBeDefined();
    expect(state.illumFraction).toBeGreaterThanOrEqual(0);
    expect(state.illumFraction).toBeLessThanOrEqual(1);
  });

  it("computeLunarOrbitPath samples one full orbit ring", () => {
    const pts = computeLunarOrbitPath(new Date("2026-03-01T00:00:00Z"), 60);
    expect(pts.length).toBe(60);
    expect(pts[0]!.distKm).toBeGreaterThan(350_000);
    // Inclination elatDeg oscillates within ±5.3°
    const maxLat = Math.max(...pts.map((p) => Math.abs(p.elatDeg)));
    expect(maxLat).toBeGreaterThan(4.5);
    expect(maxLat).toBeLessThan(5.5);
  });
});
