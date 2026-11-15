import { describe, expect, it } from "vitest";
import {
  DEG2RAD,
  RAD2DEG,
  azEl,
  curvatureElevation,
  gridToLatLon,
  latLonToGrid,
  localFrame,
  v3,
} from "../src/index";

describe("frames", () => {
  it("round-trips polar stereographic grid ↔ lat/lon (PRD §13.1)", () => {
    for (const pair of [
      [-89.9, 0],
      [-89.5, 45],
      [-88, 123],
      [-90, 0],
      [-85, -170],
    ]) {
      const [latDeg, lonDeg] = pair as [number, number];
      const { x, y } = latLonToGrid(latDeg * DEG2RAD, lonDeg * DEG2RAD);
      const back = gridToLatLon(x, y);
      expect(back.latRad * RAD2DEG).toBeCloseTo(latDeg, 6);
      expect(back.lonRad * RAD2DEG).toBeCloseTo(lonDeg, 6);
    }
  });

  it("pins longitude to the central meridian at the projection origin", () => {
    // atan2(0, -0) is +π, which would otherwise report the AOI centre as 180° E.
    const g = gridToLatLon(0, -0);
    expect(g.latRad * RAD2DEG).toBeCloseTo(-90, 12);
    expect(g.lonRad).toBe(0);
  });

  it("gives local frame orthonormality (ME ↔ ENU round trip)", () => {
    const f = localFrame(-89.9 * DEG2RAD, 33 * DEG2RAD);
    const upDotEast = f.up.x * f.east.x + f.up.y * f.east.y + f.up.z * f.east.z;
    expect(upDotEast).toBeCloseTo(0, 12);
    const n = Math.hypot(f.up.x, f.up.y, f.up.z);
    expect(n).toBeCloseTo(1, 12);
  });

  it("curvature: target 100 km away at equal height has θ ≈ −1.65° (small-angle d/2R)", () => {
    // PRD §13.1 lists −2.87° here, but the correct curvature-correct elevation for
    // equal heights is atan2((R)cosα − R, R·sinα) ≈ −d/(2R) = −1.649° at R=1737.4 km.
    // The −2.87° figure does not follow from §3.4; we assert the correct value.
    const th = curvatureElevation(100_000, 0, 0);
    const smallAngle = -(100_000 / (2 * 1_737_400)) * RAD2DEG;
    expect(th * RAD2DEG).toBeCloseTo(smallAngle, 2);
    expect(th * RAD2DEG).toBeCloseTo(-1.65, 1);
  });

  it("az/el of local up is el=90°, az undefined-but-finite", () => {
    const f = localFrame(0, 0);
    const { el } = azEl(f.up, f);
    expect(el).toBeCloseTo(Math.PI / 2);
  });

  it("v3 helper sanity", () => {
    expect(v3(1, 2, 3).x).toBe(1);
  });
});
