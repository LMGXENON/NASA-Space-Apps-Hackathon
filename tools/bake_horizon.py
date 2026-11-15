#!/usr/bin/env python3
"""
bake_horizon.py — precompute the horizon map (PRD Part B §4.3).

For each AOI texel and each of N azimuths, stores the maximum curvature-corrected
elevation angle of the terrain horizon, quantized to 1 byte:
    byte = clamp(round((theta_deg - THETA_MIN) / THETA_STEP), 0, 255)

Layout: horizon_h2.bin = N/4 layers of PX*PX RGBA (layer = az//4, component = az&3),
matching the GLSL sampler2DArray lookup in TerrainMaterial.

Optimized with numpy: at each march distance d, all texels and all azimuths are
evaluated as array ops (~30 distances for the synthetic AOI). Runtime ≈ seconds.

Usage: python3 tools/bake_horizon.py
"""
import json
import math
import os
import struct
import sys
import zlib

import numpy as np

N_AZ = 64
THETA_MIN = -10.0
THETA_STEP = 0.25
R_MOON = 1_737_400.0
# Observer height above terrain [m] (PRD FR-R7: classes 0, 2, 10 m).
# Usage: python3 tools/bake_horizon.py [H_OBS]   (default 2)
H_OBS = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
BAKE_PX = 512          # horizon map resolution (quality tier "Balanced", PRD §8)
STEP_FACTOR = 0.02     # ds = max(2*texel, STEP_FACTOR*d)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "apps", "web", "public", "data", "v1")


def read_png_rgb(path):
    with open(path, "rb") as f:
        data = f.read()
    pos = 8
    w = h = 0
    idat = b""
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h = struct.unpack(">II", payload[:8])
        elif tag == b"IDAT":
            idat += payload
        elif tag == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * 3
    out = bytearray(w * h * 3)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(3, stride):
                line[i] = (line[i] + line[i - 3]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - 3] if i >= 3 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - 3] if i >= 3 else 0
                b = prev[i]
                c = prev[i - 3] if i >= 3 else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, bytes(out)


def main():
    with open(os.path.join(DATA_DIR, "meta.json")) as f:
        meta = json.load(f)
    px = meta["aoi"]["px"]
    texel = meta["aoi"]["texelM"]
    xmin, ymin = meta["aoi"]["bounds"][0], meta["aoi"]["bounds"][1]

    _, _, rgb = read_png_rgb(os.path.join(DATA_DIR, "height.png"))
    arr = np.frombuffer(rgb, dtype=np.uint8).reshape(px, px, 3).astype(np.float64)
    heights = ((meta["height"]["offset"]
               + (arr[:, :, 0] * 65536 + arr[:, :, 1] * 256 + arr[:, :, 2]) * 0.01)).astype(np.float32)  # [y, x] meters
    print(f"DEM {px}x{px} texel {texel:.1f} m  h {heights.min():.0f}..{heights.max():.0f} m", flush=True)

    # Downsample the horizon bake to BAKE_PX (block mean) — the shader samples
    # the horizon array by uv, so its grid need not match the height texture.
    if BAKE_PX != px:
        f = px // BAKE_PX
        heights = heights.reshape(BAKE_PX, f, BAKE_PX, f).mean(axis=(1, 3))
        px = BAKE_PX
        texel = texel * f
        print(f"bake grid {px}x{px} texel {texel:.1f} m", flush=True)

    # Texel-center world coords, [px, px] (float32 to halve memory)
    coords = (xmin + (np.arange(px) + 0.5) * texel).astype(np.float32)
    X = np.tile(coords, (px, 1))          # X[y, x]
    Y = np.tile(coords.reshape(px, 1), (1, px))  # Y[y, x]

    ho = (heights + H_OBS).astype(np.float32)  # observer height per texel

    # Azimuth unit vectors: az 0 = +Y, toward +X (matches frames.ts)
    azs = np.arange(N_AZ) * 2 * np.pi / N_AZ
    sin_az = np.sin(azs)  # [az]
    cos_az = np.cos(azs)

    # Distance march: ds = max(2*texel, STEP_FACTOR*d) up to the AOI radius
    MAX_D = 30_000.0
    ds = [2 * texel]
    while ds[-1] < MAX_D:
        ds.append(ds[-1] + max(2 * texel, STEP_FACTOR * ds[-1]))
    D = np.array(ds)  # [nD]
    print(f"march: {len(D)} distance steps to {MAX_D/1000:.0f} km", flush=True)

    best = np.full((N_AZ, px, px), -np.inf, dtype=np.float32)  # [az, y, x]

    # Curvature correction per (d, ht): theta = atan2((R+ht)cos a - (R+ho), (R+ht) sin a)
    # Chunk azimuths to bound memory; float32 throughout.
    R = R_MOON
    AZ_CHUNK = 8
    for di, d in enumerate(D):
        a = d / R
        ca, sa = np.float32(math.cos(a)), np.float32(math.sin(a))
        for az0 in range(0, N_AZ, AZ_CHUNK):
            azs_sl = slice(az0, az0 + AZ_CHUNK)
            n = az0 + AZ_CHUNK - az0
            sx = X[None, :, :] + np.float32(d) * sin_az[azs_sl, None, None]
            sy = Y[None, :, :] + np.float32(d) * cos_az[azs_sl, None, None]
            fx = (sx - xmin) / np.float32(texel) - np.float32(0.5)
            fy = (sy - ymin) / np.float32(texel) - np.float32(0.5)
            x0 = np.floor(fx).astype(np.int32); y0 = np.floor(fy).astype(np.int32)
            valid = (x0 >= 0) & (y0 >= 0) & (x0 <= px - 2) & (y0 <= px - 2)
            x0c = np.clip(x0, 0, px - 2); y0c = np.clip(y0, 0, px - 2)
            tx = (fx - x0c).astype(np.float32); ty = (fy - y0c).astype(np.float32)
            H = heights
            h00 = H[y0c, x0c]; h10 = H[y0c, x0c + 1]
            h01 = H[y0c + 1, x0c]; h11 = H[y0c + 1, x0c + 1]
            ht = (h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty)
                  + h01 * (1 - tx) * ty + h11 * tx * ty)
            th = np.arctan2((np.float32(R) + ht) * ca - (np.float32(R) + ho[None, :, :]),
                            (np.float32(R) + ht) * sa)
            th = np.where(valid, th, np.float32(-np.inf))
            np.maximum(best[azs_sl], th, out=best[azs_sl])
        if di % 10 == 0:
            print(f"  d = {d/1000:5.1f} km", flush=True)

    # Quantize: [az, y, x] -> bytes, pack to [layer, y, x, 4comp]
    deg = np.degrees(best)
    q = np.round((deg - THETA_MIN) / THETA_STEP)
    q = np.clip(q, 0, 255).astype(np.uint8)  # [az, y, x]

    n_layers = N_AZ // 4
    packed = np.zeros((n_layers, px, px, 4), dtype=np.uint8)
    for az in range(N_AZ):
        packed[az // 4, :, :, az % 4] = q[az]
    out = packed.tobytes(order="C")

    fname = f"horizon_h{H_OBS:g}.bin"
    path = os.path.join(DATA_DIR, fname)
    with open(path, "wb") as f:
        f.write(out)
    print(f"{fname}: {len(out)/1e6:.1f} MB, {N_AZ} az, {n_layers} layers -> {path}", flush=True)

    # Record the bake grid size in meta.json for the loader
    meta["horizon"]["variants"][f"{H_OBS:g}"] = fname
    meta["horizon"]["px"] = px
    meta["horizon"]["maxDistanceM"] = MAX_D
    meta["horizon"]["hObsM"] = H_OBS
    with open(os.path.join(DATA_DIR, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("meta.json updated", flush=True)


if __name__ == "__main__":
    main()
