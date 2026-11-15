/**
 * Minimal ("lite") GeoTIFF writer — PRD FR-R8 (export heatmap PNG / CSV / GeoTIFF-lite).
 *
 * Scope is deliberately narrow, because the PRD lists `geotiff.js` as a DEV-TOOLS-ONLY
 * dependency (Part C libraries table) and the runtime must stay dependency-free:
 *
 *   - Baseline TIFF 6.0, little-endian, single strip, no compression, no overviews.
 *   - 32-bit IEEE float samples, chunky planar configuration.
 *   - Georeferencing by ModelPixelScale + ModelTiepoint plus a 4-key GeoKeyDirectory
 *     (GTModelType / GTRasterType / PCSCitation / ProjectedCSType) so QGIS or GDAL can
 *     place the raster. Anything more (full CRS bodies, no-data masks, tiling) is out.
 *
 * Row order follows TIFF, not the simulation: row 0 of `data` is the TOP row and
 * `originY` is the model Y of the top edge, with pixelScaleY positive downward.
 * Use `flipRowsVertical` to convert the app's y-ascending grids.
 */

/** TIFF field types used here. */
const T_SHORT = 3;
const T_LONG = 4;
const T_DOUBLE = 12;
const T_ASCII = 2;

/** GeoKey ids (GeoTIFF 1.1). */
const GT_MODEL_TYPE = 1024;
const GT_RASTER_TYPE = 1025;
const PCS_CITATION = 3073;
const PROJECTED_CS_TYPE = 3074;
/** 32767 = user-defined projected CRS (the Moon has no EPSG code). */
const USER_DEFINED_CRS = 32767;

export interface GeoTIFFLiteOptions {
  width: number;
  /** Number of rows. */
  height: number;
  /** Samples, interleaved by band, row-major, row 0 = top row. Length = width*height*bands. */
  data: Float32Array;
  /** Samples per pixel (1 = single band). Default 1. */
  bands?: number;
  /** Model X of the left edge of the raster (pixel (0,0) corner). */
  originX: number;
  /** Model Y of the TOP edge of the raster (pixel (0,0) corner, i.e. the grid ymax). */
  originY: number;
  /** Pixel size in model units (positive: TIFF raster rows run downward). */
  pixelScaleX: number;
  pixelScaleY: number;
  /** CRS description, e.g. the PROJ string from meta.json. Stored as PCSCitationGeoKey. */
  citation?: string;
}

interface Field {
  tag: number;
  type: number;
  count: number;
  /** Inline numeric value (count*size <= 4) or the byte offset of the value block. */
  data: number | number[];
}

const TYPE_SIZE: Record<number, number> = { [T_SHORT]: 2, [T_LONG]: 4, [T_DOUBLE]: 8, [T_ASCII]: 1 };

/** Write one field's value block (only called for out-of-line values). */
function writeValues(dv: DataView, offset: number, type: number, values: number[]): void {
  if (type === T_SHORT) {
    for (let i = 0; i < values.length; i++) dv.setUint16(offset + i * 2, values[i]!, true);
  } else if (type === T_LONG) {
    for (let i = 0; i < values.length; i++) dv.setUint32(offset + i * 4, values[i]!, true);
  } else if (type === T_DOUBLE) {
    for (let i = 0; i < values.length; i++) dv.setFloat64(offset + i * 8, values[i]!, true);
  } else if (type === T_ASCII) {
    for (let i = 0; i < values.length; i++) dv.setUint8(offset + i, values[i]!);
  } else {
    throw new Error(`GeoTIFF-lite: unsupported field type ${type}`);
  }
}

const align = (n: number, to: number): number => (n + to - 1) - ((n + to - 1) % to);

/**
 * Encode samples as an uncompressed 32-bit-float GeoTIFF.
 * Returns the file bytes (little-endian TIFF).
 */
export function encodeGeoTIFFLite(opts: GeoTIFFLiteOptions): Uint8Array<ArrayBuffer> {
  const { width, height, data, originX, originY, pixelScaleX, pixelScaleY } = opts;
  const bands = opts.bands ?? 1;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("GeoTIFF-lite: width and height must be positive integers");
  }
  if (!Number.isInteger(bands) || bands <= 0) throw new Error("GeoTIFF-lite: bands must be a positive integer");
  if (data.length !== width * height * bands) {
    throw new Error(
      `GeoTIFF-lite: expected ${width * height * bands} samples for ${width}x${height}x${bands} bands, got ${data.length}`,
    );
  }
  if (!(pixelScaleX > 0) || !(pixelScaleY > 0)) {
    throw new Error("GeoTIFF-lite: pixel scales must be positive (TIFF raster rows run downward)");
  }

  const citation = opts.citation ?? "";
  const asciiBytes: number[] = [];
  for (let i = 0; i < citation.length; i++) asciiBytes.push(citation.charCodeAt(i) & 0xff);
  asciiBytes.push(0); // TIFF ASCII values are NUL-terminated, and the count includes it.

  // GeoKeyDirectory: header (version, revision, minor, numKeys) + numKeys*4 SHORTs.
  const geoKeys = [
    1, 1, 0, 4,
    GT_MODEL_TYPE, 0, 1, 1, // 1 = projected
    GT_RASTER_TYPE, 0, 1, 1, // 1 = PixelIsArea
    PCS_CITATION, 34737, asciiBytes.length, 0, // ASCII value at GeoAsciiParams offset 0
    PROJECTED_CS_TYPE, 0, 1, USER_DEFINED_CRS,
  ];

  // Fields must appear in ascending tag order (TIFF 6.0 §2).
  const fields: Field[] = [
    // ImageWidth / ImageLength
    { tag: 256, type: T_LONG, count: 1, data: width },
    { tag: 257, type: T_LONG, count: 1, data: height },
    { tag: 258, type: T_SHORT, count: bands, data: new Array<number>(bands).fill(32) },
    { tag: 259, type: T_SHORT, count: 1, data: 1 }, // no compression
    { tag: 262, type: T_SHORT, count: 1, data: 1 }, // BlackIsZero
    { tag: 273, type: T_LONG, count: 1, data: 0 }, // strip offset, patched below
    { tag: 277, type: T_SHORT, count: 1, data: bands },
    { tag: 278, type: T_LONG, count: 1, data: height }, // one strip
    { tag: 279, type: T_LONG, count: 1, data: width * height * bands * 4 },
    { tag: 284, type: T_SHORT, count: 1, data: 1 }, // chunky
    { tag: 339, type: T_SHORT, count: bands, data: new Array<number>(bands).fill(3) }, // IEEE float
    { tag: 33550, type: T_DOUBLE, count: 3, data: [pixelScaleX, pixelScaleY, 0] },
    { tag: 33922, type: T_DOUBLE, count: 6, data: [0, 0, 0, originX, originY, 0] },
    { tag: 34735, type: T_SHORT, count: geoKeys.length, data: geoKeys },
    { tag: 34737, type: T_ASCII, count: asciiBytes.length, data: asciiBytes },
  ];

  // Layout: header(8) | IFD | out-of-line values | sample data.
  const ifdOffset = 8;
  const ifdSize = 2 + fields.length * 12 + 4;
  let cursor = align(ifdOffset + ifdSize, 2);
  const offsets = new Map<number, number>();
  for (const f of fields) {
    if (TYPE_SIZE[f.type]! * f.count <= 4) continue;
    const alignment = f.type === T_DOUBLE ? 8 : 2;
    cursor = align(cursor, alignment);
    offsets.set(f.tag, cursor);
    cursor += TYPE_SIZE[f.type]! * f.count;
  }
  const dataOffset = align(cursor, 4);

  const buf = new ArrayBuffer(dataOffset + width * height * bands * 4);
  const dv = new DataView(buf);

  dv.setUint8(0, 0x49); // 'I'
  dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);

  dv.setUint16(ifdOffset, fields.length, true);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const at = ifdOffset + 2 + i * 12;
    const out = offsets.get(f.tag);
    const value = f.tag === 273 ? dataOffset : out !== undefined ? out : f.data;
    dv.setUint16(at, f.tag, true);
    dv.setUint16(at + 2, f.type, true);
    dv.setUint32(at + 4, f.count, true);
    if (typeof value === "number") {
      // Inline values occupy the low bytes of the 4-byte value slot.
      if (f.type === T_SHORT) dv.setUint16(at + 8, value, true);
      else dv.setUint32(at + 8, value, true);
    } else {
      writeValues(dv, at + 8, f.type, value);
    }
    if (out !== undefined) writeValues(dv, out, f.type, f.data as number[]);
  }
  dv.setUint32(ifdOffset + 2 + fields.length * 12, 0, true); // no next IFD

  // Samples: written explicitly little-endian so the output is host-independent.
  for (let i = 0; i < data.length; i++) dv.setFloat32(dataOffset + i * 4, data[i]!, true);

  return new Uint8Array(buf);
}

/**
 * Flip raster rows vertically, converting an app-space grid (row 0 = ymin, y ascending)
 * into TIFF order (row 0 = top = ymax). `data` is interleaved by band and not modified.
 */
export function flipRowsVertical(
  data: Float32Array,
  width: number,
  height: number,
  bands = 1,
): Float32Array {
  const out = new Float32Array(data.length);
  for (let row = 0; row < height; row++) {
    const src = row * width * bands;
    const dst = (height - 1 - row) * width * bands;
    for (let i = 0; i < width * bands; i++) out[dst + i] = data[src + i]!;
  }
  return out;
}
