#!/usr/bin/env python3
"""
prep_ephemeris.py — pre-bake JPL HORIZONS state vectors into the app (PRD Part B §3.2).

The app's ephemeris must be JPL-grade at demo time with no network: browsers
cannot call ssd.jpl.nasa.gov (no CORS header), so live fetching never works in
the deployed static build. This tool bakes the vectors in instead:

  1. Fetches Sun (10) and Earth (399) position vectors as seen from the Moon's
     centre (CENTER 500@301) in the ICRF frame (REF_PLANE=FRAME, VEC_TABLE=1,
     OUT_UNITS=KM-S) — the exact query `horizonsVectorUrl()` builds at runtime,
     over the mission window on a uniform 6 h UTC grid.

  2. Probes the grid's *midpoints* (offset 3 h) with a second pass of exact
     vectors and measures the real interpolation error of the baked table
     (angle + range), so the accuracy the UI claims is measured, not assumed.

  3. Writes packages/core/src/horizonsBakedData.ts (generated — do not edit),
     consumed by packages/core/src/horizons.ts.

Output cadence: 6 h knots, Catmull-Rom interpolation (mirrored exactly in
horizons.ts; cross-checked in tests against the embedded probe samples).
Values are rounded to 0.001 km (1 m) — a ~1e-11 rad direction floor, far below
the measured interpolation error.

Requests are cached in tools/.horizons_cache/ so a re-run only re-aggregates.

Usage:  python3 tools/prep_ephemeris.py [--start 2026-01-01] [--end 2028-01-01]
                                        [--step-hours 6]
"""
import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".horizons_cache")
OUT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "packages", "core", "src", "horizonsBakedData.ts",
)

EPOCH_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*=\s*(A\.D\..*?)\s*$")
XYZ_RE = re.compile(
    r"X\s*=\s*([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)"
    r"\s*Y\s*=\s*([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)"
    r"\s*Z\s*=\s*([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)"
)


def horizons_query(command, start, stop, step):
    """Same query semantics as apps/web/lib/nasaDataService.ts horizonsVectorUrl,
    with a UTC-anchored START (the API accepts a zone tag on START only)."""
    p = urllib.parse.urlencode({
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'",
        "CENTER": "'500@301'",
        "START_TIME": f"'{start} UTC'",
        "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{step}'",
        "REF_PLANE": "'FRAME'",
        "VEC_TABLE": "'1'",
        "OUT_UNITS": "'KM-S'",
        "CSV_FORMAT": "'NO'",
    })
    return f"{HORIZONS_URL}?{p}"


def fetch(url, retries=3):
    """Fetch with cache + retry. Returns the HORIZONS text stream."""
    key = hashlib.sha1(url.encode()).hexdigest()
    cache_file = os.path.join(CACHE_DIR, key + ".json")
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            return json.load(f)["result"]
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60) as res:
                data = json.loads(res.read().decode())
            result = data.get("result")
            if not isinstance(result, str) or "$$SOE" not in result:
                raise RuntimeError(f"HORIZONS error: {data.get('error', 'no $$SOE block')[:200]}")
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(cache_file, "w") as f:
                json.dump({"url": url, "result": result}, f)
            return result
        except Exception as e:  # noqa: BLE001 — retry any transport/parse miss
            last_err = e
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"HORIZONS fetch failed after {retries} tries: {last_err}")


def parse_rows(text):
    """$$SOE block -> list of (jd, label, x, y, z). Mirrors parseHorizonsVectors()."""
    start = text.index("$$SOE")
    end = text.index("$$EOE")
    rows = []
    current = None
    for line in text[start + 5:end].splitlines():
        m = EPOCH_RE.match(line)
        if m and not XYZ_RE.search(line):
            current = (float(m.group(1)), m.group(2).strip())
            continue
        m = XYZ_RE.search(line)
        if m:
            if current is None:
                raise RuntimeError(f"vector line without epoch: {line[:60]}")
            rows.append((current[0], current[1], float(m.group(1)), float(m.group(2)), float(m.group(3))))
            current = None
    return rows


def month_starts(start_iso, end_iso):
    """Chunk boundaries: start, interior month lines, end — no duplicates, so
    every chunk has start < stop even when the window ends on a month line."""
    out = [start_iso]
    y, m = int(start_iso[0:4]), int(start_iso[5:7])
    while True:
        m += 1
        if m == 13:
            y, m = y + 1, 1
        cand = f"{y:04d}-{m:02d}-01 00:00:00"
        if cand >= end_iso:
            break
        out.append(cand)
    out.append(end_iso)
    return out


def add_hours(iso, hours):
    # Parse/format without datetime deps beyond stdlib datetime.
    import datetime as dt
    t = dt.datetime.strptime(iso, "%Y-%m-%d %H:%M:%S") + dt.timedelta(hours=hours)
    return t.strftime("%Y-%m-%d %H:%M:%S")


def fetch_pass(command, bounds, offset_hours, step_hours, label):
    """One fetch pass over the monthly chunks; returns {jd: (x, y, z)}."""
    out = {}
    total = len(bounds) - 1
    for k in range(total):
        start = add_hours(bounds[k], offset_hours)
        stop = add_hours(bounds[k + 1], offset_hours)
        if k == total - 1 and offset_hours != 0:
            # Probe pass: last probe is the final interval midpoint, not the end.
            stop = add_hours(bounds[k + 1], offset_hours - step_hours)
        url = horizons_query(command, start, stop, f"{step_hours}h")
        rows = parse_rows(fetch(url))
        for jd, _, x, y, z in rows:
            out[round(jd, 6)] = (x, y, z)
        print(f"  {label}: chunk {k + 1}/{total}  ({len(rows)} rows, {len(out)} unique)",
              flush=True)
    return out


def catmull(p0, p1, p2, p3, u):
    return 0.5 * (
        2 * p1
        + (-p0 + p2) * u
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
        + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u
    )


def interp_at(vals, f):
    """Catmull-Rom on a uniform grid. vals: flat [x,y,z,...]; f in [0, n-1].
    Edge knots use quadratic-extrapolated ghost points (p(-h) = 3p0-3p1+p2),
    which keeps the window's first/last interval on the same accuracy curve as
    the interior (clamped ghosts measurably degrade those two intervals).
    MUST stay bit-for-bit in spirit with horizons.ts interpolateBaked()."""
    n = len(vals) // 3
    i = math.floor(f)
    if i < 0:
        i = 0
    if i > n - 2:
        i = n - 2
    u = f - i
    out = []
    for c in range(3):
        p0 = vals[3 * max(i - 1, 0) + c]
        p1 = vals[3 * i + c]
        p2 = vals[3 * min(i + 1, n - 1) + c]
        p3 = vals[3 * min(i + 2, n - 1) + c]
        if i == 0:
            p0 = 3 * vals[3 * 0 + c] - 3 * vals[3 * 1 + c] + vals[3 * min(2, n - 1) + c]
        if i == n - 2 and n >= 3:
            p3 = 3 * vals[3 * (n - 1) + c] - 3 * vals[3 * (n - 2) + c] + vals[3 * (n - 3) + c]
        out.append(catmull(p0, p1, p2, p3, u))
    return out


def ang_err_deg(a, b):
    cx = a[1] * b[2] - a[2] * b[1]
    cy = a[2] * b[0] - a[0] * b[2]
    cz = a[0] * b[1] - a[1] * b[0]
    cross = math.sqrt(cx * cx + cy * cy + cz * cz)
    dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    return math.degrees(math.atan2(cross, dot))


def norm(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def ts_number(v):
    """Compact but lossless-enough literal: round to 0.001 km (1 m)."""
    return f"{round(v, 3):.3f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2028-01-01")
    ap.add_argument("--step-hours", type=int, default=6)
    args = ap.parse_args()

    step_h = args.step_hours
    start_iso = f"{args.start} 00:00:00"
    end_iso = f"{args.end} 00:00:00"
    bounds = month_starts(start_iso, end_iso)

    print(f"Baking JPL HORIZONS vectors {args.start} → {args.end} at {step_h} h", flush=True)
    sun_grid = fetch_pass("10", bounds, 0, step_h, "sun grid")
    earth_grid = fetch_pass("399", bounds, 0, step_h, "earth grid")
    sun_probe = fetch_pass("10", bounds, step_h // 2, step_h, "sun probe")
    earth_probe = fetch_pass("399", bounds, step_h // 2, step_h, "earth probe")

    # ---- assemble the uniform grid
    jds = sorted(sun_grid)
    if not jds:
        raise RuntimeError("no rows fetched")
    step_d = step_h / 24.0
    n = len(jds)
    print(f"grid points: {n}", flush=True)
    for k, jd in enumerate(jds):
        if abs(jd - (jds[0] + k * step_d)) > 1e-6:
            raise RuntimeError(f"non-uniform grid at {k}: {jd}")
    if set(jds) != set(round(jd, 6) for jd in earth_grid):
        raise RuntimeError("sun/earth epoch mismatch")

    sun_vals, earth_vals = [], []
    for jd in jds:
        sx, sy, sz = sun_grid[jd]
        ex, ey, ez = earth_grid[jd]
        sun_vals += [sx, sy, sz]
        earth_vals += [ex, ey, ez]

    # ---- probe: measured end-to-end interpolation error (incl. rounding)
    max_sun_ang = max_earth_ang = 0.0
    max_sun_dist = max_earth_dist = 0.0
    probe_jds = sorted(sun_probe)
    samples = []
    sample_ix = {round(i * (len(probe_jds) - 1) / 7) for i in range(8)}
    for k, jd in enumerate(probe_jds):
        f = (jd - jds[0]) / step_d
        si = interp_at(sun_vals, f)
        ei = interp_at(earth_vals, f)
        s_exact, e_exact = sun_probe[jd], earth_probe[jd]
        max_sun_ang = max(max_sun_ang, ang_err_deg(si, s_exact))
        max_earth_ang = max(max_earth_ang, ang_err_deg(ei, e_exact))
        max_sun_dist = max(max_sun_dist, abs(norm(si) - norm(s_exact)))
        max_earth_dist = max(max_earth_dist, abs(norm(ei) - norm(e_exact)))
        if k in sample_ix:
            samples.append((jd, s_exact, e_exact))

    print(f"probes: {len(probe_jds)}", flush=True)
    print(f"max sun  interp error: {max_sun_ang:.6f} deg  {max_sun_dist:.4f} km", flush=True)
    print(f"max earth interp error: {max_earth_ang:.6f} deg  {max_earth_dist:.4f} km", flush=True)

    # ---- write the generated TS module
    def fmt_arr(vals):
        lines = []
        for i in range(0, len(vals), 3):
            lines.append(
                f"    {ts_number(vals[i])},{ts_number(vals[i + 1])},{ts_number(vals[i + 2])},"
            )
        return "\n".join(lines)

    def jd_to_iso(jd):
        # JD (UTC-labelled rows) -> ISO; TDB/UTC offset does not apply to the label.
        import datetime as dt
        epoch = dt.datetime(1858, 11, 17)  # MJD 0
        t = epoch + dt.timedelta(days=jd - 2400000.5)
        return t.strftime("%Y-%m-%dT%H:%M:%SZ")

    sample_lines = []
    for jd, s, e in samples:
        sample_lines.append(
            "    { epochIso: \"" + jd_to_iso(jd) + "\", sun: ["
            + ", ".join(f"{v:.6f}" for v in s) + "], earth: ["
            + ", ".join(f"{v:.6f}" for v in e) + "] },"
        )

    content = f"""/**
 * GENERATED FILE — written by tools/prep_ephemeris.py. Do not edit by hand.
 *
 * JPL HORIZONS (DE441) Sun (10) and Earth (399) state vectors as seen from the
 * Moon's centre (CENTER 500@301), ICRF reference frame (REF_PLANE=FRAME),
 * position-only (VEC_TABLE=1), units km, on a uniform {step_h} h UTC grid from
 * {args.start} to {args.end}. Same query the runtime service builds — baked
 * because ssd.jpl.nasa.gov sends no CORS header, so browsers can never fetch it.
 *
 * `validation` records the *measured* interpolation error of this table
 * (Catmull-Rom between knots, evaluated at every grid midpoint against exact
 * HORIZONS vectors fetched at those epochs) plus raw probe samples the tests
 * re-check against the TypeScript interpolator.
 */
import type {{ HorizonsBakedFile }} from "./horizons";

export const HORIZONS_BAKED: HorizonsBakedFile = {{
  schema: 1,
  generator: "tools/prep_ephemeris.py",
  api: "{HORIZONS_URL}",
  center: "500@301",
  frame: "ICRF",
  startIso: "{jd_to_iso(jds[0])}",
  stepSec: {step_h * 3600},
  count: {n},
  sun: [
{fmt_arr(sun_vals)}
  ],
  earth: [
{fmt_arr(earth_vals)}
  ],
  validation: {{
    probeOffsetSec: {step_h * 1800},
    probeCount: {len(probe_jds)},
    maxSunAngErrDeg: {max_sun_ang:.9f},
    maxEarthAngErrDeg: {max_earth_ang:.9f},
    maxSunDistErrKm: {max_sun_dist:.6f},
    maxEarthDistErrKm: {max_earth_dist:.6f},
    probeSamples: [
{chr(10).join(sample_lines)}
    ],
  }},
}};
"""
    with open(os.path.normpath(OUT_PATH), "w") as f:
        f.write(content)
    print(f"wrote {os.path.normpath(OUT_PATH)}  ({len(content) / 1024:.0f} KiB)", flush=True)


if __name__ == "__main__":
    main()
