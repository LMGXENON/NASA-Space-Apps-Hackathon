"use client";

/**
 * CommLinkRaycaster — direct line-of-sight test for the S-band Earth link.
 *
 * Given the live `earthPosition` vector (from `useNasaEphemeris`) it tests,
 * at the rover site, whether terrain peaks block the rover→Earth ray. The
 * baked horizon map is the authoritative terrain-peak occlusion model — the
 * same one the classified shader, the worker and the Earth laser use — so the
 * blocked/clear verdict always agrees with the heat classification and the
 * analytics. The verdict publishes to `useCommLinkStore` for the telemetry
 * panel, and the rendered Earth laser draws the matching ray in the canvas.
 */

import { useEffect } from "react";
import * as THREE from "three";
import { create } from "zustand";
import { RAD2DEG } from "@helios/core";
import { horizonAngleBin } from "../lib/sceneMath";
import { useNasaEphemeris } from "../hooks/useNasaEphemeris";
import { useUiStore } from "../store/uiStore";

export interface CommLinkState {
  /** True once terrain + rover exist and the test has run. */
  checked: boolean;
  /** True when a terrain peak blocks direct LoS to Earth. */
  blocked: boolean;
  /** Earth-ray elevation at the site [deg]. */
  elevationDeg: number;
  /** Ridge (horizon) elevation along that azimuth [deg]. */
  horizonDeg: number;
}

export const useCommLinkStore = create<CommLinkState>(() => ({
  checked: false,
  blocked: false,
  elevationDeg: 0,
  horizonDeg: 0,
}));

export default function CommLinkRaycaster({ earthPosition }: { earthPosition: THREE.Vector3 }) {
  const terrain = useUiStore((s) => s.terrain);
  const site = useUiStore((s) => s.roverSite);

  useEffect(() => {
    const publish = (next: CommLinkState) =>
      // Return the previous state object when nothing changed so per-frame
      // ephemeris updates never re-render the telemetry panel (PRD §11).
      useCommLinkStore.setState((s) =>
        s.checked === next.checked &&
        s.blocked === next.blocked &&
        s.elevationDeg === next.elevationDeg &&
        s.horizonDeg === next.horizonDeg
          ? s
          : next,
      );

    if (!terrain || !site || !terrain.horizon) {
      publish({ checked: false, blocked: false, elevationDeg: 0, horizonDeg: 0 });
      return;
    }
    // Scene axes: X = grid east, Z = −grid north, Y = up → invert the ENU
    // mapping used to build the vector (matches the rendered Earth laser).
    const len = Math.hypot(earthPosition.x, earthPosition.y, earthPosition.z) || 1;
    const az = Math.atan2(earthPosition.x, -earthPosition.z);
    const el = Math.asin(Math.max(-1, Math.min(1, earthPosition.y / len)));
    const horizon = horizonAngleBin(
      terrain.horizon,
      terrain.horizonPx,
      terrain.nAz,
      site.x,
      site.y,
      az,
      terrain.hf.bounds,
    );
    publish({
      checked: true,
      blocked: el < horizon - 0.002,
      elevationDeg: el * RAD2DEG,
      horizonDeg: horizon * RAD2DEG,
    });
  }, [earthPosition, terrain, site]);

  return null;
}

/**
 * Canvas-side bridge: subscribes to the NASA ephemeris hook and feeds
 * `earthPosition` into the raycaster, keeping the 60 Hz re-renders confined to
 * this leaf instead of the whole scene subtree.
 */
export function CommLinkRaycasterBridge() {
  const { earthPosition } = useNasaEphemeris();
  return <CommLinkRaycaster earthPosition={earthPosition} />;
}
