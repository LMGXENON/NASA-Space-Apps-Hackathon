/**
 * Numeric verification for apps/web/lib/nasaDataService.ts (PRD spec §4).
 * Lives in core's vitest suite because it is the workspace's only test runner;
 * the checks exercise the web service layer's math and parsing, not core.
 *
 * The live-network checks (JPL HORIZONS round-trip, Moon Trek tile fetch,
 * NASA DONKI space weather) are gated behind NASA_LIVE=1 so the default suite
 * stays offline-safe (api.nasa.gov key optional — DONKI has been keyless since
 * the 2026-09-30 CCMC migration):
 *   NASA_LIVE=1 pnpm test
 */
import { describe, expect, test } from "vitest";
import {
  NasaDataService,
  clampSpaceWeatherWindow,
  computeLinkBudget,
  donkiEventsUrl,
  fallbackEphemeris,
  moonTrekTileUrl,
  parseHorizonsVectors,
  rateSpaceWeather,
  sceneVectorFromMe,
  nasaDataService,
} from "../../../apps/web/lib/nasaDataService";
import { skyState } from "../src/index";

const angleDeg = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
};

describe("nasaDataService verification", () => {
  test("1. parses HORIZONS text-stream vectors into Cartesian coordinates", () => {
    const fixture = ` Revised: 2026-Nov-20
 2461364.500000000 = A.D. 2026-Nov-20 00:00:00.0000 TDB
 X =-3.812952389939868E+05 Y = 3.870541411618267E+04 Z =-2.296729060969319E+04
 LT= 1.282276895223097E+00 RG= 3.842842428050766E+05 RR=-2.373169531602775E-01
 2461364.541666667 = A.D. 2026-Nov-20 01:00:00.0000 TDB
 X =-3.813707632878230E+05 Y = 3.504111642231448E+04 Z =-2.330866866526839E+04
 LT= 1.282124381305751E+00 RG= 3.842317761966631E+05 RR=-4.321002536174429E-01`;
    const rows = parseHorizonsVectors(`\n$$SOE\n${fixture}\n$$EOE\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.x).toBe(-3.812952389939868e5);
    expect(rows[0]!.y).toBe(3.870541411618267e4);
    expect(rows[0]!.z).toBe(-2.296729060969319e4);
    expect(rows[0]!.jdTdb).toBe(2461364.5);
    expect(rows[1]!.x).toBe(-3.81370763287823e5);
    expect(rows[0]!.ltSec!).toBeCloseTo(1.2822768952, 8);
    expect(rows[0]!.rangeKm!).toBeCloseTo(384284.2428, 3);
    // Marker-less streams (legacy dumps) parse identically.
    expect(parseHorizonsVectors(fixture)).toHaveLength(2);
  });

  test.skipIf(!process.env.NASA_LIVE)("2. live JPL HORIZONS vectors scale to the 100-unit scene radius", async () => {
    const live = await nasaDataService.fetchEphemerisData("2026-11-20T00:00:00Z");
    expect(live.source).toBe("horizons");
    expect(live.error).toBeNull();
    const rSun = Math.hypot(live.sunPosition.x, live.sunPosition.y, live.sunPosition.z);
    const rEarth = Math.hypot(live.earthPosition.x, live.earthPosition.y, live.earthPosition.z);
    expect(rSun).toBeCloseTo(100, 9);
    expect(rEarth).toBeCloseTo(100, 9);
    expect(live.earthDistanceKm).toBeGreaterThan(350_000);
    expect(live.earthDistanceKm).toBeLessThan(420_000);
    expect(live.sunDistanceKm).toBeGreaterThan(1.47e8);
    expect(live.sunDistanceKm).toBeLessThan(1.53e8);

    // Axis-order/units check: the parsed ME-frame mapping must agree with the
    // independent @helios/core engine to well under a degree.
    const fb = fallbackEphemeris("2026-11-20T00:00:00Z");
    expect(angleDeg(live.sunPositionKm, fb.sunPositionKm)).toBeLessThan(0.05);
    expect(angleDeg(live.earthPositionKm, fb.earthPositionKm)).toBeLessThan(0.05);
    expect(Math.abs(live.earthDistanceKm - fb.earthDistanceKm)).toBeLessThan(500);
  }, 30_000);

  test("3. fallback ephemeris triggers immediately on failure/timeout", async () => {
    const fail = new NasaDataService({
      fetchFn: (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch,
      timeoutMs: 200,
    });
    const t0 = performance.now();
    const fb = await fail.fetchEphemerisData("2027-06-15T12:00:00Z");
    const elapsed = performance.now() - t0;
    expect(fb.source).toBe("fallback");
    expect(fb.error).toContain("Failed to fetch");
    expect(Math.hypot(fb.sunPosition.x, fb.sunPosition.y, fb.sunPosition.z)).toBeCloseTo(100, 9);
    expect(fb.earthDistanceKm).toBeGreaterThan(350_000);
    expect(fb.earthDistanceKm).toBeLessThan(420_000);
    expect(elapsed).toBeLessThan(250);

    // Hung request → abort → fallback.
    const hang = new NasaDataService({
      fetchFn: ((_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch,
      timeoutMs: 50,
    });
    const fb2 = await hang.fetchEphemerisData("2027-01-01T00:00:00Z");
    expect(fb2.source).toBe("fallback");

    // Deterministic math agrees with the @helios/core ephemeris.
    const sky = skyState(new Date("2027-06-15T12:00:00Z"));
    expect(Math.abs(fb.earthDistanceKm - sky.earthDistKm)).toBeLessThan(1);
  });

  test("4. S-band link budget: FSPL formula, latency = d/c, SNR", () => {
    const b = computeLinkBudget(384_400, 2200);
    const fsplRef = 20 * Math.log10(384_400) + 20 * Math.log10(2200) + 32.44;
    expect(b.fsplDb).toBeCloseTo(fsplRef, 9);
    expect(b.latencySeconds).toBeCloseTo(384_400 / 299_792.458, 12);
    expect(b.snrDb).toBeGreaterThan(0);
    expect(b.snrDb).toBeLessThan(60);

    const far = computeLinkBudget(406_000, 2200);
    expect(far.fsplDb).toBeGreaterThan(b.fsplDb);
    expect(far.snrDb).toBeLessThan(b.snrDb);
    expect(far.latencySeconds).toBeGreaterThan(b.latencySeconds);

    const sband = nasaDataService.calculateLinkBudget(384_400);
    expect(sband.frequencyMhz).toBe(2200);
    expect(sband.fsplDb).toBeCloseTo(fsplRef, 9);
  });

  test.skipIf(!process.env.NASA_LIVE)("5. Moon Trek south-pole LOLA DEM tile URLs match the live WMTS endpoint", async () => {
    expect(moonTrekTileUrl(4, 2, 1)).toBe(
      "https://trek.nasa.gov/tiles/Moon/SP/LRO_LOLA_Gray_SPole875_5mp_v04/1.0.0/default/default028mm/4/1/2.png",
    );
    expect(moonTrekTileUrl(99, -3, -2)).toBe(moonTrekTileUrl(9, 0, 0));
    expect(nasaDataService.getMoonTrekTileUrl(2, 1, 1)).toBe(moonTrekTileUrl(2, 1, 1));
    const res = await fetch(moonTrekTileUrl(2, 1, 1), { method: "HEAD" });
    expect(res.status).toBe(200);
  }, 30_000);

  test("6. ME-frame → scene mapping lands on the 100-unit sphere", () => {
    const v = sceneVectorFromMe({ x: 1, y: 0, z: 0 });
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(-100, 9);
    const u = sceneVectorFromMe({ x: 0.6, y: 0.8, z: 0 });
    expect(Math.hypot(u.x, u.y, u.z)).toBeCloseTo(100, 9);
  });

  test("7. DONKI space-weather rating: Kp storm, watch thresholds, quiet", () => {
    const win = clampSpaceWeatherWindow(
      Date.UTC(2026, 8, 1),
      Date.UTC(2026, 8, 20),
      "epoch",
    );
    const storm = rateSpaceWeather(
      [
        {
          gstID: "GST-1",
          startTime: "2026-09-05T00:00Z",
          allKpIndex: [
            { kpIndex: 3, observedTime: "2026-09-05T01:00Z" },
            { kpIndex: 6, observedTime: "2026-09-05T06:00Z" },
          ],
        },
      ],
      [],
      win,
    );
    expect(storm.level).toBe("storm");
    expect(storm.maxKp).toBe(6);
    expect(storm.gstCount).toBe(1);
    expect(storm.headline).toContain("Kp 6");
    expect(storm.source).toBe("donki");
    expect(storm.mode).toBe("epoch");

    const kpWatch = rateSpaceWeather(
      [{ gstID: "GST-2", startTime: "2026-09-08T00:00Z", allKpIndex: [{ kpIndex: 4, observedTime: "2026-09-08T02:00Z" }] }],
      [],
      win,
    );
    expect(kpWatch.level).toBe("watch");

    const cmeWatch = rateSpaceWeather(
      [],
      [{ activityID: "CME-1", startTime: "2026-09-10T00:00Z", cmeAnalyses: [{ speed: 620 }, { speed: 480 }] }],
      win,
    );
    expect(cmeWatch.level).toBe("watch");
    expect(cmeWatch.fastestCmeKms).toBe(620);
    expect(cmeWatch.headline).toContain("620");

    const quiet = rateSpaceWeather([], [], win);
    expect(quiet.level).toBe("quiet");
    expect(quiet.maxKp).toBeNull();

    // Query shape: YYYY-MM-DD dates on the migrated CCMC DONKI API; the
    // optional api.nasa.gov key rides along when configured.
    expect(donkiEventsUrl("GST", Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20), "abc")).toBe(
      "https://ccmc.gsfc.nasa.gov/DONKI-API/get/GST?startDate=2026-09-01&endDate=2026-09-20&api_key=abc",
    );
    expect(donkiEventsUrl("CME", Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20))).toBe(
      "https://ccmc.gsfc.nasa.gov/DONKI-API/get/CME?startDate=2026-09-01&endDate=2026-09-20",
    );
    const clamped = clampSpaceWeatherWindow(Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1), "latest");
    expect(clamped.endMs).toBe(Date.UTC(2026, 3, 1));
    expect(clamped.endMs - clamped.startMs).toBe(30 * 86_400_000);
    expect(clamped.mode).toBe("latest");
  });

  test("8. DONKI failures degrade to an explicit unavailable report", async () => {
    let calls = 0;
    const counting = ((..._args: Parameters<typeof fetch>) => {
      calls++;
      return Promise.reject(new TypeError("Failed to fetch"));
    }) as typeof fetch;

    // Keyless is allowed (DONKI is keyless since the CCMC migration), so a
    // missing key must not suppress the request — both endpoints are tried.
    const keyless = new NasaDataService({ fetchFn: counting, timeoutMs: 200, apiKey: "" });
    const r0 = await keyless.fetchSpaceWeather(Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20));
    expect(calls).toBe(2);
    expect(r0.source).toBe("unavailable");
    expect(r0.level).toBe("unknown");
    expect(r0.error).toContain("Failed to fetch");

    const fail = new NasaDataService({ fetchFn: counting, timeoutMs: 200, apiKey: "test-key" });
    const r1 = await fail.fetchSpaceWeather(Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20));
    expect(r1.source).toBe("unavailable");
    expect(r1.level).toBe("unknown");
    expect(r1.headline).toContain("unavailable");
    // An unreachable API must never read as "quiet" — that would be a claim.
    expect(r1.level).not.toBe("quiet");
  });

  test.skipIf(!process.env.NASA_LIVE)("9. live NASA DONKI space-weather query", async () => {
    const now = Date.now();
    const r = await nasaDataService.fetchSpaceWeather(now - 30 * 86_400_000, now, "latest");
    expect(r.source).toBe("donki");
    expect(r.error).toBeNull();
    expect(["quiet", "watch", "storm"]).toContain(r.level);
    expect(r.windowStart < r.windowEnd).toBe(true);
    expect(r.windowEnd <= new Date(now + 1000).toISOString()).toBe(true);
  }, 30_000);
});
