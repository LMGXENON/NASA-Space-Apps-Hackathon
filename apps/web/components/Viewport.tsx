"use client";

/**
 * 3D viewport (Phases 2–4): displaced terrain + horizon-map shader, rover,
 * Sun/Earth laser lines with blocked hit points, waypoint path, picking.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { createTerrainUniforms, terrainVert, terrainFrag } from "../three/TerrainMaterial";
import { useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";
import { loadTerrain, loadHorizonVariant, type TerrainData } from "../lib/data";
import {
  sampleHeight,
  meshSurfaceHeight,
  meshSurfaceNormal,
  gridToScene,
  horizonAngleBin,
  sceneRayTerrainHit,
  MESH_SEG,
} from "../lib/sceneMath";
import { skyState, gridToLatLon, skyAzEl, RAD2DEG } from "@helios/core";
import RoverModel from "../three/RoverModel";
import SunLighting from "./SunLighting";
import CelestialSky from "../three/CelestialSky";
import InterstellarGalaxy from "../three/InterstellarGalaxy";
import MastCamHud from "./MastCamHud";
import { CommLinkRaycasterBridge } from "./CommLinkRaycaster";
import CameraRig from "../three/CameraRig";
import TerrainPath from "../three/TerrainPath";
import HudControls from "./HudControls";
import Minimap from "./Minimap";
import { roverGridPos as sharedRoverGridPos, type RoverPose } from "../lib/roverPos";
import { PATH_COLOR_LABELS } from "../lib/drapedPath";

import { useAutonomousRoverNav } from "../hooks/useAutonomousRoverNav";
import { cn } from "../lib/cn";

const AOI_HALF = 20_000;
const AOI_SIZE = AOI_HALF * 2;
// MESH_SEG (the "balanced" tier, PRD §8) lives in sceneMath so the CPU mesh
// sampler used by the rover/rays/path stays in step with the rendered plane.

// ------------------------------------------------------------------ boot
function useTerrainBoot() {
  const setTerrain = useUiStore((s) => s.setTerrain);
  const setTerrainError = useUiStore((s) => s.setTerrainError);
  const terrain = useUiStore((s) => s.terrain);
  const horizonObs = useUiStore((s) => s.horizonObs);
  const loadedObs = useRef<number | null>(null);
  const uniforms = useMemo(
    () =>
      createTerrainUniforms({
        heightTex: new THREE.DataTexture(new Uint8Array(4), 1, 1),
        horizonTex: null,
        px: 1024,
        aoiHalf: AOI_HALF,
        hMin: -4300,
        hMax: 2100,
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const obs0 = useUiStore.getState().horizonObs;
        const t = await loadTerrain(obs0);
        if (cancelled) return;
        loadedObs.current = obs0;
        const heightTex = new THREE.DataTexture(t.rgba, t.hf.px, t.hf.px);
        heightTex.minFilter = THREE.NearestFilter;
        heightTex.magFilter = THREE.NearestFilter;
        heightTex.generateMipmaps = false;
        heightTex.needsUpdate = true;

        let horizonTex: THREE.DataArrayTexture | null = null;
        if (t.horizon) {
          horizonTex = new THREE.DataArrayTexture(
            new Uint8Array(t.horizon),
            t.horizonPx,
            t.horizonPx,
            t.horizonLayers,
          );
          horizonTex.format = THREE.RGBAFormat;
          horizonTex.type = THREE.UnsignedByteType;
          horizonTex.minFilter = THREE.LinearFilter;
          horizonTex.magFilter = THREE.LinearFilter;
          horizonTex.needsUpdate = true;
        }

        uniforms.uHeight.value = heightTex;
        uniforms.uHorizon.value = horizonTex;
        uniforms.uHMin.value = t.meta.height.min;
        uniforms.uHMax.value = t.meta.height.max;
        uniforms.uHasHorizon.value = horizonTex ? 1 : 0;
        uniforms.uPx.value = t.hf.px;
        setTerrain(t);
      } catch (e) {
        setTerrainError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setTerrain, setTerrainError, uniforms]);

  // FR-R7: hot-swap the horizon-map variant when the observer height changes.
  useEffect(() => {
    if (!terrain || loadedObs.current === horizonObs) return;
    let cancelled = false;
    (async () => {
      try {
        const buf = await loadHorizonVariant(terrain.meta, horizonObs);
        if (cancelled) return;
        const tex = new THREE.DataArrayTexture(new Uint8Array(buf), terrain.horizonPx, terrain.horizonPx, terrain.horizonLayers);
        tex.format = THREE.RGBAFormat;
        tex.type = THREE.UnsignedByteType;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        uniforms.uHorizon.value = tex;
        loadedObs.current = horizonObs;
        setTerrain({ ...terrain, horizon: buf });
      } catch (e) {
        useUiStore.getState().setToast(`Horizon map failed to load: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [horizonObs, terrain, setTerrain, uniforms]);

  return { terrain, uniforms };
}

// --------------------------------------------------------------- terrain
function Terrain({ uniforms }: { uniforms: ReturnType<typeof createTerrainUniforms> }) {
  const exaggeration = useUiStore((s) => s.exaggeration);
  const geom = useMemo(() => new THREE.PlaneGeometry(AOI_SIZE, AOI_SIZE, MESH_SEG, MESH_SEG), []);
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ uniforms, vertexShader: terrainVert, fragmentShader: terrainFrag }),
    [uniforms],
  );
  useEffect(() => {
    uniforms.uExaggeration.value = exaggeration;
  }, [exaggeration, uniforms]);
  return <mesh geometry={geom} material={mat} frustumCulled={false} />;
}

// ------------------------------------------------------------ ephemeris
function EphemerisDriver({ uniforms }: { uniforms: ReturnType<typeof createTerrainUniforms> }) {
  useFrame(() => {
    const sky = skyState(new Date(useTimeStore.getState().tMs));
    uniforms.uSunME.value.set(sky.sunME.x, sky.sunME.y, sky.sunME.z);
    uniforms.uEarthME.value.set(sky.earthME.x, sky.earthME.y, sky.earthME.z);
    uniforms.uSunR.value = sky.sunAngRadius;
    uniforms.uEarthR.value = sky.earthAngRadius;
    // heat mode: store heatMode (0-2) or dutyMode (3)
    const s = useUiStore.getState();
    uniforms.uHeatMode.value = s.dutyMode ? 3 : s.heatMode;
  });
  return null;
}

// ----------------------------------------------------------- duty texture
function DutyTexture({ uniforms }: { uniforms: ReturnType<typeof createTerrainUniforms> }) {
  const duty = useUiStore((s) => s.dutyTexture);
  useEffect(() => {
    if (!duty) return;
    const rgba = new Uint8Array(duty.w * duty.w * 4);
    for (let i = 0; i < duty.w * duty.w; i++) {
      const g = duty.data[3 * i]!; // % green
      const s = duty.data[3 * i + 1]!; // % sun
      // Colormap: green duty -> green; sun-only -> yellow tint
      rgba[4 * i] = Math.round(255 * (0.1 + 0.5 * s));
      rgba[4 * i + 1] = Math.round(255 * Math.min(1, 0.15 + 0.95 * g));
      rgba[4 * i + 2] = Math.round(255 * 0.12);
      rgba[4 * i + 3] = 255;
    }
    const tex = new THREE.DataTexture(rgba, duty.w, duty.w);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    uniforms.uDuty.value = tex;
    uniforms.uDutyW.value = duty.w;
  }, [duty, uniforms]);
  return null;
}

// ----------------------------------------------------------------- picking
/**
 * March a screen point's ray onto the terrain; returns grid metres or null.
 *
 * The march brackets the contact — last sample known to be above the surface to
 * first sample below — and bisects it, so the returned grid point is accurate to
 * ~1 m even from an overview camera. (Returning the first sample below the
 * surface, the obvious cheaper rule, overshoots by a whole step: up to ~40 m from
 * a 20 km camera, which is a visible offset between the click and the pin that
 * spawns on it.)
 *
 * A camera that is itself below the surface (`OrbitControls` lets the user fly
 * into a ridge, and a fly-to keeps the previous view direction) has no contact to
 * find: the first step would already be "underground" and every click in the
 * viewport would resolve to the camera's own position. That case reports no hit
 * so a click does nothing instead of dropping a marker somewhere arbitrary.
 */
function pickTerrainPoint(
  terrain: TerrainData,
  camera: THREE.Camera,
  dom: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const raycaster = new THREE.Raycaster();
  const rect = dom.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const ro = raycaster.ray.origin;
  const rd = raycaster.ray.direction;
  const ex = useUiStore.getState().exaggeration;
  const inAoi = (gx: number, gy: number) => Math.abs(gx) <= AOI_HALF && Math.abs(gy) <= AOI_HALF;
  // Signed clearance of a scene point above the terrain surface: <= 0 is buried.
  // Scene Z is −grid Y (see the terrain vertex shader).
  const clearance = (sx: number, sz: number, sy: number) =>
    sy - (sampleHeight(terrain.hf, sx, -sz) - terrain.meta.height.min) * ex;
  if (inAoi(ro.x, -ro.z) && clearance(ro.x, ro.z, ro.y) <= 0) return null;

  const BISECT = 24;
  let d = 10;
  let above = -1;
  while (d < 150_000) {
    const px = ro.x + rd.x * d;
    const pz = ro.z + rd.z * d;
    const py = ro.y + rd.y * d;
    if (!inAoi(px, -pz)) break;
    if (clearance(px, pz, py) <= 0) {
      // Never sampled above the surface, so there is no contact to refine.
      if (above < 0) return null;
      let lo = above;
      let hi = d;
      for (let i = 0; i < BISECT; i++) {
        const mid = (lo + hi) / 2;
        if (clearance(ro.x + rd.x * mid, ro.z + rd.z * mid, ro.y + rd.y * mid) <= 0) hi = mid;
        else lo = mid;
      }
      return { x: ro.x + rd.x * hi, y: -(ro.z + rd.z * hi) };
    }
    above = d;
    d += Math.max(terrain.hf.texelM, 0.002 * d);
  }
  return null;
}

function Picker() {
  const { camera, gl } = useThree();
  const terrain = useUiStore((s) => s.terrain);
  const pickMode = useUiStore((s) => s.pickMode);

  useEffect(() => {
    if (!terrain || !pickMode) return;
    const dom = gl.domElement;
    const onClick = (e: MouseEvent) => {
      const hit = pickTerrainPoint(terrain, camera, dom, e.clientX, e.clientY);
      if (!hit) return;
      const s = useUiStore.getState();
      if (s.pickMode === "rover") {
        s.setRoverSite({ x: hit.x, y: hit.y });
        s.setPickMode(null);
      }
      if (s.pickMode === "path") {
        // Stay in waypoint mode so successive clicks extend the route: each click
        // spawns a surface-normal pin and re-drapes the rope from the previous
        // waypoint. Escape (or the button) ends the run.
        s.setPath([...s.path, { x: hit.x, y: hit.y }]);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useUiStore.getState().setPickMode(null);
    };
    dom.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      dom.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [terrain, pickMode, camera, gl]);
  return null;
}

// ------------------------------------------------- duty hover probe (FR-R6)
/** Shared hover sample consumed by the readout overlay (no React churn). */
const dutyHover: { text: string } = { text: "" };

function DutyHoverProbe() {
  const { camera, gl } = useThree();
  const terrain = useUiStore((s) => s.terrain);
  const dutyMode = useUiStore((s) => s.dutyMode);
  const dutyTexture = useUiStore((s) => s.dutyTexture);

  useEffect(() => {
    if (!terrain || !dutyMode || !dutyTexture) {
      dutyHover.text = "";
      return;
    }
    const dom = gl.domElement;
    let last = 0;
    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      if (now - last < 80) return;
      last = now;
      const hit = pickTerrainPoint(terrain, camera, dom, e.clientX, e.clientY);
      if (!hit) {
        dutyHover.text = "";
        return;
      }
      const w = dutyTexture.w;
      const step = 40_000 / w;
      const ix = Math.floor((hit.x + 20_000) / step);
      const iy = Math.floor((hit.y + 20_000) / step);
      if (ix < 0 || iy < 0 || ix >= w || iy >= w) {
        dutyHover.text = "";
        return;
      }
      const i = iy * w + ix;
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      dutyHover.text = `duty: green ${pct(dutyTexture.data[3 * i]!)} · sun ${pct(dutyTexture.data[3 * i + 1]!)} · comm ${pct(dutyTexture.data[3 * i + 2]!)}`;
    };
    dom.addEventListener("mousemove", onMove);
    return () => dom.removeEventListener("mousemove", onMove);
  }, [terrain, dutyMode, dutyTexture, camera, gl]);
  return null;
}

// ------------------------------------------------------------------ rover
/**
 * Where the rover is right now along its waypoint path (FR-B4). Uses the same
 * `pathPositionAt` the simulation uses, so the animated model traces exactly the
 * trajectory the power/link numbers assume.
 */
function roverGridPos(): RoverPose {
  return sharedRoverGridPos() ?? { x: 0, y: 0, heading: 0, moving: false };
}

function Rover() {
  const terrain = useUiStore((s) => s.terrain);
  const site = useUiStore((s) => s.roverSite);
  const exaggeration = useUiStore((s) => s.exaggeration);
  const cameraMode = useUiStore((s) => s.cameraMode);
  const group = useRef<THREE.Group>(null);
  // Scratch objects reused every frame (no per-frame allocations, PRD §11).
  const upVec = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const nVec = useMemo(() => new THREE.Vector3(), []);
  const tilt = useMemo(() => new THREE.Quaternion(), []);
  const yawQ = useMemo(() => new THREE.Quaternion(), []);
  const target = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    if (!terrain || !site || !group.current) return;
    const p = roverGridPos();
    // Sample the rendered mesh, not the full-resolution DEM, so the model rests
    // exactly on the visible surface (the two differ by up to ~28 m on the rims).
    const h = meshSurfaceHeight(terrain.hf, p.x, p.y);
    const [sx, , sz] = gridToScene(p.x, p.y);

    // Pitch/roll to the surface. Alignment uses the rendered mesh's triangle
    // normal (CPU) rather than a THREE.Raycaster, which cannot see vertex-shader
    // displacement and would report the flat plane. Slerp damps the jump as the
    // contact point crosses a triangle edge.
    const [nx, ny, nz] = meshSurfaceNormal(terrain.hf, p.x, p.y, MESH_SEG, exaggeration);
    nVec.set(nx, ny, nz);
    tilt.setFromUnitVectors(upVec, nVec);
    // Heading is measured from grid +Y toward +X; scene Z = -grid Y.
    yawQ.setFromAxisAngle(upVec, -p.heading + Math.PI);
    target.copy(tilt).multiply(yawQ);
    group.current.quaternion.slerp(target, 0.25);

    // Compute slope-compensated ground clearance so wheels rest flush on the regolith without clipping
    const slopeSin = Math.sqrt(nx * nx + nz * nz);
    const groundSag = slopeSin * 36;
    const y = (h - terrain.meta.height.min) * exaggeration + groundSag + 2.5;
    group.current.position.set(sx, y, sz);
  });

  if (!site) return null;
  // Schematic scale: the rover is drawn oversized so it reads at the default
  // whole-AOI zoom, where a real 3 m lander would be under a pixel wide.
  return (
    <group ref={group}>
      {/* ground ring marks the site; it shares the group's tilt so it lies on the
          slope instead of cutting through it (hidden in MastCam to avoid ground clutter) */}
      {cameraMode !== "mastcam" && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 4, 0]}>
          <ringGeometry args={[330, 400, 52]} />
          <meshBasicMaterial color="#2ee6ff" transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      <RoverModel />
    </group>
  );
}

// PropSunLight moved to ./SunLighting: the prop light is now driven by the
// live NASA ephemeris hook (useNasaEphemeris) instead of a per-frame lookup,
// so it shares one Sun vector with the Sun laser and the telemetry panels.

// ----------------------------------------------------------------- lasers
// Hoisted so useFrame allocates nothing per frame (PRD §11).
const LASER_UP = new THREE.Vector3(0, 1, 0);
const LASER_DIR = new THREE.Vector3();

function Lasers() {
  const terrain = useUiStore((s) => s.terrain);
  const site = useUiStore((s) => s.roverSite);
  const showSun = useUiStore((s) => s.showSunRay);
  const showEarth = useUiStore((s) => s.showEarthRay);
  const exaggeration = useUiStore((s) => s.exaggeration);
  const sunRef = useRef<THREE.Mesh>(null);
  const sunRing = useRef<THREE.Mesh>(null);
  const sunMat = useRef<THREE.MeshBasicMaterial>(null);
  const earthRef = useRef<THREE.Mesh>(null);
  const earthRing = useRef<THREE.Mesh>(null);
  const earthMat = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(() => {
    if (!terrain || !site) return;
    const sky = skyState(new Date(useTimeStore.getState().tMs));
    const p = roverGridPos();
    const h = meshSurfaceHeight(terrain.hf, p.x, p.y);
    const y0 = (h - terrain.meta.height.min) * exaggeration + 2;
    const { latRad, lonRad } = gridToLatLon(p.x, p.y);
    const { sun, earth } = skyAzEl(sky, latRad, lonRad);
    const [sx, , sz] = gridToScene(p.x, p.y);

    const update = (
      ref: React.RefObject<THREE.Mesh | null>,
      ring: React.RefObject<THREE.Mesh | null>,
      mat: React.RefObject<THREE.MeshBasicMaterial | null>,
      az: number,
      el: number,
      baseColor: string,
    ) => {
      if (!ref.current || !mat.current) return;
      // az/el are in the local ENU frame at the site; convert to scene:
      // scene X = grid east, scene Z = -grid north, Y = up
      const dx = Math.cos(el) * Math.sin(az);
      const dz = -Math.cos(el) * Math.cos(az);
      const dy = Math.sin(el);
      const horizonBlocked =
        el < horizonAngleBin(terrain.horizon!, terrain.horizonPx, terrain.nAz, p.x, p.y, az, terrain.hf.bounds) - 0.002;
      // FR-R3: a blocked ray must END at the obstruction point on the terrain
      // (acceptance: "hit point lies on the terrain surface ±1 texel"). March the
      // rendered mesh in scene space and bisect the crossing, so the red line and
      // its impact ring land exactly on the visible surface instead of stopping at
      // an arbitrary length.
      const hit = sceneRayTerrainHit(
        terrain.hf,
        sx,
        y0,
        sz,
        dx,
        dy,
        dz,
        terrain.meta.height.min,
        exaggeration,
      );
      // The horizon map stays authoritative for the blocked/clear decision so the
      // laser colour always agrees with the heat classification and the analytics.
      const blocked = horizonBlocked || hit.blocked;
      const L = hit.blocked ? hit.dHit : blocked ? 2500 : 15_000;
      const mid = ref.current;
      mid.position.set(sx + (dx * L) / 2, y0 + (dy * L) / 2, sz + (dz * L) / 2);
      mid.quaternion.setFromUnitVectors(LASER_UP, LASER_DIR.set(dx, dy, dz).normalize());
      mid.scale.set(1, L, 1);
      mat.current.color.set(blocked ? "#ff3b4d" : baseColor);
      if (ring.current) ring.current.visible = blocked;
      if (ring.current && blocked) {
        ring.current.position.set(sx + dx * L, y0 + dy * L, sz + dz * L);
      }
    };

    update(sunRef, sunRing, sunMat, sun.az, sun.el, "#ffe066");
    update(earthRef, earthRing, earthMat, earth.az, earth.el, "#00b3ff");
  });

  if (!site) return null;
  return (
    <group>
      {showSun && (
        <>
          <mesh ref={sunRef}>
            <cylinderGeometry args={[12, 12, 1, 6]} />
            <meshBasicMaterial ref={sunMat} color="#ffe066" transparent opacity={0.9} />
          </mesh>
          <mesh ref={sunRing} visible={false}>
            <ringGeometry args={[80, 120, 24]} />
            <meshBasicMaterial color="#ff3b4d" side={THREE.DoubleSide} />
          </mesh>
        </>
      )}
      {showEarth && (
        <>
          <mesh ref={earthRef}>
            <cylinderGeometry args={[12, 12, 1, 6]} />
            <meshBasicMaterial ref={earthMat} color="#00b3ff" transparent opacity={0.9} />
          </mesh>
          <mesh ref={earthRing} visible={false}>
            <ringGeometry args={[80, 120, 24]} />
            <meshBasicMaterial color="#ff3b4d" side={THREE.DoubleSide} />
          </mesh>
        </>
      )}
    </group>
  );
}

// The route is drawn by ./three/TerrainPath: a terrain-conforming draped spline
// with per-segment slope colours and surface-normal waypoint pins.

// ------------------------------------------------------------ overlay chrome
function Overlay({ children, className = "", style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={`pointer-events-none absolute rounded-xl px-2.5 py-1.5 backdrop-blur-md ${className}`}
      style={{ background: "rgba(4,16,42,0.85)", border: "1px solid var(--nasa-blue-light)", ...style }}
    >
      {children}
    </div>
  );
}

function Legend() {
  const cameraMode = useUiStore((s) => s.cameraMode);
  if (cameraMode === "mastcam") return null;

  const chip = (c: string, label: string) => (
    <span key={label} className="flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--text-2)" }}>
      <span className="dot" style={{ background: c }} />
      {label}
    </span>
  );
  return (
    <>
      <Overlay className="bottom-14 left-3 hidden flex-wrap items-center gap-3 sm:flex">
        {chip("#35e08a", "Sun + comm")}
        {chip("#ffd60a", "Sun only")}
        {chip("#ff5468", "Dead")}
        {chip("#4cc2ff", "Earth LOS")}
      </Overlay>
      {/* Route grade key (FR-B4): the rope's segment colours. */}
      <RouteLegend />
    </>
  );
}

function RouteLegend() {
  const path = useUiStore((s) => s.path);
  if (path.length === 0) return null;
  const chip = (c: string, label: string) => (
    <span key={label} className="flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--text-2)" }}>
      <span className="dot" style={{ background: c }} />
      {label}
    </span>
  );
  return (
    <Overlay className="bottom-24 left-3 hidden flex-wrap items-center gap-3 sm:flex">
      <span className="hud-label">Route grade</span>
      {chip("#22d3ee", PATH_COLOR_LABELS[0])}
      {chip("#d4af37", PATH_COLOR_LABELS[1])}
      {chip("#fc3d21", PATH_COLOR_LABELS[2])}
    </Overlay>
  );
}

/**
 * Live rover readout (FR-B4): follows the rover along its waypoint path as
 * mission time advances, so the animation is legible without hunting for the
 * model in the 3D scene. Updated outside React (10 Hz) to avoid re-renders.
 */
function LiveGeo() {
  const ref = useRef<HTMLSpanElement>(null);
  const site = useUiStore((s) => s.roverSite);
  useEffect(() => {
    const id = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      if (!useUiStore.getState().roverSite) {
        el.textContent = "no rover placed";
        return;
      }
      const p = roverGridPos();
      const { latRad, lonRad } = gridToLatLon(p.x, p.y);
      el.textContent = `${(latRad * RAD2DEG).toFixed(3)}°, ${(lonRad * RAD2DEG).toFixed(3)}°${p.moving ? " ▸ driving" : ""}`;
    }, 100);
    return () => clearInterval(id);
  }, [site]);
  return (
    <span ref={ref} className="mono text-[10.5px]" style={{ color: "var(--text-2)" }}>
      no rover placed
    </span>
  );
}

/** Live "hover shows the value" readout for the duty map (FR-R6). */
function DutyHoverLive() {
  const ref = useRef<HTMLSpanElement>(null);
  const dutyMode = useUiStore((s) => s.dutyMode);
  const dutyTexture = useUiStore((s) => s.dutyTexture);
  useEffect(() => {
    const id = setInterval(() => {
      if (ref.current) ref.current.textContent = dutyHover.text;
    }, 100);
    return () => clearInterval(id);
  }, []);
  if (!dutyMode || !dutyTexture) return null;
  return <span ref={ref} className="mono text-[10.5px]" style={{ color: "var(--text-3)" }} />;
}

function StatusOverlay() {
  const cameraMode = useUiStore((s) => s.cameraMode);
  const exaggeration = useUiStore((s) => s.exaggeration);
  const heatMode = useUiStore((s) => s.heatMode);
  const dutyMode = useUiStore((s) => s.dutyMode);
  const pickMode = useUiStore((s) => s.pickMode);

  if (cameraMode === "mastcam") return null;

  const labels = [
    "Photometric regolith",
    "Tri-Class (Sun+Comm)",
    "Sun disc fraction",
    "14d Duty-cycle map",
    "Slope hazard map",
    "Topographic contours",
    "PSR cold traps",
  ];
  const heatLabel = dutyMode ? "14d Duty-cycle map" : labels[heatMode] ?? "Photometric regolith";

  return (
    <>
      <Overlay className="bottom-3 left-3 flex items-center gap-3">
        <LiveGeo />
        <DutyHoverLive />
        <span className="text-[10.5px]" style={{ color: "var(--text-4)" }}>
          {heatLabel} · {exaggeration.toFixed(1)}× vertical
        </span>
      </Overlay>

      {pickMode && (
        <Overlay className="left-1/2 top-3 -translate-x-1/2" style={{ background: "rgba(11,61,145,0.92)", borderColor: "var(--nasa-blue-light)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--accent-strong)" }}>
            {pickMode === "rover"
              ? "Click the terrain to place the rover"
              : "Click the terrain to add a waypoint · Esc to finish"}
          </span>
        </Overlay>
      )}
    </>
  );
}

function AutonomousGncOverlay() {
  const cameraMode = useUiStore((s) => s.cameraMode);
  const playing = useTimeStore((s) => s.playing);
  const roverSite = useUiStore((s) => s.roverSite);
  const { autonomyState } = useAutonomousRoverNav();

  if (cameraMode === "mastcam" || !playing || !roverSite) return null;

  const isDeepSleep = autonomyState.decision === "DEEP_SLEEP_WAIT";
  const isHazardStop = autonomyState.decision === "HAZARD_STOP";

  const dotColor = isHazardStop
    ? "bg-[var(--bad)]"
    : isDeepSleep
      ? "bg-[var(--warn)]"
      : "bg-[var(--ok)]";

  const borderColor = isHazardStop
    ? "border-[var(--bad)]"
    : isDeepSleep
      ? "border-[var(--warn)]"
      : "border-[var(--line-strong)]";

  const titleText = isDeepSleep
    ? "DEEP SLEEP · WAITING FOR SUNLIGHT"
    : isHazardStop
      ? "HAZARD STOP · ROLLOVER SAFETY"
      : "AUTONOMOUS GNC · SOLAR TRACKING";

  const socColor =
    autonomyState.batteryPct <= 15
      ? "text-[var(--bad)] font-bold"
      : autonomyState.batteryPct <= 25
        ? "text-[var(--warn)] font-bold"
        : "text-[var(--ok)] font-medium";

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 z-20 flex flex-col items-center">
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-3 rounded-lg px-3.5 py-1.5 backdrop-blur-md shadow-xl border bg-[var(--bg-1)]/90 transition-colors text-xs",
          borderColor,
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full shrink-0", dotColor)} />
          <span className="mono text-[11px] font-semibold tracking-wider uppercase text-white">
            {titleText}
          </span>
        </div>

        <span className="text-[var(--line-strong)] select-none">|</span>

        <span className="mono text-[11px] text-[var(--text-2)]">
          <span className="text-[var(--text-4)] mr-1">Slope</span>
          {autonomyState.slopeDeg.toFixed(1)}°
          <span className="text-[var(--ok)] text-[10px] ml-1">(&lt;20° Safe)</span>
        </span>

        <span className="text-[var(--line-strong)] select-none">|</span>

        <span className="mono text-[11px]">
          <span className="text-[var(--text-4)] mr-1">SOC</span>
          <span className={socColor}>{autonomyState.batteryPct.toFixed(1)}%</span>
        </span>

        <span className="text-[var(--line-strong)] select-none">|</span>

        <span className="mono text-[11px] text-[var(--kapton)]">
          <span className="text-[var(--text-4)] mr-1">Hdg</span>
          {autonomyState.headingDeg.toFixed(0)}°
        </span>
      </div>

      <div className="mt-1 px-3 py-0.5 rounded text-[10px] mono text-[var(--text-3)] bg-[var(--bg-1)]/85 border border-[var(--line)] max-w-lg text-center backdrop-blur-sm shadow">
        {autonomyState.statusMessage}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shell
export default function Viewport() {
  const terrain = useUiStore((s) => s.terrain);
  const terrainError = useUiStore((s) => s.terrainError);
  return (
    <div className="viewport-frame h-full w-full">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [17_000, 6800, 17_000], fov: 50, near: 2, far: 2_000_000_000 }}
        gl={{ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true }}
      >
        <color attach="background" args={["#020306"]} />
        {/* Photorealistic deep-space galaxy with organic Milky Way dust lanes and Harvard-spectral starfield */}
        <InterstellarGalaxy />
        <SceneContent />
      </Canvas>

      <AutonomousGncOverlay />
      <MastCamHud />
      <HudControls />
      <Minimap />
      <Legend />
      <StatusOverlay />

      {terrainError && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <div className="card max-w-sm p-4">
            <p className="text-[12.5px]" style={{ color: "var(--bad)" }}>
              Terrain data failed to load
            </p>
            <p className="mono mt-1 text-[11px]" style={{ color: "var(--text-3)" }}>
              {terrainError}
            </p>
          </div>
        </div>
      )}

      {!terrain && !terrainError && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2.5">
            <span
              className="h-6 w-6 animate-spin rounded-full"
              style={{ border: "2px solid var(--line-strong)", borderTopColor: "var(--accent)" }}
              aria-hidden
            />
            <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
              Loading terrain and horizon map…
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Publishes the selenographic coordinate under the camera pivot ~4×/s so the HUD
 * readout tracks panning and zooming without a per-frame React update.
 */
function CoordTracker() {
  const last = useRef(0);
  useFrame((state) => {
    const now = performance.now();
    if (now - last.current < 250) return;
    last.current = now;
    const controls = (state as unknown as { controls?: { target?: THREE.Vector3 } }).controls;
    const t = controls?.target ?? state.camera.position;
    // Scene X = grid east, scene Z = −grid north → invert the mapping.
    useUiStore.getState().setCoords(gridToLatLon(t.x, -t.z));
  });
  return null;
}

function SceneContent() {
  const { uniforms } = useTerrainBoot();
  const cameraMode = useUiStore((s) => s.cameraMode);
  return (
    <>
      <EphemerisDriver uniforms={uniforms} />
      <CelestialSky />
      <SunLighting />
      <CommLinkRaycasterBridge />
      <Terrain uniforms={uniforms} />
      <Rover />
      <Lasers />
      <TerrainPath />
      <Picker />
      <DutyHoverProbe />
      <DutyTexture uniforms={uniforms} />
      <OrbitControls
        makeDefault
        enabled={cameraMode === "orbit"}
        target={[0, 1200, 0]}
        maxPolarAngle={Math.PI * 0.56}
        minDistance={4}
        maxDistance={120_000}
        enableDamping
        dampingFactor={0.08}
      />
      <CoordTracker />
      <CameraRig />
    </>
  );
}
