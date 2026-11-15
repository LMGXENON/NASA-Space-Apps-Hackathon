"use client";

/**
 * CelestialSky — Physically positioned Sun and Earth in the lunar sky.
 *
 * In the lunar south-pole environment:
 * - The Sun hovers within ~1.5° of the terrain horizon, casting long dramatic
 *   grazing shadows. Angular diameter ≈ 0.53°.
 * - Earth hovers ~6° to 7° above the horizon with librational oscillation.
 *   Angular diameter ≈ 1.9° (~3.6× larger than the Sun in the sky!).
 * - Earth exhibits dynamic phases (New Earth, Quarter, Full Earth) determined by
 *   the angular separation between the Sun and Earth vectors.
 *
 * Both bodies are positioned at realistic astronomical vectors in the scene frame
 * (Y = up, X = grid east, Z = -grid north) at 95,000 m distance, inside camera far.
 */

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { skyState, skyAzEl, gridToLatLon } from "@helios/core";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";
import { getEarthTexture, getSunFlareTexture } from "../lib/earthTexture";

const CELESTIAL_DIST = 140_000;
// What people see from the Moon (Apollo / human eye scale):
// Sun: ~1.31° apparent diameter with radiant corona (28px core, 65px corona)
const SUN_RADIUS = 1_600;
// Earth: ~4.25° apparent diameter (~92px prominent Blue Marble with Rayleigh limb)
// Ratio: Earth is ~3.25× larger than the Sun in the lunar sky
const EARTH_RADIUS = 5_200;

export default function CelestialSky() {
  const sunGroup = useRef<THREE.Group>(null);
  const earthGroup = useRef<THREE.Group>(null);
  const earthMesh = useRef<THREE.Mesh>(null);
  const atmosphereMesh = useRef<THREE.Mesh>(null);

  // Scratch objects hoisted to avoid per-frame allocations (PRD §11)
  const sunVec = useMemo(() => new THREE.Vector3(), []);
  const earthVec = useMemo(() => new THREE.Vector3(), []);
  const sunToEarth = useMemo(() => new THREE.Vector3(), []);

  // Sun corona glow texture & Earth texture
  const sunFlareTex = useMemo(() => getSunFlareTexture(), []);
  const earthTex = useMemo(() => getEarthTexture(), []);

  useFrame(({ camera }) => {
    const s = useUiStore.getState();
    if (s.viewMode === "globe") {
      if (sunGroup.current) sunGroup.current.visible = false;
      if (earthGroup.current) earthGroup.current.visible = false;
      return;
    }

    const sky = skyState(new Date(useTimeStore.getState().tMs));
    const rover = s.roverSite;
    const { latRad, lonRad } = rover ? gridToLatLon(rover.x, rover.y) : gridToLatLon(0, 0);
    const { sun, earth } = skyAzEl(sky, latRad, lonRad);

    // Local ENU az/el -> scene vector (scene X = grid east, scene Z = -grid north, Y = up)
    // Synchronized strictly with Sun/Earth lasers and ephemeris
    const sx = Math.cos(sun.el) * Math.sin(sun.az);
    const sy = Math.sin(sun.el);
    const sz = -Math.cos(sun.el) * Math.cos(sun.az);
    sunVec.set(sx, sy, sz).normalize();

    const ex = Math.cos(earth.el) * Math.sin(earth.az);
    const ey = Math.sin(earth.el);
    const ez = -Math.cos(earth.el) * Math.cos(earth.az);
    earthVec.set(ex, ey, ez).normalize();

    if (sunGroup.current) {
      sunGroup.current.visible = true;
      // Position at optical infinity relative to camera (zero parallax drift)
      sunGroup.current.position.copy(camera.position).addScaledVector(sunVec, CELESTIAL_DIST);
      sunGroup.current.lookAt(camera.position);
    }

    if (earthGroup.current) {
      earthGroup.current.visible = true;
      // Position at optical infinity relative to camera (zero parallax drift)
      earthGroup.current.position.copy(camera.position).addScaledVector(earthVec, CELESTIAL_DIST);
      // Orient Earth's lit hemisphere toward the Sun
      sunToEarth.copy(sunVec).sub(earthVec).normalize();
      earthGroup.current.lookAt(
        earthGroup.current.position.x + sunToEarth.x,
        earthGroup.current.position.y + sunToEarth.y,
        earthGroup.current.position.z + sunToEarth.z,
      );
      if (earthMesh.current) {
        earthMesh.current.rotation.y += 0.0012;
      }
    }
  });

  return (
    <>
      {/* ----------------------------- SUN ----------------------------- */}
      {/* Brilliant solar disc with glowing corona */}
      <group ref={sunGroup}>
        {/* Luminous solar disc */}
        <mesh>
          <sphereGeometry args={[SUN_RADIUS, 32, 24]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>

        {/* Photorealistic solar corona & flare */}
        {sunFlareTex && (
          <sprite scale={[SUN_RADIUS * 3.4, SUN_RADIUS * 3.4, 1]}>
            <spriteMaterial
              map={sunFlareTex}
              transparent
              opacity={0.82}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </sprite>
        )}
      </group>

      {/* ---------------------------- EARTH ---------------------------- */}
      {/* Iconic Blue Marble with glowing Rayleigh atmospheric limb */}
      <group ref={earthGroup}>
        {/* Earth globe with subtle night-side self-illumination */}
        <mesh ref={earthMesh}>
          <sphereGeometry args={[EARTH_RADIUS, 48, 36]} />
          <meshStandardMaterial
            map={earthTex ?? undefined}
            roughness={0.5}
            metalness={0.1}
            emissiveMap={earthTex ?? undefined}
            emissive="#4477aa"
            emissiveIntensity={0.42}
            color="#ffffff"
          />
        </mesh>

        {/* Luminous atmospheric Rayleigh limb (outer blue halo) */}
        <mesh ref={atmosphereMesh} scale={[1.035, 1.035, 1.035]}>
          <sphereGeometry args={[EARTH_RADIUS, 36, 28]} />
          <meshBasicMaterial
            color="#52c8ff"
            transparent
            opacity={0.45}
            side={THREE.BackSide}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>

        {/* DSN Deep Space Network station beacon marker on Earth */}
        <group position={[0, EARTH_RADIUS * 0.6, EARTH_RADIUS * 0.8]}>
          <mesh>
            <sphereGeometry args={[EARTH_RADIUS * 0.025, 12, 12]} />
            <meshBasicMaterial color="#2ee6ff" />
          </mesh>
        </group>
      </group>
    </>
  );
}
