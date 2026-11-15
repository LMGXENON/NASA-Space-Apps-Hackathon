"""
fetch_lola.py — pull the real LOLA shape data the app's terrain is built from.

Source: MIT LOLA GDR mirror (https://imbrium.mit.edu), product LDEM_875S_20M —
a raw PDS INT16 grid in south polar stereographic (20 m/px, true at the pole,
ME/PA DE421), covering -87.5 deg to the pole. One HTTP Range request grabs the
row band covering the app's 40 x 40 km AOI; an area-weighted resample produces
the 1024^2 AOI grid at 39.0625 m/texel (matching tools/prep_dem.py).

Output: tools/.lola_cache/lola_aoi_1024.bin  (int16, metres above R = 1737.4 km)
        tools/.lola_cache/lola_aoi_1024.json (provenance + registration check)

Registration is verified, not assumed: a rim-circle fit (maximising
annulus-minus-floor mean elevation over a centre search) is compared against the
USGS Gazetteer's Shackleton coordinates (Feature 5450: 89.67 S, 129.78 E,
d = 20.92 km, pole on the rim). A fit that lands > 2 km away fails loudly.

Usage: python3 tools/fetch_lola.py [--check]
"""
import argparse
import json
import math
import os
import time
import urllib.request

import numpy as np

BASE = "https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG"
PRODUCT = "LDEM_875S_20M"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lola_cache")

# --- PDS geometry (from the product's .LBL) ---------------------------------
LINES = 7584
LINE_SAMPLES = 7584
RECORD_BYTES = 15168          # 7584 samples * 2 bytes
SCALING_FACTOR = 0.5          # metres per DN (LABEL: HEIGHT = DN * SCALING_FACTOR)
PROJ_OFFSET = 3791.5          # LINE/SAMPLE_PROJECTION_OFFSET (edge coords)
MAP_SCALE_M = 20.0
DERIVED_MIN_M = -8758 * SCALING_FACTOR
DERIVED_MAX_M = 4743 * SCALING_FACTOR

# --- app AOI (must match prep_dem.py) ---------------------------------------
AOI_HALF_M = 20_000
AOI_PX = 1024
TEXEL_M = (2 * AOI_HALF_M) / AOI_PX   # 39.0625

# USGS Gazetteer of Planetary Nomenclature, Feature 5450 (adopted 1994):
# Shackleton centre -89.67 deg / 129.78 deg E, diameter 20.92 km; the lunar
# south pole passes through the crater rim. A legacy control-network entry on
# the same page (-89.90 / 0.00, 19 km) is the source of the "0 deg E" figures
# that float around the web — do not use it.
NOMENCLATURE = {
    "name": "Shackleton",
    "centerLatDeg": -89.67,
    "centerLonDeg": 129.78,
    "diameterKm": 20.92,
    "source": "USGS Gazetteer of Planetary Nomenclature, Feature 5450",
    "sourceUrl": "https://planetarynames.wr.usgs.gov/Feature/5450",
}
NOM_RADIUS_M = NOMENCLATURE["diameterKm"] * 1000 / 2

BAND_BIN = os.path.join(CACHE, f"{PRODUCT}_aoi_band.bin")
OUT_BIN = os.path.join(CACHE, "lola_aoi_1024.bin")
OUT_JSON = os.path.join(CACHE, "lola_aoi_1024.json")


def fetch_band():
    """One HTTP Range GET for the row band covering app y in [-20, +20] km."""
    # Grid convention (axis_window below): sample edge e = PROJ_OFFSET + x/20,
    # line edge e = PROJ_OFFSET - y/20, so y=+20 km -> 2791.5, y=-20 km -> 4791.5.
    e0 = PROJ_OFFSET - AOI_HALF_M / MAP_SCALE_M
    e1 = PROJ_OFFSET + AOI_HALF_M / MAP_SCALE_M
    r0, r1 = math.floor(e0), math.ceil(e1)      # 2791 .. 4792
    start, end = r0 * RECORD_BYTES, r1 * RECORD_BYTES - 1
    need = end - start + 1
    if os.path.exists(BAND_BIN) and os.path.getsize(BAND_BIN) == need:
        print(f"cache hit {BAND_BIN} ({need / 1e6:.1f} MB)")
        return r0, r1
    url = f"{BASE}/{PRODUCT}.IMG"
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    print(f"fetching rows {r0}..{r1 - 1} ({need / 1e6:.1f} MB) from {url} ...", flush=True)
    t = time.time()
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                if res.status not in (200, 206):
                    raise RuntimeError(f"HTTP {res.status}")
                data = res.read()
            if len(data) != need:
                raise RuntimeError(f"short read {len(data)} != {need}")
            last = None
            break
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {attempt + 1}: {e}", flush=True)
            time.sleep(2 * (attempt + 1))
    if last is not None:
        raise RuntimeError(f"download failed: {last}")
    os.makedirs(CACHE, exist_ok=True)
    tmp = BAND_BIN + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, BAND_BIN)
    print(f"downloaded in {time.time() - t:.1f}s -> {BAND_BIN}")
    return r0, r1


def axis_window(g_lo, g_hi, inv_scale, shift):
    """Per-target-cell source pixel indices (band-relative) and normalised
    area weights for one axis. Cells are the AOI grid edges [g_lo, g_hi].

    A grid coordinate g maps to PDS edge coordinate e = PROJ_OFFSET +
    g*inv_scale; the source pixel index is floor(e) - shift."""
    edges = np.linspace(g_lo, g_hi, AOI_PX + 1)
    idx = np.zeros((AOI_PX, 3), dtype=np.int64)
    w = np.zeros((AOI_PX, 3), dtype=np.float64)
    for i in range(AOI_PX):
        g0, g1 = edges[i], edges[i + 1]
        e_lo, e_hi = (PROJ_OFFSET + g0 * inv_scale, PROJ_OFFSET + g1 * inv_scale)
        if e_lo > e_hi:
            e_lo, e_hi = e_hi, e_lo
        p0 = math.floor(e_lo)
        k = 0
        for p in range(p0, math.floor(e_hi) + 1):
            if k >= 3:
                break
            lo, hi = max(e_lo, p), min(e_hi, p + 1)
            if hi > lo:
                idx[i, k] = p - shift
                w[i, k] = hi - lo
                k += 1
        s = w[i].sum()
        if s > 0:
            w[i] /= s
    return idx, w


def resample(r0, r1):
    """Area-weighted 20 m -> 39.0625 m. Returns metres above R = 1737.4 km."""
    with open(BAND_BIN, "rb") as f:
        raw = f.read()
    band = np.frombuffer(raw, dtype="<i2").reshape(r1 - r0, LINE_SAMPLES)

    # Output grid: row 0 <-> y = -20000 (line edge 4791.5), col 0 <-> x = -20000.
    # Registration check (rim fit) confirms this orientation against USGS
    # nomenclature; do not flip signs here without re-running it.
    c_idx, c_w = axis_window(-AOI_HALF_M, AOI_HALF_M, +1.0 / MAP_SCALE_M, shift=0)
    r_idx, r_w = axis_window(-AOI_HALF_M, AOI_HALF_M, -1.0 / MAP_SCALE_M, shift=r0)

    out = np.zeros((AOI_PX, AOI_PX), dtype=np.float64)
    for a in range(3):
        for b in range(3):
            sel = (r_w[:, a] > 0)[:, None] & (c_w[:, b] > 0)[None, :]
            if not sel.any():
                continue
            vals = band[r_idx[:, a][:, None], c_idx[:, b][None, :]].astype(np.float64)
            out += (r_w[:, a][:, None] * c_w[:, b][None, :]) * np.where(sel, vals, 0)
    return out * SCALING_FACTOR


def grid_axes():
    """Grid coordinates of texel centres [m]. Row 0 <-> y = -20000."""
    c = -AOI_HALF_M + (np.arange(AOI_PX) + 0.5) * TEXEL_M
    return c, c


def verify_registration(h):
    """Rim-circle fit vs nomenclature.

    Scans candidate crater centres and scores each by (mean elevation in a
    9.5-11.5 km annulus) - (mean in a 3-7 km floor disc), i.e. the strongest
    bowl with a rim at Shackleton's radius. The fit centre should reproduce
    USGS Feature 5450 within ~1 km and put the pole on the rim
    (|centre| ~ radius). Runs on a 2x subsample to stay quick.
    """
    x, y = grid_axes()
    X, Y = np.meshgrid(x[::2], y[::2])
    H = h[::2, ::2]
    best = (-np.inf, None)
    for cx in range(2000, 14001, 500):
        for cy in range(-12000, 1, 500):
            d = np.hypot(X - cx, Y - cy)
            ann = H[(d > 9500) & (d < 11500)]
            flo = H[(d > 3000) & (d < 7000)]
            if ann.size < 120 or flo.size < 120:
                continue
            score = float(ann.mean() - flo.mean())
            if score > best[0]:
                best = (score, (cx, cy))
    if best[1] is None:
        raise RuntimeError("registration check: no viable rim fit")
    cx, cy = best[1]
    rho = math.hypot(cx, cy)
    lat = -90.0 + math.degrees(2 * math.atan(rho / (2 * 1_737_400.0)))
    lon = math.degrees(math.atan2(cx, cy)) % 360
    # Nomenclature centre -> grid metres (rho = 2R tan(colat/2), x = rho sin lon).
    nc_rho = 2 * 1_737_400.0 * math.tan(math.radians(90 + NOMENCLATURE["centerLatDeg"]) / 2)
    nc_x = nc_rho * math.sin(math.radians(NOMENCLATURE["centerLonDeg"]))
    nc_y = nc_rho * math.cos(math.radians(NOMENCLATURE["centerLonDeg"]))
    delta_m = math.hypot(cx - nc_x, cy - nc_y)
    result = {
        "fitCenterGridM": [cx, cy],
        "fitCenterLatLonDeg": [round(lat, 3), round(lon, 2)],
        "fitDeltaFromNomenclatureM": round(delta_m, 0),
        "poleToCenterM": round(rho, 0),
        "reliefM": round(best[0], 0),
        "poleOnRim": abs(rho - NOM_RADIUS_M) < 1500,
        "ok": delta_m < 2000 and abs(rho - NOM_RADIUS_M) < 1500,
    }
    print(f"registration: fit centre {cx:+d},{cy:+d} m -> {lat:.3f}S {lon:.2f}E "
          f"(nomenclature {NOMENCLATURE['centerLatDeg']} / {NOMENCLATURE['centerLonDeg']}E)", flush=True)
    print(f"  delta vs USGS Feature 5450: {delta_m:.0f} m  "
          f"(pole-to-centre {rho:.0f} m vs rim radius {NOM_RADIUS_M:.0f} m)", flush=True)
    if not result["ok"]:
        raise RuntimeError(
            f"REGISTRATION CHECK FAILED: rim fit is {delta_m:.0f} m from nomenclature "
            f"or the pole is not on the rim — the row/sample mapping is wrong")
    print("  registration OK (pole on rim, centre matches nomenclature)", flush=True)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="print extra sanity stats")
    args = ap.parse_args()

    r0, r1 = fetch_band()
    grid_m = resample(r0, r1)          # metres above R = 1737.4 km
    grid = np.rint(grid_m).astype(np.int16)
    os.makedirs(CACHE, exist_ok=True)
    grid.tofile(OUT_BIN)

    registration = verify_registration(grid_m)

    provenance = {
        "mode": "lola",
        "product": PRODUCT,
        "datasetId": "LRO-L-LOLA-4-GDR-V1.0",
        "productVersion": "V2.0",
        "instrument": "LRO Lunar Orbiter Laser Altimeter (LOLA)",
        "producer": "NASA/GSFC LOLA team (D. E. Smith)",
        "sourceUrl": f"{BASE}/{PRODUCT}.IMG",
        "labelUrl": f"{BASE}/{PRODUCT}.LBL",
        "acquired": "2009-07-13 .. 2017-02-02",
        "retrieved": time.strftime("%Y-%m-%d"),
        "mapScaleM": MAP_SCALE_M,
        "projection": "south polar stereographic (spherical, true at pole), ME/PA DE421",
        "scaling": "height_m = DN * 0.5 above R = 1737.4 km",
        "storage": "int16 grid, metres above R = 1737.4 km",
        "sourceRangeM": [DERIVED_MIN_M, DERIVED_MAX_M],
        "band": {"rows": [r0, r1], "note": "AOI +-20 km via one HTTP Range request"},
        "resample": f"area-weighted {MAP_SCALE_M:g} m -> {TEXEL_M:g} m ({AOI_PX}^2)",
        "aoiM": [-AOI_HALF_M, -AOI_HALF_M, AOI_HALF_M, AOI_HALF_M],
        "nomenclature": NOMENCLATURE,
        "registration": registration,
        "credits": "LOLA GDR shape map courtesy NASA/GSFC LOLA team; retrieved from imbrium.mit.edu.",
    }
    with open(OUT_JSON, "w") as f:
        json.dump(provenance, f, indent=2)
    print(f"-> {OUT_BIN}  h {int(grid.min())}..{int(grid.max())} m")
    print(f"-> {OUT_JSON}")

    if args.check:
        h = grid_m
        x, y = grid_axes()
        print(f"min {h.min():.0f} m  max {h.max():.0f} m  mean {h.mean():.0f} m")
        k = max(1, h.size // 100)
        flat = np.argsort(h.ravel())[:k]
        yy, xx = np.unravel_index(flat, h.shape)
        print(f"lowest 1% centroid: x={x[xx].mean():+.0f} m  y={y[yy].mean():+.0f} m "
              f"(expect near the nomenclature centre {NOMENCLATURE['centerLonDeg']}E, "
              f"i.e. x>0, y<0)")
        deep = h < (h.min() + 400)
        if deep.any():
            dy, dx = np.nonzero(deep)
            print(f"floor (within 400 m of min) centroid: x={x[dx].mean():+.0f} m "
                  f"y={y[dy].mean():+.0f} m  n={len(dy)}")


if __name__ == "__main__":
    main()
