import { describe, expect, it } from "vitest";
import {
  DEG2RAD,
  RAD2DEG,
  R_MOON,
  formatSelenographic,
  globeToLatLon,
  greatCircleDistance,
  globeToME,
  latLonToGlobe,
  latLonToME,
  meToGlobe,
  meToLatLon,
  raySphereIntersect,
  snapToMoonSurface,
  v3,
  wrapLonRad,
} from "../src/index";

const lat = (d: number) => d * DEG2RAD;
const lon = (d: number) => d * DEG2RAD;

describe("globe math", () => {
  it("round-trips selenographic ↔ render-frame Cartesian", () => {
    for (const [la, lo] of [
      [-89.9, 0],
      [-89.5, 45],
      [-60, 123],
      [0, 0],
      [12.5, -170],
      [89, 179],
    ] as [number, number][]) {
      const g = latLonToGlobe(lat(la), lon(lo));
      expect(Math.hypot(g.x, g.y, g.z)).toBeCloseTo(R_MOON, 6);
      const back = globeToLatLon(g);
      expect(back.latRad * RAD2DEG).toBeCloseTo(la, 6);
      expect((((back.lonRad - lon(lo) + Math.PI) % (2 * Math.PI)) - Math.PI) * RAD2DEG).toBeCloseTo(0, 6);
    }
  });

  it("round-trips selenographic ↔ ME-frame Cartesian", () => {
    for (const [la, lo] of [
      [-89.9, 0],
      [45, -30],
      [-85.3, 30],
    ] as [number, number][]) {
      const back = meToLatLon(latLonToME(lat(la), lon(lo)));
      expect(back.latRad * RAD2DEG).toBeCloseTo(la, 6);
      expect(back.lonRad * RAD2DEG).toBeCloseTo(lo, 6);
    }
  });

  it("puts the poles on the right axes in each frame", () => {
    // Render frame: north pole on +Y, south pole on -Y.
    expect(latLonToGlobe(Math.PI / 2, 0).y).toBeCloseTo(R_MOON, 6);
    expect(latLonToGlobe(-Math.PI / 2, 0).y).toBeCloseTo(-R_MOON, 6);
    // ME frame: north pole on +Z.
    expect(latLonToME(Math.PI / 2, 0).z).toBeCloseTo(R_MOON, 6);
  });

  it("meToGlobe is a pure axis swap and preserves lat/lon", () => {
    // The render frame differs only in which axis carries the pole, so the two
    // must agree on the selenographic coordinate after the swap. Globe lighting
    // feeds skyState().sunME through this.
    for (const [la, lo] of [
      [-89.9, 0],
      [23.4, -75],
      [0, 90],
    ] as [number, number][]) {
      const me = latLonToME(lat(la), lon(lo));
      const g = meToGlobe(me);
      const back = globeToLatLon(g);
      expect(back.latRad * RAD2DEG).toBeCloseTo(la, 9);
      expect(back.lonRad * RAD2DEG).toBeCloseTo(lo, 9);
      // Lengths and the round trip through the inverse are preserved.
      expect(Math.hypot(g.x, g.y, g.z)).toBeCloseTo(R_MOON, 6);
      expect(globeToME(g)).toEqual(me);
    }
  });

  it("ray-sphere intersection hits the near face and misses outside the disc", () => {
    // Straight in along -X from 2R above the (lat 0, lon 0) point.
    const o = v3(2 * R_MOON, 0, 0);
    const t = raySphereIntersect(o, v3(-1, 0, 0));
    expect(t).toBeCloseTo(R_MOON, 3);
    // Tangent-ish miss: 1.5R offset parallel to X passes above the sphere.
    expect(raySphereIntersect(v3(0, 1.5 * R_MOON, -R_MOON), v3(1, 0, 0))).toBeNull();
    // Zero-length direction is a miss, not NaN.
    expect(raySphereIntersect(o, v3(0, 0, 0))).toBeNull();
  });

  it("finds the far surface when the origin is inside the sphere", () => {
    const t = raySphereIntersect(v3(0, 0, 0), v3(0, 1, 0));
    expect(t).toBeCloseTo(R_MOON, 6);
  });

  it("snapToMoonSurface lands exactly on the requested coordinate", () => {
    const s = snapToMoonSurface(lat(-89.6), lon(135), 10_000);
    expect(s.distance).toBeCloseTo(10_000, 3);
    expect(s.latRad * RAD2DEG).toBeCloseTo(-89.6, 6);
    expect(s.lonRad * RAD2DEG).toBeCloseTo(135, 6);
    // Normal is the outward radial unit vector.
    expect(Math.hypot(s.normal.x, s.normal.y, s.normal.z)).toBeCloseTo(1, 9);
    expect(s.point.y / Math.hypot(s.point.x, s.point.y, s.point.z)).toBeCloseTo(s.normal.y, 9);
  });

  it("great-circle distance matches the small-angle arc", () => {
    // 1° of latitude at the pole ≈ π/180 · R.
    const d = greatCircleDistance(lat(-89.5), 0, lat(-88.5), 0);
    expect(d).toBeCloseTo((Math.PI / 180) * R_MOON, 3);
    // Half the equator.
    expect(greatCircleDistance(0, 0, 0, 180 * DEG2RAD)).toBeCloseTo(Math.PI * R_MOON, 3);
  });

  it("wraps longitude into (-180°, +180°]", () => {
    expect(wrapLonRad(190 * DEG2RAD) * RAD2DEG).toBeCloseTo(-170, 9);
    expect(wrapLonRad(-190 * DEG2RAD) * RAD2DEG).toBeCloseTo(170, 9);
    expect(wrapLonRad(180 * DEG2RAD) * RAD2DEG).toBeCloseTo(180, 9);
  });

  it("formats coordinates the way LRO/JPL products do", () => {
    expect(formatSelenographic(lat(-89.9), lon(0))).toBe("89.900° S | 0.000° E");
    expect(formatSelenographic(lat(12.5), lon(-45))).toBe("12.500° N | 45.000° W");
  });
});
