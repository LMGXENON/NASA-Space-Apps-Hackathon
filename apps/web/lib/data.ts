/**
 * Data layer (PRD Part B §4, C.6): fetch meta.json, decode Terrain-RGB heights
 * into a Float32Array heightfield for workers, and fetch horizon .bin.
 */

/**
 * Structured DEM provenance (written by tools/prep_dem.py + tools/fetch_lola.py,
 * surfaced by the Method panel). `mode` is "lola" for the shipped real data;
 * "synthetic"/"geotiff" carry fewer fields.
 */
export interface DemProvenance {
  mode: "lola" | "synthetic" | "geotiff" | string;
  product?: string;
  datasetId?: string;
  instrument?: string;
  producer?: string;
  sourceUrl?: string;
  labelUrl?: string;
  acquired?: string;
  retrieved?: string;
  mapScaleM?: number;
  projection?: string;
  scaling?: string;
  resample?: string;
  aoiM?: [number, number, number, number];
  texelM?: number;
  credits?: string;
  note?: string;
  generator?: string;
  source?: string;
  /** USGS nomenclature for the primary feature in the AOI. */
  nomenclature?: {
    name: string;
    centerLatDeg: number;
    centerLonDeg: number;
    diameterKm: number;
    source: string;
    sourceUrl: string;
  };
  /** Offline rim-fit verification that the grid is registered where it claims. */
  registration?: {
    fitCenterGridM: [number, number];
    fitCenterLatLonDeg: [number, number];
    fitDeltaFromNomenclatureM: number;
    poleToCenterM: number;
    reliefM: number;
    poleOnRim: boolean;
    ok: boolean;
  };
}

export interface TerrainMeta {
  schema: number;
  dataVersion: string;
  crs: string;
  aoi: { bounds: [number, number, number, number]; px: number; texelM: number };
  height: { encoding: string; offset: number; min: number; max: number };
  context?: unknown;
  horizon: { nAz: number; thetaMinDeg: number; thetaStepDeg: number; layers: number; variants: Record<string, string>; px?: number };
  dem?: DemProvenance;
  credits: string;
}

export type { Heightfield } from "./sceneMath";
import type { Heightfield } from "./sceneMath";

export interface TerrainData {
  meta: TerrainMeta;
  hf: Heightfield;
  /** Raw RGBA of height.png, kept so the GL viewport can build its height
   *  texture without downloading and decoding the same 2.5 MB PNG twice. */
  rgba: Uint8ClampedArray;
  horizon?: ArrayBuffer;
  nAz: number;
  horizonLayers: number;
  horizonPx: number;
}

async function pngToRGBA(buf: ArrayBuffer): Promise<{ w: number; h: number; rgba: Uint8ClampedArray }> {
  // Decode PNG via createImageBitmap + OffscreenCanvas (browser only).
  const blob = new Blob([buf], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { w: bmp.width, h: bmp.height, rgba: img.data };
}

/** Fetch one observer-height horizon variant (PRD FR-R7: h ∈ {0, 2, 10} m). */
export async function loadHorizonVariant(meta: TerrainMeta, hObsM: number): Promise<ArrayBuffer> {
  const variant = meta.horizon.variants[String(hObsM)] ?? Object.values(meta.horizon.variants)[0];
  const binRes = await fetch(`/data/v1/${variant}`);
  if (!binRes.ok) throw new Error(`horizon bin ${variant} failed to load`);
  return binRes.arrayBuffer();
}

export async function loadTerrain(hObsM: number = 2): Promise<TerrainData> {
  const metaRes = await fetch("/data/v1/meta.json");
  if (!metaRes.ok) throw new Error("meta.json failed to load");
  const meta: TerrainMeta = await metaRes.json();

  const pngRes = await fetch("/data/v1/height.png");
  const { w, h, rgba } = await pngToRGBA(await pngRes.arrayBuffer());
  const px = meta.aoi.px;
  if (w !== px || h !== px) throw new Error(`height.png is ${w}x${h}, expected ${px}`);

  const off = meta.height.offset;
  const heights = new Float32Array(px * px);
  for (let i = 0; i < px * px; i++) {
    heights[i] = off + (rgba[4 * i] * 65536 + rgba[4 * i + 1] * 256 + rgba[4 * i + 2]) * 0.01;
  }

  const hf: Heightfield = { px, texelM: meta.aoi.texelM, bounds: meta.aoi.bounds, heights };

  const horizon = await loadHorizonVariant(meta, hObsM);

  return {
    meta,
    hf,
    rgba,
    horizon,
    nAz: meta.horizon.nAz,
    horizonLayers: meta.horizon.layers,
    horizonPx: (meta.horizon as { px?: number }).px ?? px,
  };
}
