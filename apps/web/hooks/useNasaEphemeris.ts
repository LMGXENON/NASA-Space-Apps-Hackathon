"use client";

/**
 * useNasaEphemeris — synchronises mission time and rover placement with the
 * NASA data service and, through reactive state, with the WebGL canvas and the
 * Recharts telemetry panels.
 *
 * - `targetDate` and `roverCoordinates` are reactive dependencies; both default
 *   to live app state (the timeline cursor in `timeStore`, the placed rover in
 *   `uiStore`) so scrubbing the mission date slider drives everything.
 * - Network requests to JPL HORIZONS are debounced (and rate-gated + cached
 *   across all hook consumers) so slider scrubbing never floods the API. While
 *   a request is in flight — and whenever it fails — the deterministic
 *   fallback engine answers instantly, so the UI never stalls.
 * - Returns reactive state objects: `sunPosition` (scene Vector3 for the
 *   Three.js directional light), `earthPosition`, `earthDistanceKm`, `fsplDb`,
 *   `latencySeconds`, `snrDb` and `isLoading`.
 */

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { R_MOON, gridToLatLon, localFrame, type Vec3 } from "@helios/core";
import {
  DEFAULT_FREQUENCY_MHZ,
  bakedEphemeris,
  fallbackEphemeris,
  nasaDataService,
  sceneVectorFromMe,
  type EphemerisData,
  type LinkBudget,
} from "../lib/nasaDataService";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";

export interface UseNasaEphemerisOptions {
  /** ISO date to evaluate; defaults to the mission timeline cursor. */
  targetDate?: string;
  /** Selenographic site [deg]; defaults to the placed rover, else the pole. */
  roverCoordinates?: { latDeg: number; lonDeg: number };
  /** Debounce for network refreshes [ms]. */
  debounceMs?: number;
  /** S-band carrier [MHz] for the link budget. */
  frequencyMhz?: number;
}

export interface NasaEphemerisView {
  /** Sun direction from the site, scaled to the scene's 100-unit radius. */
  sunPosition: THREE.Vector3;
  /** Earth direction from the site, scaled to the scene's 100-unit radius. */
  earthPosition: THREE.Vector3;
  /** Rover-relative Earth range [km] (site position removed). */
  earthDistanceKm: number;
  fsplDb: number;
  latencySeconds: number;
  snrDb: number;
  isLoading: boolean;
  /** "horizons" = JPL data (pre-baked table or live parse), else the model. */
  source: "horizons" | "fallback";
  /** Provenance detail behind `source`. */
  origin: "baked" | "live" | "model";
  error: string | null;
  linkBudget: LinkBudget;
}

// ------------------------------------------------------ shared network layer

/** Epoch-second → result, shared by every hook instance. */
const hourCache = new Map<string, EphemerisData>();
const inflight = new Map<string, Promise<EphemerisData>>();
/** Minimum spacing between real network requests (rate-limit guard). */
const MIN_NET_INTERVAL_MS = 3000;
let lastNetMs = 0;

function loadEpoch(epochSec: number): Promise<EphemerisData> {
  const key = String(epochSec);
  const hit = hourCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const iso = new Date(epochSec * 1000).toISOString();
  const p = nasaDataService
    .fetchEphemerisData(iso)
    .then((d) => {
      hourCache.set(key, d);
      inflight.delete(key);
      if (hourCache.size > 64) {
        const oldest = hourCache.keys().next().value;
        if (oldest !== undefined) hourCache.delete(oldest);
      }
      return d;
    })
    .catch((e: unknown) => {
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, p);
  return p;
}

const DEG2RAD = Math.PI / 180;

/**
 * The NASA ephemeris hook. Debounced, latest-wins, offline-safe.
 */
export function useNasaEphemeris(options: UseNasaEphemerisOptions = {}): NasaEphemerisView {
  const {
    targetDate,
    roverCoordinates,
    debounceMs = 700,
    frequencyMhz = DEFAULT_FREQUENCY_MHZ,
  } = options;

  const tMs = useTimeStore((s) => s.tMs);
  const roverSite = useUiStore((s) => s.roverSite);

  // Reactive date: explicit targetDate wins, otherwise follow the timeline.
  const epochMs = targetDate ? Date.parse(targetDate) : tMs;
  const epochSec = Math.round(epochMs / 1000);

  // Reactive site: explicit roverCoordinates wins, else the placed rover,
  // else the AOI centre (south pole).
  const site = useMemo(() => {
    if (roverCoordinates) {
      return {
        latRad: roverCoordinates.latDeg * DEG2RAD,
        lonRad: roverCoordinates.lonDeg * DEG2RAD,
      };
    }
    if (roverSite) {
      const g = gridToLatLon(roverSite.x, roverSite.y);
      return { latRad: g.latRad, lonRad: g.lonRad };
    }
    return { latRad: -Math.PI / 2, lonRad: 0 };
  }, [roverCoordinates, roverSite]);

  const [remote, setRemote] = useState<{ epochSec: number; data: EphemerisData } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Debounced, rate-gated, latest-wins network refresh. Inside the pre-baked
  // mission window the table already carries the JPL answer (and browsers
  // cannot reach ssd.jpl.nasa.gov anyway), so no request is made at all.
  useEffect(() => {
    let cancelled = false;
    if (bakedEphemeris(epochSec * 1000)) return;
    const gap = Math.max(0, lastNetMs + MIN_NET_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      lastNetMs = Date.now();
      setIsLoading(true);
      loadEpoch(epochSec)
        .then((d) => {
          if (cancelled) return;
          setRemote({ epochSec, data: d });
          setIsLoading(false);
        })
        .catch(() => {
          if (!cancelled) setIsLoading(false);
        });
    }, debounceMs + gap);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [epochSec, debounceMs]);

  // Pre-baked JPL vectors win for mission-window epochs (they *are* JPL data);
  // outside the window a live parse refines the deterministic model.
  const data: EphemerisData =
    bakedEphemeris(epochSec * 1000) ??
    (remote && remote.epochSec === epochSec ? remote.data : fallbackEphemeris(epochSec * 1000));

  return useMemo(() => {
    // Scene-space directions at the site (same ENU mapping the renderer uses).
    const sunUnit = normalize(data.sunPositionKm);
    const earthUnit = normalize(data.earthPositionKm);
    const sunPosition = sceneVectorFromMe(sunUnit, site.latRad, site.lonRad);
    const earthPosition = sceneVectorFromMe(earthUnit, site.latRad, site.lonRad);

    // Rover-relative Earth range: remove the site offset from the Moon centre.
    const up = localFrame(site.latRad, site.lonRad).up;
    const rx = data.earthPositionKm.x - (up.x * R_MOON) / 1000;
    const ry = data.earthPositionKm.y - (up.y * R_MOON) / 1000;
    const rz = data.earthPositionKm.z - (up.z * R_MOON) / 1000;
    const earthDistanceKm = Math.hypot(rx, ry, rz);

    const linkBudget = nasaDataService.calculateLinkBudget(earthDistanceKm, frequencyMhz);
    return {
      sunPosition,
      earthPosition,
      earthDistanceKm,
      fsplDb: linkBudget.fsplDb,
      latencySeconds: linkBudget.latencySeconds,
      snrDb: linkBudget.snrDb,
      isLoading,
      source: data.source,
      origin: data.origin,
      error: data.error,
      linkBudget,
    };
  }, [data, site.latRad, site.lonRad, frequencyMhz, isLoading]);
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}
