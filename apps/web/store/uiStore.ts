"use client";

/**
 * UI/mission state (PRD Part B §6, C.5): terrain data, rover, path, layers.
 * Sim results live here too so charts can consume them without prop drilling.
 */

import { create } from "zustand";
import type { TerrainData } from "../lib/data";
import type { RoverProfile } from "@helios/core";
import { DEFAULT_ROVER_PROFILE } from "@helios/core";
import type { PlanCandidate, SimResult } from "../workers/rover.worker";
import type { CorridorStats } from "../lib/planExport";
import { useTimeStore } from "./timeStore";

export interface Waypoint {
  x: number; // grid meters
  y: number;
}

/**
 * A smooth camera move request. `CameraRig` reads it with `getState()` inside
 * `useFrame`, so requesting a fly-to never re-renders the scene subtree; the
 * `nonce` lets the rig distinguish a fresh request from the one it is animating.
 *
 * `target` is the scene point the orbit pivot should land on and `distance` the
 * eye separation to keep along the *current* view direction, so recentring never
 * yanks the camera to a fixed angle.
 */
export interface CameraFocus {
  target: [number, number, number];
  distance: number;
  dir?: [number, number, number];
  nonce: number;
}

/** Which 3D presentation is active: the 1:1 Moon globe or the local AOI patch. */
export type ViewMode = "globe" | "local";

interface UiState {
  terrain: TerrainData | null;
  terrainError: string | null;
  setTerrain: (t: TerrainData | null) => void;
  setTerrainError: (e: string | null) => void;

  exaggeration: number;
  setExaggeration: (v: number) => void;

  /** Observer height class (PRD FR-R7): 0 m ground, 2 m, 10 m mast. Selects
   *  the baked horizon-map variant used by both the shader and the worker. */
  horizonObs: number;
  setHorizonObs: (v: number) => void;

  /** Transient toast message (PRD FR-E2: clamp feedback). */
  toast: string | null;
  setToast: (msg: string | null) => void;

  heatMode: number; // 0 off, 1 classified, 2 sun gradient
  setHeatMode: (m: number) => void;

  showSunRay: boolean;
  showEarthRay: boolean;
  toggleRay: (which: "sun" | "earth") => void;

  roverSite: { x: number; y: number } | null;
  /** Epoch (ms) the rover starts driving its waypoint path from (FR-B4). */
  departTMs: number | null;
  setRoverSite: (s: { x: number; y: number } | null) => void;

  path: Waypoint[];
  setPath: (p: Waypoint[]) => void;

  /** Auto-planner results for the current site (cleared when the rover moves):
   *  candidates plus the graded corridor to each, so the planner card and the
   *  guided tour share one list. */
  plan: PlanCandidate[] | null;
  planCorridors: Record<string, CorridorStats> | null;
  setPlan: (p: PlanCandidate[] | null, corridors?: Record<string, CorridorStats> | null) => void;

  profile: RoverProfile;
  setProfile: (p: RoverProfile) => void;

  sim: SimResult | null;
  setSim: (s: SimResult | null) => void;

  ribbon: { classes: Uint8Array; t0: number; dtSec: number } | null;
  setRibbon: (r: { classes: Uint8Array; t0: number; dtSec: number } | null) => void;

  duty: { pctGreen: number; pctSun: number; pctEarth: number } | null;
  setDuty: (d: { pctGreen: number; pctSun: number; pctEarth: number } | null) => void;

  /** Duty-map result from the worker: {w, data: Float32Array(w*w*3)} */
  dutyTexture: { w: number; data: Float32Array } | null;
  setDutyTexture: (d: { w: number; data: Float32Array } | null) => void;
  dutyMode: boolean;
  setDutyMode: (on: boolean) => void;

  infoOpen: boolean;
  setInfoOpen: (b: boolean) => void;
  tourActive: boolean;
  setTourActive: (b: boolean) => void;
  sunSeekingMode: boolean;
  setSunSeekingMode: (b: boolean) => void;

  pickMode: "rover" | "path" | null;
  setPickMode: (m: "rover" | "path" | null) => void;

  /** Globe (1:1 Moon) vs local AOI terrain view. */
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;

  /** In Globe view: focus on Moon (selenocentric) or Earth-Moon orbital system (geocentric revolution). */
  globeFocus: "moon" | "system";
  setGlobeFocus: (f: "moon" | "system") => void;

  /** Astronomical scale mode: exact 1:1 NASA physical scale (384,400 km) vs compact overview. */
  orbitScaleMode: "true1to1" | "overview";
  setOrbitScaleMode: (m: "true1to1" | "overview") => void;

  /** Camera mode: standard orbital control or first-person rover mast camera. */
  cameraMode: "orbit" | "mastcam";
  setCameraMode: (m: "orbit" | "mastcam") => void;

  /** First-Person MastCam Gimbal & Optics */
  mastcamPan: number; // degrees relative to rover forward (-180 to 180)
  mastcamTilt: number; // degrees elevation (-85 to 90)
  mastcamZoom: number; // optical zoom factor (1.0 to 4.0)
  mastcamFilter: "rgb" | "infrared" | "geology" | "solar" | "night";
  setMastcamPan: (pan: number | ((prev: number) => number)) => void;
  setMastcamTilt: (tilt: number | ((prev: number) => number)) => void;
  setMastcamZoom: (zoom: number) => void;
  setMastcamFilter: (f: "rgb" | "infrared" | "geology" | "solar" | "night") => void;
  resetMastcam: () => void;

  /** Active console tab on the left sidebar: Navigation / Spectral Layers / Sortie Planner. */
  activeLeftTab: "nav" | "layers" | "sortie";
  setActiveLeftTab: (t: "nav" | "layers" | "sortie") => void;

  /** Active console tab on the right sidebar: Telemetry / Sky Dome / Charts / Validation. */
  activeRightTab: "telemetry" | "skydome" | "charts" | "validation";
  setActiveRightTab: (t: "telemetry" | "skydome" | "charts" | "validation") => void;

  /** Synthesized audio mission cues (Quindar tone, telemetry ping). */
  audioEnabled: boolean;
  setAudioEnabled: (enabled: boolean) => void;

  /** Selected Artemis sortie mission scenario preset. */
  activeScenario: string | null;
  setActiveScenario: (s: string | null) => void;

  /** Pending smooth camera move consumed by `CameraRig` (one-shot). */
  focus: CameraFocus | null;
  requestFocus: (target: [number, number, number], distance: number, dir?: [number, number, number]) => void;

  /** Live selenographic coordinate of whatever the camera/rover is centred on. */
  coords: { latRad: number; lonRad: number } | null;
  setCoords: (c: { latRad: number; lonRad: number } | null) => void;

  /** Autonomous rover live battery state of charge (0 to 100 %). */
  autonomyBatteryPct: number;
  setAutonomyBatteryPct: (pct: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  terrain: null,
  terrainError: null,
  setTerrain: (t) => set({ terrain: t }),
  setTerrainError: (e) => set({ terrainError: e }),

  cameraMode: "orbit",
  setCameraMode: (m) => set({ cameraMode: m }),

  mastcamPan: 0,
  mastcamTilt: -5,
  mastcamZoom: 1.0,
  mastcamFilter: "rgb",
  setMastcamPan: (pan) => set((s) => ({ mastcamPan: typeof pan === "function" ? pan(s.mastcamPan) : pan })),
  setMastcamTilt: (tilt) =>
    set((s) => ({
      mastcamTilt: Math.max(-85, Math.min(90, typeof tilt === "function" ? tilt(s.mastcamTilt) : tilt)),
    })),
  setMastcamZoom: (zoom) => set({ mastcamZoom: Math.max(1.0, Math.min(4.0, zoom)) }),
  setMastcamFilter: (f) => set({ mastcamFilter: f }),
  resetMastcam: () => set({ mastcamPan: 0, mastcamTilt: -5, mastcamZoom: 1.0, mastcamFilter: "rgb" }),

  activeLeftTab: "sortie",
  setActiveLeftTab: (t) => set({ activeLeftTab: t }),

  activeRightTab: "telemetry",
  setActiveRightTab: (t) => set({ activeRightTab: t }),

  audioEnabled: false,
  setAudioEnabled: (enabled) => set({ audioEnabled: enabled }),

  activeScenario: null,
  setActiveScenario: (s) => set({ activeScenario: s }),

  exaggeration: 1,
  setExaggeration: (v) => set({ exaggeration: v }),

  horizonObs: 2,
  setHorizonObs: (v) => set({ horizonObs: v }),

  toast: null,
  setToast: (msg) => set({ toast: msg }),

  heatMode: 1,
  setHeatMode: (m) => set({ heatMode: m }),

  showSunRay: true,
  showEarthRay: true,
  toggleRay: (which) =>
    set((s) =>
      which === "sun"
        ? { showSunRay: !s.showSunRay }
        : { showEarthRay: !s.showEarthRay },
    ),

  // Default landing site: Artemis III candidate on Connecting Ridge (lat -89.5°, lon 45.0°)
  // High-illumination ridge crest outside Shackleton Crater bowl.
  roverSite: { x: 10721, y: 10721 },
  departTMs: Date.UTC(2026, 10, 20, 0, 0, 0),
  // The drive starts at the current mission time, so scrubbing the timeline
  // walks the rover forward and back along its path. Clamped strictly to the
  // 40km AOI bounds (±19,500 m) so the rover never leaves the terrain mesh.
  setRoverSite: (s) =>
    set({
      roverSite: s
        ? {
            x: Math.max(-19500, Math.min(19500, s.x)),
            y: Math.max(-19500, Math.min(19500, s.y)),
          }
        : null,
      sim: null,
      departTMs: s ? useTimeStore.getState().tMs : null,
      autonomyBatteryPct: s ? 89.4 : 89.4,
      plan: null,
      planCorridors: null,
    }),

  path: [],
  // Waypoint paths are strictly clamped to the 40km AOI boundaries.
  setPath: (p) =>
    set({
      path: p.map((pt) => ({
        ...pt,
        x: Math.max(-19500, Math.min(19500, pt.x)),
        y: Math.max(-19500, Math.min(19500, pt.y)),
      })),
      departTMs: useTimeStore.getState().tMs,
    }),

  plan: null,
  planCorridors: null,
  setPlan: (p, corridors = null) => set({ plan: p, planCorridors: corridors }),

  profile: DEFAULT_ROVER_PROFILE,
  setProfile: (p) => set({ profile: p }),

  sim: null,
  setSim: (s) => set({ sim: s }),

  ribbon: null,
  setRibbon: (r) => set({ ribbon: r }),

  duty: null,
  setDuty: (d) => set({ duty: d }),

  dutyTexture: null,
  setDutyTexture: (d) => set({ dutyTexture: d }),
  dutyMode: false,
  setDutyMode: (on) => set({ dutyMode: on }),

  infoOpen: false,
  setInfoOpen: (b) => set({ infoOpen: b }),
  tourActive: false,
  setTourActive: (b) => set({ tourActive: b }),
  sunSeekingMode: true,
  setSunSeekingMode: (b) => set({ sunSeekingMode: b }),

  pickMode: null,
  setPickMode: (m) => set({ pickMode: m }),

  viewMode: "local",
  setViewMode: (m) => set({ viewMode: m }),

  globeFocus: "moon",
  setGlobeFocus: (f) => set({ globeFocus: f }),

  orbitScaleMode: "true1to1",
  setOrbitScaleMode: (m) => set({ orbitScaleMode: m }),

  focus: null,
  requestFocus: (target, distance, dir) =>
    set({ focus: { target, distance, dir, nonce: Date.now() } }),

  coords: null,
  setCoords: (c) => set({ coords: c }),

  autonomyBatteryPct: 89.4,
  setAutonomyBatteryPct: (pct) => set({ autonomyBatteryPct: Math.max(0, Math.min(100, pct)) }),
}));

if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__UI_STORE__ = useUiStore;
}
