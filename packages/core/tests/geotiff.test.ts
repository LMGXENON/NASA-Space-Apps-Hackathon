/**
 * FR-R8 (GeoTIFF-lite export): the encoder is verified by an independent,
 * spec-based TIFF reader written here — it never calls back into the encoder.
 */
import { describe, expect, it } from "vitest";
import { encodeGeoTIFFLite, flipRowsVertical } from "../src/geotiff";

const T_SHORT = 3;
const T_LONG = 4;
const T_ASCII = 2;
const T_DOUBLE = 12;

interface Parsed {
  width: number;
  height: number;
  bitsPerSample: number[];
  compression: number;
  photometric: number;
  samplesPerPixel: number;
  rowsPerStrip: number;
  planarConfig: number;
  sampleFormat: number[];
  pixelScale: number[];
  tiepoint: number[];
  geoKeys: number[];
  citation: string;
  stripOffset: number;
  stripBytes: number;
  nextIfd: number;
  /** Samples decoded from the strip, as float32. */
  samples: Float32Array;
}

/** Parse the subset of baseline TIFF that the encoder is allowed to emit. */
function parseTiff(bytes: Uint8Array): Parsed {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint8(0)).toBe(0x49);
  expect(dv.getUint8(1)).toBe(0x49);
  expect(dv.getUint16(2, true)).toBe(42);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);

  const values = (tag: number): { type: number; count: number; at: number } => {
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12;
      if (dv.getUint16(at, true) !== tag) continue;
      const type = dv.getUint16(at + 2, true);
      const count = dv.getUint32(at + 4, true);
      const size = type === T_SHORT ? 2 : type === T_LONG ? 4 : type === T_DOUBLE ? 8 : 1;
      return { type, count, at: size * count <= 4 ? at + 8 : dv.getUint32(at + 8, true) };
    }
    throw new Error(`tag ${tag} missing`);
  };
  const nums = (tag: number): number[] => {
    const { type, count, at } = values(tag);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      if (type === T_SHORT) out.push(dv.getUint16(at + i * 2, true));
      else if (type === T_LONG) out.push(dv.getUint32(at + i * 4, true));
      else if (type === T_DOUBLE) out.push(dv.getFloat64(at + i * 8, true));
      else throw new Error(`tag ${tag} is not numeric`);
    }
    return out;
  };
  const ascii = (tag: number): string => {
    const { count, at } = values(tag);
    let s = "";
    for (let i = 0; i < count; i++) s += String.fromCharCode(dv.getUint8(at + i));
    return s.replace(/\0+$/, "");
  };

  const stripOffset = nums(273)[0]!;
  const stripBytes = nums(279)[0]!;
  const samples = new Float32Array(stripBytes / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = dv.getFloat32(stripOffset + i * 4, true);

  return {
    width: nums(256)[0]!,
    height: nums(257)[0]!,
    bitsPerSample: nums(258),
    compression: nums(259)[0]!,
    photometric: nums(262)[0]!,
    samplesPerPixel: nums(277)[0]!,
    rowsPerStrip: nums(278)[0]!,
    planarConfig: nums(284)[0]!,
    sampleFormat: nums(339),
    pixelScale: nums(33550),
    tiepoint: nums(33922),
    geoKeys: nums(34735),
    citation: ascii(34737),
    stripOffset,
    stripBytes,
    nextIfd: dv.getUint32(ifd + 2 + n * 12, true),
    samples,
  };
}

/** Tags in a TIFF IFD must be in ascending order. */
function tagOrder(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  return Array.from({ length: n }, (_, i) => dv.getUint16(ifd + 2 + i * 12, true));
}

const CITATION = "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +R=1737400 +units=m";

describe("encodeGeoTIFFLite", () => {
  const W = 4;
  const H = 3;
  const data = new Float32Array([
    0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75,
  ]);

  it("writes a baseline TIFF with the expected structural tags", () => {
    const bytes = encodeGeoTIFFLite({
      width: W,
      height: H,
      data,
      originX: -20_000,
      originY: 20_000,
      pixelScaleX: 125,
      pixelScaleY: 125,
      citation: CITATION,
    });
    const p = parseTiff(bytes);
    expect(p.width).toBe(W);
    expect(p.height).toBe(H);
    expect(p.bitsPerSample).toEqual([32]);
    expect(p.compression).toBe(1); // uncompressed
    expect(p.photometric).toBe(1);
    expect(p.samplesPerPixel).toBe(1);
    expect(p.rowsPerStrip).toBe(H);
    expect(p.planarConfig).toBe(1);
    expect(p.sampleFormat).toEqual([3]); // IEEE float
    expect(p.nextIfd).toBe(0);
    expect(tagOrder(bytes)).toEqual([...tagOrder(bytes)].sort((a, b) => a - b));
  });

  it("round-trips the samples and points the strip at exactly them", () => {
    const bytes = encodeGeoTIFFLite({
      width: W,
      height: H,
      data,
      originX: -20_000,
      originY: 20_000,
      pixelScaleX: 125,
      pixelScaleY: 125,
    });
    const p = parseTiff(bytes);
    expect(p.stripBytes).toBe(W * H * 4);
    expect(p.stripOffset + p.stripBytes).toBeLessThanOrEqual(bytes.byteLength);
    expect(Array.from(p.samples)).toEqual(Array.from(data));
  });

  it("georeferences with pixel scale, tiepoint and GeoKeys", () => {
    const bytes = encodeGeoTIFFLite({
      width: W,
      height: H,
      data,
      originX: -20_000,
      originY: 20_000,
      pixelScaleX: 125,
      pixelScaleY: 125,
      citation: CITATION,
    });
    const p = parseTiff(bytes);
    expect(p.pixelScale).toEqual([125, 125, 0]);
    expect(p.tiepoint).toEqual([0, 0, 0, -20_000, 20_000, 0]);
    // [version, revision, minor, numKeys, ...keys]
    expect(p.geoKeys.slice(0, 4)).toEqual([1, 1, 0, 4]);
    const key = (id: number) => {
      for (let i = 4; i < p.geoKeys.length; i += 4) if (p.geoKeys[i] === id) return p.geoKeys.slice(i, i + 4);
      throw new Error(`geokey ${id} missing`);
    };
    expect(key(1024)).toEqual([1024, 0, 1, 1]); // projected
    expect(key(1025)).toEqual([1025, 0, 1, 1]); // PixelIsArea
    expect(key(3074)).toEqual([3074, 0, 1, 32767]); // user-defined CRS
    const cite = key(3073)!;
    expect(cite[1]).toBe(34737); // value lives in GeoAsciiParams
    expect(cite[2]).toBe(CITATION.length + 1); // NUL included
    expect(p.citation).toBe(CITATION);
  });

  it("writes multi-band rasters chunky (interleaved), as the duty map exports", () => {
    const bands = 3;
    const interleaved = new Float32Array(W * H * bands);
    for (let i = 0; i < interleaved.length; i++) interleaved[i] = i / 10;
    const bytes = encodeGeoTIFFLite({
      width: W,
      height: H,
      data: interleaved,
      bands,
      originX: -20_000,
      originY: 20_000,
      pixelScaleX: 125,
      pixelScaleY: 125,
    });
    const p = parseTiff(bytes);
    expect(p.samplesPerPixel).toBe(3);
    expect(p.bitsPerSample).toEqual([32, 32, 32]);
    expect(p.sampleFormat).toEqual([3, 3, 3]);
    expect(p.planarConfig).toBe(1);
    expect(p.stripBytes).toBe(W * H * bands * 4);
    expect(Array.from(p.samples)).toEqual(Array.from(interleaved));
  });

  it("lays out out-of-line values inside the file, on even offsets, before the strip", () => {
    const bytes = encodeGeoTIFFLite({
      width: W,
      height: H,
      data,
      originX: -20_000,
      originY: 20_000,
      pixelScaleX: 125,
      pixelScaleY: 125,
      citation: CITATION,
    });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ifd = dv.getUint32(4, true);
    const n = dv.getUint16(ifd, true);
    const stripOffset = parseTiff(bytes).stripOffset;
    const blocks: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12;
      const type = dv.getUint16(at + 2, true);
      const count = dv.getUint32(at + 4, true);
      const size = type === T_SHORT ? 2 : type === T_LONG ? 4 : type === T_DOUBLE ? 8 : 1;
      if (size * count <= 4) continue; // inline, lives in the entry itself
      const off = dv.getUint32(at + 8, true);
      expect(off % 2).toBe(0); // TIFF: value offsets are word-aligned
      expect(off).toBeGreaterThanOrEqual(8 + 2 + n * 12 + 4);
      expect(off + size * count).toBeLessThanOrEqual(stripOffset);
      blocks.push([off, off + size * count]);
    }
    blocks.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]![0]).toBeGreaterThanOrEqual(blocks[i - 1]![1]);
    // Strip data starts after every value block and ends inside the file.
    expect(stripOffset).toBeGreaterThanOrEqual(blocks.at(-1)![1]);
    const p = parseTiff(bytes);
    expect(stripOffset + p.stripBytes).toBeLessThanOrEqual(bytes.byteLength);
  });

  it("rejects malformed input instead of emitting a broken raster", () => {
    const base = { width: W, height: H, data, originX: 0, originY: 0, pixelScaleX: 1, pixelScaleY: 1 };
    expect(() => encodeGeoTIFFLite({ ...base, width: 0 })).toThrow(/positive integers/);
    expect(() => encodeGeoTIFFLite({ ...base, bands: 3 })).toThrow(/expected 36 samples/);
    expect(() => encodeGeoTIFFLite({ ...base, pixelScaleY: -1 })).toThrow(/positive/);
  });
});

describe("flipRowsVertical", () => {
  it("converts a y-ascending grid into TIFF top-down order, band-interleaved", () => {
    // 2x2, 2 bands: row 0 = [a0,b0,a1,b1] (ymin), row 1 = [c0,d0,c1,d1] (ymax)
    const grid = new Float32Array([1, 11, 2, 12, 3, 13, 4, 14]);
    const flipped = flipRowsVertical(grid, 2, 2, 2);
    expect(Array.from(flipped)).toEqual([3, 13, 4, 14, 1, 11, 2, 12]);
    expect(Array.from(grid)).toEqual([1, 11, 2, 12, 3, 13, 4, 14]); // input untouched
  });

  it("keeps the raster size and the value set unchanged", () => {
    const grid = new Float32Array(3 * 5);
    for (let i = 0; i < grid.length; i++) grid[i] = i;
    const flipped = flipRowsVertical(grid, 3, 5);
    expect(flipped.length).toBe(grid.length);
    expect([...flipped].sort((a, b) => a - b)).toEqual([...grid].sort((a, b) => a - b));
  });
});
