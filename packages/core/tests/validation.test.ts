import { describe, expect, it } from "vitest";
import {
  PUBLISHED_METRICS,
  buildValidationRows,
  classifyMetric,
  polarSkyExtremes,
  type PublishedMetric,
} from "../src/index";

const METRIC = PUBLISHED_METRICS.find((m) => m.id === "rimIllumination")!;

describe("validation metrics table", () => {
  it("has unique ids and complete citations", () => {
    const ids = new Set(PUBLISHED_METRICS.map((m) => m.id));
    expect(ids.size).toBe(PUBLISHED_METRICS.length);
    for (const m of PUBLISHED_METRICS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.computedLabel.length).toBeGreaterThan(0);
      expect(m.unit.length).toBeGreaterThan(0);
      expect(m.publishedText.length).toBeGreaterThan(0);
      expect(m.source.length).toBeGreaterThan(0);
      expect(m.sourceUrl).toMatch(/^https:\/\//);
      expect(m.note.length).toBeGreaterThan(0);
    }
  });

  it("keeps the accept window inside the warn window", () => {
    for (const m of PUBLISHED_METRICS) {
      expect(m.accept[0]).toBeGreaterThanOrEqual(m.warn[0]);
      expect(m.accept[1]).toBeLessThanOrEqual(m.warn[1]);
      expect(m.accept[0]).toBeLessThanOrEqual(m.accept[1]);
    }
  });
});

describe("classifyMetric", () => {
  const m: PublishedMetric = METRIC; // accept [70, 93], warn [55, 98]

  it("passes inside the acceptance window", () => {
    expect(classifyMetric(82.5, m)).toBe("pass");
    expect(classifyMetric(70, m)).toBe("pass");
    expect(classifyMetric(93, m)).toBe("pass");
  });

  it("warns between the acceptance and warn windows", () => {
    expect(classifyMetric(60, m)).toBe("warn");
    expect(classifyMetric(95, m)).toBe("warn");
  });

  it("fails outside the warn window", () => {
    expect(classifyMetric(54, m)).toBe("fail");
    expect(classifyMetric(99, m)).toBe("fail");
    expect(classifyMetric(-1, m)).toBe("fail");
  });

  it("reports pending for missing or non-finite values", () => {
    expect(classifyMetric(null, m)).toBe("pending");
    expect(classifyMetric(NaN, m)).toBe("pending");
    expect(classifyMetric(Infinity, m)).toBe("pending");
  });
});

describe("buildValidationRows", () => {
  it("returns every metric in table order, with deltas and status", () => {
    const rows = buildValidationRows({
      ephemerisJpl: 0.01,
      sunElPole: 1.5,
      earthElPole: 6.2,
      rimIllumination: 81,
      floorShadow: 0,
    });
    expect(rows.map((r) => r.metric.id)).toEqual(PUBLISHED_METRICS.map((m) => m.id));
    expect(rows.every((r) => r.status === "pass")).toBe(true);
    const rim = rows.find((r) => r.metric.id === "rimIllumination")!;
    expect(rim.delta).toBeCloseTo(81 - 82.5, 6);
  });

  it("marks rows pending when no value is supplied", () => {
    const rows = buildValidationRows({});
    expect(rows.every((r) => r.status === "pending" && r.computed === null && r.delta === null)).toBe(true);
  });
});

describe("polarSkyExtremes", () => {
  it("keeps the polar Sun under the published axial-tilt bound and the Earth under the orbit tilt", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const t1 = Date.parse("2027-01-01T00:00:00Z");
    const x = polarSkyExtremes(t0, t1, 6 * 3600e3);
    expect(x.samples).toBeGreaterThan(1000);
    // Sun: axis tilt 1.54° + periodic allowance (published accept ceiling 1.84°).
    expect(x.maxSunElDeg).toBeLessThanOrEqual(1.84);
    expect(x.maxSunElDeg).toBeGreaterThan(0.5); // sanity: it actually swings
    // Earth: equator-to-orbit tilt 6.68° + allowance (published accept ceiling 7.18°).
    expect(x.maxEarthElDeg).toBeLessThanOrEqual(7.18);
    expect(x.maxEarthElDeg).toBeGreaterThan(2);
    expect(x.sunElDegMin).toBeLessThan(0);
    expect(x.sunElDegMax).toBeGreaterThan(0);
    expect(x.earthElDegMin).toBeLessThan(0);
    expect(x.earthElDegMax).toBeGreaterThan(0);
  });

  it("classifies against the published table as a pass for the same window", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const x = polarSkyExtremes(t0, t0 + 30 * 86400e3, 12 * 3600e3);
    const rows = buildValidationRows({
      sunElPole: x.maxSunElDeg,
      earthElPole: x.maxEarthElDeg,
    });
    expect(rows.find((r) => r.metric.id === "sunElPole")!.status).toBe("pass");
    expect(rows.find((r) => r.metric.id === "earthElPole")!.status).toBe("pass");
  });
});
