#!/usr/bin/env python3
"""
prep_dem.py — build the runtime terrain assets (PRD Part B §4.2).

Three modes:
  1. LOLA mode (the shipped build):
         python3 tools/prep_dem.py --lola
     Reads tools/.lola_cache/lola_aoi_1024.bin — the 1024^2 AOI grid that
     tools/fetch_lola.py pulls straight from the LOLA GDR product
     LDEM_875S_20M (20 m/px polar stereographic, one HTTP Range request,
     area-weighted to 39.0625 m/texel) — and carries its provenance and the
     registration check into meta.json's `dem` block.
  2. GeoTIFF mode: python3 tools/prep_dem.py <input_dem.tif>
     Reads a 16-bit LOLA GeoTIFF (polar stereographic, meters), crops/reprojects
     to the AOI, encodes Terrain-RGB.
  3. Synthetic mode (fallback, no dependencies): generates a physically plausible
     40x40 km Shackleton-centered AOI (21 km crater, ~4.2 km deep, plus rim
     ridges) so the full engine runs end-to-end without a data download.
     Clearly labelled as synthetic in meta.json.

Output: public/data/v1/height.png (Terrain-RGB 24-bit, 0.01 m/LSB),
        public/data/v1/meta.json (schema 1 + `dem` provenance block)
Encode: h = offset + (R*65536 + G*256 + B) * 0.01   [meters]
"""
import json
import math
import os
import struct
import sys
import zlib

R_MOON = 1_737_400.0
AOI_HALF_M = 20_000          # 40 x 40 km AOI
PX = 1024                    # AOI grid resolution
TEXEL_M = (2 * AOI_HALF_M) / PX

CRATER_R = 10_500.0          # Shackleton ≈ 21 km diameter
CRATER_DEPTH = 4_200.0       # ≈ 4.2 km deep
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "web", "public", "data", "v1")
LOLA_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lola_cache", "lola_aoi_1024.bin")
LOLA_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lola_cache", "lola_aoi_1024.json")


# ---------------------------------------------------------------- PNG writer
def write_png(path, w, h, rgb_rows):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rgb_rows)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def encode_height_png(heights, path):
    """heights: list of PX lists of PX floats (meters). Terrain-RGB encode."""
    OFF = 10000.0
    rows = []
    for y in range(PX):
        row = bytearray()
        for x in range(PX):
            v = int(round((heights[y][x] + OFF) / 0.01))
            v = max(0, min(16777215, v))
            row += bytes([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])
        rows.append(bytes(row))
    write_png(path, PX, PX, rows)


# ------------------------------------------------------------ synthetic DEM
def grid_xy(ix, iy):
    x = -AOI_HALF_M + (ix + 0.5) * TEXEL_M
    y = -AOI_HALF_M + (iy + 0.5) * TEXEL_M
    return x, y


def fbm_noise(x, y, seed=7):
    """Deterministic value-ish noise via layered trig (cheap, seeded, smooth)."""
    v = 0.0
    amp = 1.0
    fx, fy = x / 4200.0 + seed, y / 4200.0 - seed * 0.3
    for k in range(4):
        v += amp * math.sin(fx * (1.7 + 0.9 * k) + math.cos(fy * (1.3 + 0.7 * k)))
        v += amp * math.sin(fy * (2.1 + 0.5 * k) - math.cos(fx * (0.9 + 0.6 * k)))
        amp *= 0.5
        fx *= 2.03
        fy *= 1.97
    return v / 2.4


def synthetic_heights():
    heights = []
    for iy in range(PX):
        row = []
        y = -AOI_HALF_M + (iy + 0.5) * TEXEL_M
        for ix in range(PX):
            x = -AOI_HALF_M + (ix + 0.5) * TEXEL_M
            r = math.hypot(x, y)
            h = fbm_noise(x, y) * 140.0

            # Shackleton bowl: smooth paraboloid floor + steep inner wall
            if r < CRATER_R:
                t = r / CRATER_R
                h += -CRATER_DEPTH * (1.0 - t * t) ** 1.6
            # Raised rim just outside the crater
            h += 900.0 * math.exp(-(((r - CRATER_R * 1.02) / (CRATER_R * 0.10)) ** 2))
            # Outer apron falling back to the plain
            if r > CRATER_R:
                h += -600.0 * min(1.0, (r - CRATER_R) / 6000.0)

            # Connecting Ridge — a high ridge through the NE quadrant
            # (ridge line: y = 0.55x + c, width ~1.8 km, crest ~ +1.1 km)
            d = abs(y - 0.55 * x + 3000.0) / math.hypot(1.0, 0.55)
            ridge_r = (x * 0.876 + y * 0.482)
            if 4000.0 < ridge_r < 18000.0:
                crest = 1100.0 * math.exp(-((d / 900.0) ** 2))
                crest *= math.sin(min(1.0, (ridge_r - 4000.0) / 3000.0) * math.pi / 2)
                crest *= math.sin(min(1.0, (18000.0 - ridge_r) / 3000.0) * math.pi / 2)
                h += crest

            # de Gerlache-like secondary crater to the NW
            dx, dy = x + 12000.0, y + 11000.0
            r2 = math.hypot(dx, dy)
            if r2 < 5200.0:
                t2 = r2 / 5200.0
                h += -1500.0 * (1.0 - t2 * t2) ** 1.6
            h += 320.0 * math.exp(-(((r2 - 5300.0) / 500.0) ** 2))

            row.append(h)
        heights.append(row)
    return heights


# ------------------------------------------------------------- LOLA AOI grid
def load_lola_aoi():
    """Load the fetch_lola.py AOI grid (int16 metres) as a PX x PX list of floats,
    plus its provenance dict. Row 0 is grid y = -20 km — the same orientation as
    synthetic_heights()/grid_xy, so no flip is needed."""
    if not os.path.exists(LOLA_BIN):
        raise SystemExit(
            f"{LOLA_BIN} not found — run: python3 tools/fetch_lola.py")
    with open(LOLA_JSON) as f:
        prov = json.load(f)
    with open(LOLA_BIN, "rb") as f:
        raw = f.read()
    if len(raw) != PX * PX * 2:
        raise SystemExit(f"LOLA grid is {len(raw)} bytes, expected {PX * PX * 2}")
    vals = struct.unpack(f"<{PX * PX}h", raw)   # int16 little-endian, metres
    heights = [list(vals[r * PX:(r + 1) * PX]) for r in range(PX)]
    return heights, prov


# --------------------------------------------------------------- real DEM IO
def read_geotiff_16(path):
    """Minimal single-band 16-bit GeoTIFF reader (no GDAL dependency).
    Handles the common case: strip-organized, 1 sample/pixel. Raises on
    anything exotic — use GDAL to pre-convert if so."""
    with open(path, "rb") as f:
        data = f.read()
    bo = "<" if data[:2] == b"II" else ">"
    if struct.unpack(bo + "H", data[2:4])[0] != 42:
        raise ValueError("Not a TIFF")
    ifd_off = struct.unpack(bo + "I", data[4:8])[0]

    TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
    tags = {}
    n = struct.unpack(bo + "H", data[ifd_off:ifd_off + 2])[0]
    for i in range(n):
        e = ifd_off + 2 + i * 12
        tag, typ, cnt = struct.unpack(bo + "HHI", data[e:e + 8])
        val_off = e + 8
        sz = TYPE_SIZE.get(typ, 1) * cnt
        if sz > 4:
            val_off = struct.unpack(bo + "I", data[e + 8:e + 12])[0]
        if cnt == 1 and typ in (3, 4):
            raw = data[val_off:val_off + TYPE_SIZE[typ]]
            tags[tag] = struct.unpack(bo + ("H" if typ == 3 else "I"), raw)[0]
        elif typ == 3 and cnt == 1:
            tags[tag] = struct.unpack(bo + "H", data[val_off:val_off + 2])[0]
        elif typ == 4 and cnt > 1:
            tags[tag] = [struct.unpack(bo + "I", data[val_off + 4 * k:val_off + 4 * k + 4])[0] for k in range(cnt)]
        elif typ == 4:
            tags[tag] = struct.unpack(bo + "I", data[val_off:val_off + 4])[0]
        elif typ == 3:
            tags[tag] = struct.unpack(bo + "H", data[val_off:val_off + 2])[0]

    w, h = tags[256], tags[257]
    bits = tags.get(258, 16)
    if bits not in (8, 16):
        raise ValueError(f"Unsupported bit depth {bits} — pre-convert with GDAL")
    compression = tags.get(259, 1)
    if compression != 1:
        raise ValueError("Compressed TIFF — pre-convert with gdal_translate -co COMPILE=NONE")
    strip_offs = tags[273]
    strip_bytes = tags.get(279)
    if not isinstance(strip_offs, list):
        strip_offs = [strip_offs]
        strip_bytes = [strip_bytes] if not isinstance(strip_bytes, list) else strip_bytes

    fmt = bo + ("H" if bits == 16 else "B")
    ps = 2 if bits == 16 else 1
    buf = bytearray()
    rows_per_strip = tags.get(278, h)
    for so, sb in zip(strip_offs, strip_bytes):
        chunk = data[so:so + sb]
        buf += chunk
    px = struct.unpack(fmt * (w * h), bytes(buf[: w * h * ps]))
    if bits == 16:
        # LOLA polar DEMs: unsigned or signed 16-bit meters
        scale = tags.get(33550)  # ModelPixelScaleTag floats — not read here
        vals = list(px)
    else:
        vals = list(px)
    return w, h, vals


def resample_to_aoi(w, h, vals, xoff_m=0.0, yoff_m=0.0, src_texel_m=None):
    """Nearest-neighbor resample of a full raster to the AOI grid.
    src_texel_m defaults to fitting the whole raster into the AOI."""
    if src_texel_m is None:
        src_texel_m = (2 * AOI_HALF_M) / max(w, h)
    out = []
    for iy in range(PX):
        _, wy = grid_xy(0, iy)
        sy = int((yoff_m + wy - (-AOI_HALF_M)) / src_texel_m + h / 2) if False else None
        row = []
        for ix in range(PX):
            wx, wy = grid_xy(ix, iy)
            # Map AOI meters into source pixel indices (source assumed centered).
            sx = int((wx - xoff_m) / src_texel_m + w / 2)
            sy2 = int(-(wy - yoff_m) / src_texel_m + h / 2)
            sx = max(0, min(w - 1, sx))
            sy2 = max(0, min(h - 1, sy2))
            row.append(float(vals[sy2 * w + sx]))
        out.append(row)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    dem_block = None
    if "--lola" in sys.argv:
        print("LOLA mode: real shape data from tools/fetch_lola.py "
              "(product LDEM_875S_20M)")
        heights, prov = load_lola_aoi()
        src = prov["product"]
        data_version = "2026.11.0-lola"
        credits = (f"Real LOLA shape data: {prov['product']} ({prov['datasetId']}), "
                   f"{prov['producer']}; retrieved {prov['retrieved']} from "
                   "imbrium.mit.edu. Resampled to the 39 m AOI grid; registration "
                   "verified against USGS Gazetteer Feature 5450 (Shackleton).")
        # Structured provenance surfaced by the app's Method panel.
        dem_block = {k: prov[k] for k in (
            "mode", "product", "datasetId", "instrument", "producer",
            "sourceUrl", "labelUrl", "acquired", "retrieved", "mapScaleM",
            "projection", "scaling", "resample", "nomenclature",
            "registration", "credits") if k in prov}
        dem_block["aoiM"] = [-AOI_HALF_M, -AOI_HALF_M, AOI_HALF_M, AOI_HALF_M]
        dem_block["texelM"] = TEXEL_M
    elif len(sys.argv) > 1:
        print(f"Reading GeoTIFF: {sys.argv[1]}")
        w, h, vals = read_geotiff_16(sys.argv[1])
        heights = resample_to_aoi(w, h, vals)
        src = os.path.basename(sys.argv[1])
        data_version = "2026.11.0"
        credits = "LOLA data courtesy of NASA/GSFC/ASU."
        dem_block = {"mode": "geotiff", "source": src}
    else:
        print("Synthetic mode: generating Shackleton-like AOI "
              "(run python3 tools/fetch_lola.py && this script --lola for real data)")
        heights = synthetic_heights()
        src = "synthetic-shackleton-v1"
        data_version = "2026.11.0-synthetic"
        credits = "Synthetic Shackleton-like DEM for demo purposes. "
        dem_block = {
            "mode": "synthetic",
            "generator": "tools/prep_dem.py synthetic_heights()",
            "note": "Procedural Shackleton-like relief (bowl on the grid origin); "
                    "geometry is plausible but not measured terrain.",
        }

    flat_min = min(min(r) for r in heights)
    flat_max = max(max(r) for r in heights)
    height_png = os.path.join(OUT_DIR, "height.png")
    encode_height_png(heights, height_png)

    meta = {
        "schema": 1,
        "dataVersion": data_version,
        "crs": "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +R=1737400 +units=m",
        "aoi": {"bounds": [-AOI_HALF_M, -AOI_HALF_M, AOI_HALF_M, AOI_HALF_M],
                "px": PX, "texelM": TEXEL_M},
        "context": None,
        "height": {"encoding": "terrain-rgb-0.01", "offset": -10000,
                   "min": round(flat_min, 2), "max": round(flat_max, 2)},
        "horizon": {"nAz": 64, "thetaMinDeg": -10, "thetaStepDeg": 0.25, "layers": 16,
                    "variants": {"0": "horizon_h0.bin"}},
        "dem": dem_block,
        "files": {"height.png": src},
        "credits": credits,
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"height.png ({PX}x{PX})  elev {flat_min:.0f}..{flat_max:.0f} m  "
          f"mode {dem_block['mode']}  -> {OUT_DIR}")


if __name__ == "__main__":
    main()
