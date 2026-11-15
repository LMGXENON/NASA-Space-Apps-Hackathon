"use client";

/**
 * SunLighting — prop-only Sun light (PRD §5.3) driven by the live NASA
 * ephemeris (`useNasaEphemeris().sunPosition`). The terrain keeps its custom
 * horizon-map shader (PRD §5.1 forbids displacementMap / a shadow-map lit
 * terrain, ADR-001 rejects terrain shadow maps for grazing-angle artifacts),
 * so this light shades the rover and other props only.
 *
 * The same `sunPosition` vector feeds the Sun laser and the telemetry panels,
 * so the light orientation, rendered rays and charts move together when the
 * mission date slider moves.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useNasaEphemeris } from "../hooks/useNasaEphemeris";

const LIGHT_DISTANCE = 50_000;
/** Keep the polar Sun off the exact horizon so props stay readable. */
const MIN_SUN_Y = 0.24;
// Hoisted so the effect allocates nothing (PRD §11).
const SCRATCH = new THREE.Vector3();

export default function SunLighting() {
  const ref = useRef<THREE.DirectionalLight>(null);
  const { sunPosition } = useNasaEphemeris();

  useEffect(() => {
    const l = ref.current;
    if (!l) return;
    SCRATCH.copy(sunPosition).normalize();
    // The polar Sun stays within ~2° of the horizon; clamp the elevation just
    // enough that the rover is not lit from directly edge-on and unreadable.
    if (SCRATCH.y < MIN_SUN_Y) SCRATCH.y = MIN_SUN_Y;
    SCRATCH.normalize().multiplyScalar(LIGHT_DISTANCE);
    l.position.copy(SCRATCH);
  }, [sunPosition]);

  return (
    <>
      <ambientLight intensity={0.16} />
      <directionalLight ref={ref} intensity={2.3} color="#fff4dc" />
      <directionalLight position={[-24_000, 30_000, -18_000]} intensity={0.45} color="#9fc4ff" />
    </>
  );
}
