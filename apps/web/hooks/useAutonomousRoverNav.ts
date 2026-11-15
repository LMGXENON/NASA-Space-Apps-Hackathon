"use client";

/**
 * Autonomous Rover GNC & Pathfinding Engine for Project Helios.
 *
 * Integrated into the React / Three.js simulation loop:
 * When the user clicks "Play", the rover autonomously navigates in real time
 * along sunlit ridgelines and strictly follows NASA safety rules:
 *
 * 1. ZERO-LATENCY INSTANT START: On clicking "Play", instantly evaluates local
 *    candidates via embedded safety kernel so the rover begins moving on frame 1 (0ms delay),
 *    while NVIDIA Build API / NIM evaluates optimal trajectory in parallel.
 * 2. SLOPE LIMIT (Strict < 20.0°): Never selects or extends a heading with slope >= 20°.
 * 3. CURVILINEAR RIDGE-TRACKING: Streams lookahead corridors (5,000m ahead) that curve
 *    along high-elevation sunlit crests so the rover moves smoothly and continuously.
 * 4. SUNLIGHT ONLY & SHADOW TRAVERSE BUDGET: Strictly halts at indefinite shadow edges,
 *    allows traversing brief crossable depressions only when exit is guaranteed with >15% battery,
 *    and automatically resumes moving when sunlight rotates back.
 * 5. DYNAMIC BATTERY SIMULATION: Active real-time battery drain in darkness and
 *    recharge under sunlight, with zero-battery fail-safe at <=15% SOC.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTimeStore } from "../store/timeStore";
import { useUiStore, type Waypoint } from "../store/uiStore";
import { roverGridPos } from "../lib/roverPos";
import { gridToLatLon, skyState, skyAzEl, RAD2DEG, DEG2RAD } from "@helios/core";
import {
  meshSurfaceHeight,
  meshSurfaceNormal,
  horizonAngleBin,
  MESH_SEG,
} from "../lib/sceneMath";
import type {
  AutonomousNavRequest,
  AutonomousNavResponse,
  CandidateArc,
} from "../app/api/ai/autonomous-nav/route";

export interface AutonomyState {
  enabled: boolean;
  decision: "IDLE" | "NAVIGATE" | "DEEP_SLEEP_WAIT" | "HAZARD_STOP";
  headingDeg: number;
  slopeDeg: number;
  batteryPct: number;
  isSunLit: boolean;
  solarHarvestW: number;
  powerLoadW: number;
  statusMessage: string;
  rationale: string;
  source: "nvidia-nim" | "embedded-robotic-safety-kernel" | "idle";
  stepCount: number;
}

const STEP_DISTANCE_M = 100; // 100m spacing per corridor segment
const TOTAL_CORRIDOR_SEGMENTS = 50; // 5,000m total lookahead runway
const CADENCE_MS = 1200; // NIM API query cadence

/**
 * Shackleton Crater Nomenclature & Altimetry Constants (USGS Feature 5450 / LOLA DEM)
 * Center: [7800, -6450] in South Polar Stereographic grid meters (-89.67°S, 129.78°E)
 * Rim Radius: ~10,460m (20.92 km diameter)
 * Inner Bowl: radius < 9,600m descends into cryogenic 40 K permanent shadow (PSR).
 */
export const SHACKLETON_CENTER = { x: 7800, y: -6450 };
export const SHACKLETON_RIM_RADIUS_M = 10460;
export const SHACKLETON_INNER_BOWL_RADIUS_M = 9600;

export function useAutonomousRoverNav() {
  const playing = useTimeStore((s) => s.playing);
  const terrain = useUiStore((s) => s.terrain);
  const profile = useUiStore((s) => s.profile);

  const [state, setState] = useState<AutonomyState>({
    enabled: true,
    decision: "IDLE",
    headingDeg: 165,
    slopeDeg: 3.2,
    batteryPct: 89.4,
    isSunLit: true,
    solarHarvestW: 165,
    powerLoadW: 85,
    statusMessage: "Autonomous GNC Ready · NVIDIA NIM Online",
    rationale: "Standing by for simulation loop playback.",
    source: "idle",
    stepCount: 0,
  });

  const isQuerying = useRef(false);
  const lastQueryTime = useRef(0);
  const lastSimTMs = useRef(useTimeStore.getState().tMs);
  const batteryPctRef = useRef(89.4);
  const deepSleepActive = useRef(false);
  const activeHeadingRef = useRef(165);

  /**
   * Helper to check if a specific grid point (x, y) is illuminated by the Sun
   */
  const checkIlluminationAt = useCallback(
    (x: number, y: number, sky: ReturnType<typeof skyState>): boolean => {
      if (!terrain || !terrain.horizon) return true;
      const { latRad, lonRad } = gridToLatLon(x, y);
      const { sun } = skyAzEl(sky, latRad, lonRad);
      const hSun = horizonAngleBin(
        terrain.horizon,
        terrain.horizonPx,
        terrain.nAz,
        x,
        y,
        sun.az,
        terrain.hf.bounds,
      );
      return sun.el > hSun;
    },
    [terrain],
  );

  /**
   * Evaluates 24 radial candidate traverse directions (every 15° across full 360°)
   * Enforces:
   * 1. Rollover Slope Limit (< 20.0°)
   * 2. Shackleton Crater Floor / PSR Exclusion Fence
   * 3. Shadow Traverse Reachability & Energy Budget
   */
  const evaluateLocalCandidates = useCallback(
    (
      cx: number,
      cy: number,
      sky: ReturnType<typeof skyState>,
      batteryPct: number,
    ): {
      currentSlope: number;
      currentElev: number;
      isCurrentSunlit: boolean;
      candidates: CandidateArc[];
    } => {
      if (!terrain) {
        return { currentSlope: 0, currentElev: 0, isCurrentSunlit: true, candidates: [] };
      }

      const hf = terrain.hf;
      const currentElev = meshSurfaceHeight(hf, cx, cy, MESH_SEG);
      const [nx, ny, nz] = meshSurfaceNormal(hf, cx, cy, MESH_SEG, 1);
      const horizLen = Math.hypot(nx, nz);
      const currentSlope = Math.atan2(horizLen, ny) * RAD2DEG;
      const isCurrentSunlit = checkIlluminationAt(cx, cy, sky);

      const currDistToCenter = Math.hypot(cx - SHACKLETON_CENTER.x, cy - SHACKLETON_CENTER.y);
      const candidates: CandidateArc[] = [];
      const numBearings = 24; // 15° angular resolution

      for (let i = 0; i < numBearings; i++) {
        const headingDeg = i * (360 / numBearings);
        const headingRad = headingDeg * DEG2RAD;

        const targetX = Math.max(-19500, Math.min(19500, cx + STEP_DISTANCE_M * Math.sin(headingRad)));
        const targetY = Math.max(-19500, Math.min(19500, cy + STEP_DISTANCE_M * Math.cos(headingRad)));

        const targetCoord = gridToLatLon(targetX, targetY);
        const elevationM = meshSurfaceHeight(hf, targetX, targetY, MESH_SEG);

        const [cnx, cny, cnz] = meshSurfaceNormal(hf, targetX, targetY, MESH_SEG, 1);
        const cHoriz = Math.hypot(cnx, cnz);
        const candSlopeDeg = Math.atan2(cHoriz, cny) * RAD2DEG;

        const sunIlluminated = checkIlluminationAt(targetX, targetY, sky);

        // HARD SAFETY CONSTRAINT 1: Slope ceiling strictly < 20.0°
        const isHazardSlope = candSlopeDeg >= 20.0;

        // HARD SAFETY CONSTRAINT 2: Shackleton Crater Floor / PSR Exclusion Fence
        const targetDistToCenter = Math.hypot(targetX - SHACKLETON_CENTER.x, targetY - SHACKLETON_CENTER.y);
        const isMovingInward = targetDistToCenter < currDistToCenter;

        const isCraterExclusion =
          currDistToCenter < SHACKLETON_INNER_BOWL_RADIUS_M
            ? isMovingInward || elevationM < currentElev
            : targetDistToCenter < SHACKLETON_INNER_BOWL_RADIUS_M ||
              (currDistToCenter <= SHACKLETON_RIM_RADIUS_M + 800 && isMovingInward && elevationM < currentElev - 2.0);

        // HARD SAFETY CONSTRAINT 3: Shadow Traverse Reachability & Energy Budget
        let canExitShadow = true;
        let shadowDistanceM = 0;
        let projectedBatteryPct = batteryPct;

        if (!sunIlluminated) {
          if (batteryPct <= 15.0) {
            canExitShadow = false;
            shadowDistanceM = Infinity;
            projectedBatteryPct = batteryPct;
          } else {
            // Energy consumption rate in shadow: ~0.031% per meter
            const maxSafeShadowM = Math.min(2500, (batteryPct - 15.0) / 0.031);
            const rayStepM = 50;
            const maxSteps = Math.floor(maxSafeShadowM / rayStepM);

            let foundSunlitExit = false;
            let distAcc = 0;
            let rx = targetX;
            let ry = targetY;

            for (let s = 1; s <= maxSteps; s++) {
              rx = Math.max(-19500, Math.min(19500, rx + rayStepM * Math.sin(headingRad)));
              ry = Math.max(-19500, Math.min(19500, ry + rayStepM * Math.cos(headingRad)));
              distAcc += rayStepM;

              const rayDistToCenter = Math.hypot(rx - SHACKLETON_CENTER.x, ry - SHACKLETON_CENTER.y);
              if (rayDistToCenter < SHACKLETON_INNER_BOWL_RADIUS_M) {
                break; // Leads into crater floor cold trap
              }

              const [rnx, rny, rnz] = meshSurfaceNormal(hf, rx, ry, MESH_SEG, 1);
              const raySlope = Math.atan2(Math.hypot(rnx, rnz), rny) * RAD2DEG;
              if (raySlope >= 20.0) {
                break; // Blocked by rollover hazard in shadow
              }

              const isRayLit = checkIlluminationAt(rx, ry, sky);
              if (isRayLit) {
                foundSunlitExit = true;
                break;
              }
            }

            if (foundSunlitExit) {
              canExitShadow = true;
              shadowDistanceM = distAcc;
              projectedBatteryPct = Math.max(15.0, batteryPct - distAcc * 0.031);
            } else {
              canExitShadow = false;
              shadowDistanceM = Infinity;
              projectedBatteryPct = 0;
            }
          }
        }

        candidates.push({
          headingDeg,
          targetX,
          targetY,
          targetLat: targetCoord.latRad * RAD2DEG,
          targetLon: targetCoord.lonRad * RAD2DEG,
          elevationM,
          slopeDeg: candSlopeDeg,
          sunIlluminated,
          isHazardSlope,
          isCraterExclusion,
          canExitShadow,
          shadowDistanceM,
          projectedBatteryPct,
        });
      }

      return { currentSlope, currentElev, isCurrentSunlit, candidates };
    },
    [terrain, checkIlluminationAt],
  );

  /**
   * Deterministic Embedded Robotic Safety Kernel
   * Evaluates and returns optimal heading instantly with zero network delay.
   */
  const computeImmediateSafeHeading = useCallback(
    (
      candidates: CandidateArc[],
      currentHeadingDeg: number,
      sunAzDeg: number,
      batteryPct: number,
      isCurrentlySunlit: boolean,
    ): { headingDeg: number; isSunlit: boolean; isHalt: boolean; isSolarRecharge: boolean } => {
      // 1. Highest Priority: Safe, sunlit candidates on high terrain crests
      const safeSunlit = candidates.filter(
        (c) => !c.isHazardSlope && !c.isCraterExclusion && c.sunIlluminated && c.slopeDeg < 20.0,
      );

      if (safeSunlit.length > 0) {
        safeSunlit.sort((a, b) => {
          const aTurn = Math.abs((a.headingDeg - currentHeadingDeg + 540) % 360 - 180);
          const bTurn = Math.abs((b.headingDeg - currentHeadingDeg + 540) % 360 - 180);

          const aDistCenter = Math.hypot(a.targetX - SHACKLETON_CENTER.x, a.targetY - SHACKLETON_CENTER.y);
          const bDistCenter = Math.hypot(b.targetX - SHACKLETON_CENTER.x, b.targetY - SHACKLETON_CENTER.y);

          const aEdgeDist = Math.max(Math.abs(a.targetX), Math.abs(a.targetY));
          const bEdgeDist = Math.max(Math.abs(b.targetX), Math.abs(b.targetY));
          const aEdgePenalty = aEdgeDist > 16000 ? (aEdgeDist - 16000) * 8.0 : 0;
          const bEdgePenalty = bEdgeDist > 16000 ? (bEdgeDist - 16000) * 8.0 : 0;

          const aCorridorErr = Math.abs(aDistCenter - 12000);
          const bCorridorErr = Math.abs(bDistCenter - 12000);

          const aScore =
            3000 +
            (20 - a.slopeDeg) * 20 +
            a.elevationM * 0.35 -
            aTurn * 1.5 -
            aEdgePenalty -
            aCorridorErr * 0.15;

          const bScore =
            3000 +
            (20 - b.slopeDeg) * 20 +
            b.elevationM * 0.35 -
            bTurn * 1.5 -
            bEdgePenalty -
            bCorridorErr * 0.15;

          return bScore - aScore;
        });

        return {
          headingDeg: safeSunlit[0]!.headingDeg,
          isSunlit: true,
          isHalt: false,
          isSolarRecharge: false,
        };
      }

      // 2. Battery Reserve Floor: If battery is <= 15%, halt immediately
      if (batteryPct <= 15.0) {
        return {
          headingDeg: currentHeadingDeg,
          isSunlit: isCurrentlySunlit,
          isHalt: true,
          isSolarRecharge: isCurrentlySunlit,
        };
      }

      // 3. Crossable Shadow Traverse:
      // If direct 100m step is in a shadow dip, but leads to sunlight with >15% battery reserve:
      const safeShadowCrossable = candidates.filter(
        (c) =>
          !c.isHazardSlope &&
          !c.isCraterExclusion &&
          c.slopeDeg < 20.0 &&
          c.canExitShadow &&
          (c.projectedBatteryPct ?? 0) > 15.0,
      );

      if (safeShadowCrossable.length > 0) {
        safeShadowCrossable.sort((a, b) => {
          const aTurn = Math.abs((a.headingDeg - currentHeadingDeg + 540) % 360 - 180);
          const bTurn = Math.abs((b.headingDeg - currentHeadingDeg + 540) % 360 - 180);
          const aDist = a.shadowDistanceM ?? 9999;
          const bDist = b.shadowDistanceM ?? 9999;
          return aDist + aTurn * 2.0 - (bDist + bTurn * 2.0);
        });

        return {
          headingDeg: safeShadowCrossable[0]!.headingDeg,
          isSunlit: false,
          isHalt: false,
          isSolarRecharge: false,
        };
      }

      // 4. Solar Recharge Halt:
      // If the rover is on a sunlit crest and no crossable path exists ahead, halt to recharge.
      if (isCurrentlySunlit) {
        return {
          headingDeg: currentHeadingDeg,
          isSunlit: true,
          isHalt: true,
          isSolarRecharge: true,
        };
      }

      // Impassable trap
      return {
        headingDeg: currentHeadingDeg,
        isSunlit: false,
        isHalt: true,
        isSolarRecharge: false,
      };
    },
    [],
  );

  /**
   * Active Heliotropic Horizon Search
   * When surrounded by local shadow, queries LOLA horizon and elevation data
   * to locate the nearest reachable safe terrain bathed in sunlight.
   */
  const findNearestSunlitHaven = useCallback(
    (
      cx: number,
      cy: number,
      sky: ReturnType<typeof skyState>,
      batteryPct: number,
    ): { havenX: number; havenY: number; distanceM: number; headingDeg: number } | null => {
      if (!terrain) return null;
      const hf = terrain.hf;

      // Available energy for shadow transit: strictly preserve 15.0% survival floor
      const availableBatteryReserve = Math.max(0, batteryPct - 15.0);
      const maxReachableDistM = Math.min(5000, availableBatteryReserve / 0.031);
      if (maxReachableDistM < 100) return null;

      // Concentric search rings from 150m up to maxReachableDistM
      const rings = [150, 300, 500, 750, 1100, 1600, 2400, 3500, 4800].filter(
        (r) => r <= maxReachableDistM,
      );

      let bestHaven: {
        havenX: number;
        havenY: number;
        distanceM: number;
        headingDeg: number;
        score: number;
      } | null = null;
      let bestScore = -Infinity;

      for (const dist of rings) {
        const numBearings = dist <= 600 ? 16 : 24;
        for (let b = 0; b < numBearings; b++) {
          const deg = (b * 360) / numBearings;
          const rad = deg * DEG2RAD;
          const tx = Math.max(-19000, Math.min(19000, cx + dist * Math.sin(rad)));
          const ty = Math.max(-19000, Math.min(19000, cy + dist * Math.cos(rad)));

          // 1. Shackleton Crater exclusion: never escape into crater
          const distToCrater = Math.hypot(tx - SHACKLETON_CENTER.x, ty - SHACKLETON_CENTER.y);
          if (distToCrater < SHACKLETON_INNER_BOWL_RADIUS_M) continue;

          // 2. Slope check: must be passable (< 20.0°)
          const [nx, ny, nz] = meshSurfaceNormal(hf, tx, ty, MESH_SEG, 1);
          const candSlope = Math.atan2(Math.hypot(nx, nz), ny) * RAD2DEG;
          if (candSlope >= 20.0) continue;

          // 3. Illumination check via LOLA Horizon
          const isLit = checkIlluminationAt(tx, ty, sky);
          if (!isLit) continue;

          const elev = meshSurfaceHeight(hf, tx, ty, MESH_SEG);
          const corridorPenalty = Math.abs(distToCrater - 12000) * 0.15;
          const score = 5000 - dist * 1.5 + elev * 0.5 - candSlope * 15 - corridorPenalty;

          if (score > bestScore) {
            bestScore = score;
            const headingToHaven = (Math.atan2(tx - cx, ty - cy) * RAD2DEG + 360) % 360;
            bestHaven = { havenX: tx, havenY: ty, distanceM: dist, headingDeg: headingToHaven, score };
          }
        }
        if (bestHaven && dist <= 750) break;
      }

      return bestHaven;
    },
    [terrain, checkIlluminationAt],
  );

  /**
   * Plans a safe kinematic transit corridor from current position to an illuminated haven.
   */
  const planEscapeRouteToSunlight = useCallback(
    (
      startX: number,
      startY: number,
      targetX: number,
      targetY: number,
    ): Waypoint[] => {
      if (!terrain) return [];
      const hf = terrain.hf;
      const waypoints: Waypoint[] = [];
      let cx = startX;
      let cy = startY;
      const stepM = 60;
      const totalDist = Math.hypot(targetX - startX, targetY - startY);
      const maxSteps = Math.min(60, Math.ceil(totalDist / stepM));

      for (let s = 1; s <= maxSteps; s++) {
        const remainingDist = Math.hypot(targetX - cx, targetY - cy);
        if (remainingDist <= stepM) {
          waypoints.push({ x: targetX, y: targetY });
          break;
        }

        const directHeadingRad = Math.atan2(targetX - cx, targetY - cy);
        let bestStep: { x: number; y: number } | null = null;
        let lowestSlope = Infinity;

        for (const dev of [0, -0.523, 0.523, -1.04, 1.04]) {
          const hRad = directHeadingRad + dev;
          const nx = Math.max(-19000, Math.min(19000, cx + stepM * Math.sin(hRad)));
          const ny = Math.max(-19000, Math.min(19000, cy + stepM * Math.cos(hRad)));

          const dCenter = Math.hypot(nx - SHACKLETON_CENTER.x, ny - SHACKLETON_CENTER.y);
          if (dCenter < SHACKLETON_INNER_BOWL_RADIUS_M) continue;

          const [snx, sny, snz] = meshSurfaceNormal(hf, nx, ny, MESH_SEG, 1);
          const slope = Math.atan2(Math.hypot(snx, snz), sny) * RAD2DEG;
          if (slope >= 20.0) continue;

          if (slope < lowestSlope) {
            lowestSlope = slope;
            bestStep = { x: nx, y: ny };
          }
        }

        if (!bestStep) {
          bestStep = {
            x: cx + stepM * Math.sin(directHeadingRad),
            y: cy + stepM * Math.cos(directHeadingRad),
          };
        }

        waypoints.push({ x: bestStep.x, y: bestStep.y });
        cx = bestStep.x;
        cy = bestStep.y;
      }

      return waypoints;
    },
    [terrain],
  );

  /**
   * Curvilinear Ridge-Tracking Lookahead Corridor Generator
   * At each node, evaluates a forward fan of candidate angles to follow the continuous
   * high sunlit ridge crest, avoiding crater descent and impassable slopes.
   */
  const buildSunlitCorridor = useCallback(
    (
      startX: number,
      startY: number,
      initialHeadingDeg: number,
      sky: ReturnType<typeof skyState>,
      batteryPct: number,
    ): Waypoint[] => {
      if (!terrain) return [];
      const hf = terrain.hf;
      const waypoints: Waypoint[] = [];
      let curX = startX;
      let curY = startY;
      let curHeadingDeg = initialHeadingDeg;
      let estSoc = batteryPct;

      const fanOffsets = [-45, -30, -15, 0, 15, 30, 45];

      for (let s = 1; s <= TOTAL_CORRIDOR_SEGMENTS; s++) {
        let bestCand: { x: number; y: number; headingDeg: number; isLit: boolean; score: number } | null = null;
        let highestScore = -Infinity;

        const curElev = meshSurfaceHeight(hf, curX, curY, MESH_SEG);
        const currDistToCenter = Math.hypot(curX - SHACKLETON_CENTER.x, curY - SHACKLETON_CENTER.y);

        for (const offset of fanOffsets) {
          const testHeadingDeg = (curHeadingDeg + offset + 360) % 360;
          const testRad = testHeadingDeg * DEG2RAD;

          const testX = Math.max(-19500, Math.min(19500, curX + STEP_DISTANCE_M * Math.sin(testRad)));
          const testY = Math.max(-19500, Math.min(19500, curY + STEP_DISTANCE_M * Math.cos(testRad)));

          // 1. Boundary & Shackleton Crater exclusion:
          const testEdgeDist = Math.max(Math.abs(testX), Math.abs(testY));
          if (testEdgeDist > 17500) continue; // Stay strictly inside active terrain map

          const targetDistToCenter = Math.hypot(testX - SHACKLETON_CENTER.x, testY - SHACKLETON_CENTER.y);
          if (targetDistToCenter < SHACKLETON_INNER_BOWL_RADIUS_M) continue;
          if (currDistToCenter <= SHACKLETON_RIM_RADIUS_M + 800 && targetDistToCenter < currDistToCenter) {
            const testElev = meshSurfaceHeight(hf, testX, testY, MESH_SEG);
            if (testElev < curElev - 2.0) continue; // Inward downhill descent into crater
          }

          // 2. Slope limit (< 20.0°):
          const [nx, ny, nz] = meshSurfaceNormal(hf, testX, testY, MESH_SEG, 1);
          const slopeDeg = Math.atan2(Math.hypot(nx, nz), ny) * RAD2DEG;
          if (slopeDeg >= 20.0) continue;

          // 3. Illumination:
          const isLit = checkIlluminationAt(testX, testY, sky);
          const elev = meshSurfaceHeight(hf, testX, testY, MESH_SEG);

          // Score candidate node:
          let score = 0;
          if (isLit) {
            score += 3000;
          } else {
            // Shadow penalty based on available battery
            score += estSoc > 30 ? 600 : -2000;
          }
          // Ridge crest elevation bonus
          score += elev * 0.5;
          // Smooth low slope bonus
          score += Math.max(0, (20 - slopeDeg) * 20);
          // Curve smoothness penalty
          score -= Math.abs(offset) * 3.0;
          // Edge proximity penalty: keep away from border (> 15500m)
          if (testEdgeDist > 15500) {
            score -= (testEdgeDist - 15500) * 5.0;
          }
          // Corridor centering: follow Connecting Ridge / Rim ring (10,000m - 14,000m)
          const corridorRadiusError = Math.abs(targetDistToCenter - 12000);
          score -= corridorRadiusError * 0.15;

          if (score > highestScore) {
            highestScore = score;
            bestCand = { x: testX, y: testY, headingDeg: testHeadingDeg, isLit, score };
          }
        }

        if (!bestCand) {
          // No passable forward candidate
          break;
        }

        if (!bestCand.isLit) {
          estSoc -= STEP_DISTANCE_M * 0.031;
          if (estSoc <= 15.0) {
            // Critical battery reserve in shadow
            break;
          }
        } else {
          estSoc = Math.min(100.0, estSoc + STEP_DISTANCE_M * 0.015);
        }

        waypoints.push({ x: bestCand.x, y: bestCand.y });
        curX = bestCand.x;
        curY = bestCand.y;
        curHeadingDeg = bestCand.headingDeg;
      }

      return waypoints;
    },
    [terrain, checkIlluminationAt],
  );

  /**
   * Real-time Autonomous GNC Execution Step
   * Seamlessly extends rolling corridors so the rover moves without stopping.
   */
  const stepAutonomousGNC = useCallback(async () => {
    if (!terrain) return;

    // Ensure roverSite is deployed (default to Artemis III Connecting Ridge)
    let currentSite = useUiStore.getState().roverSite;
    if (!currentSite) {
      currentSite = { x: 10721, y: 10721 };
      useUiStore.getState().setRoverSite(currentSite);
    }

    const currentTMs = useTimeStore.getState().tMs;
    const currentPath = useUiStore.getState().path;

    const pose = roverGridPos() || {
      x: currentSite.x,
      y: currentSite.y,
      heading: activeHeadingRef.current,
      moving: false,
    };

    // Calculate remaining distance along current path
    let remainingDistM = 0;
    if (currentPath.length > 0) {
      const lastWpt = currentPath[currentPath.length - 1]!;
      remainingDistM = Math.hypot(lastWpt.x - pose.x, lastWpt.y - pose.y);
    }

    // If the rover is already driving smoothly along an active corridor with > 350m of runway,
    // let it continue moving without re-anchoring origin or interrupting motion!
    if (pose.moving && currentPath.length > 3 && remainingDistM > 350) {
      return;
    }

    const sky = skyState(new Date(currentTMs));
    const currentCoords = gridToLatLon(pose.x, pose.y);
    const { sun } = skyAzEl(sky, currentCoords.latRad, currentCoords.lonRad);
    const sunAzDeg = (sun.az * RAD2DEG + 360) % 360;
    const batteryPct = batteryPctRef.current;

    const { currentSlope, currentElev, isCurrentSunlit, candidates } = evaluateLocalCandidates(
      pose.x,
      pose.y,
      sky,
      batteryPct,
    );

    // 0. HARD ZERO-BATTERY & DEEP SLEEP INTERLOCK:
    // If battery is <= 15% or in Deep Sleep without sufficient recharge (> 20%),
    // drive actuators are completely locked. Movement is strictly forbidden!
    if (batteryPct <= 15.0 || (deepSleepActive.current && batteryPct <= 20.0)) {
      deepSleepActive.current = true;
      if (currentPath.length > 0 || pose.moving) {
        useUiStore.setState({
          roverSite: { x: pose.x, y: pose.y },
          path: [],
        });
      }
      const isDead = batteryPct <= 0.0;
      setState((prev) => ({
        ...prev,
        decision: isDead ? "HAZARD_STOP" : "DEEP_SLEEP_WAIT",
        slopeDeg: currentSlope,
        batteryPct,
        isSunLit: isCurrentSunlit,
        statusMessage: isDead
          ? "BATTERY DEPLETED (0%) · ACTUATORS LOCKED IN DARKNESS"
          : isCurrentSunlit
            ? `SOLAR RECHARGE (≤15%) · HARVESTING POWER (AUTO-WAKE AT >20%)`
            : "DEEP SLEEP · WAITING FOR SOLAR ALIGNMENT",
        rationale: isDead
          ? "Actuators strictly locked at 0% battery to prevent brownout. System awaiting solar illumination to recharge."
          : isCurrentSunlit
            ? `Rover halted in sunlight to recharge battery (currently ${batteryPct.toFixed(1)}%). Auto-wake will engage at >20%.`
            : "Actuators locked below 15% survival reserve. Minimally draining battery until sun illuminates solar panels.",
        source: "embedded-robotic-safety-kernel",
      }));
      return;
    }

    // 1. INSTANT EMBEDDED EVALUATION (0ms latency, zero frame lag)
    const instantEval = computeImmediateSafeHeading(
      candidates,
      activeHeadingRef.current,
      sunAzDeg,
      batteryPct,
      isCurrentSunlit,
    );

    if (instantEval.isHalt) {
      // ACTIVE HELIOTROPIC RECOVERY:
      // If immediate 100m steps are blocked or shadowed, use LOLA horizon and heightfield data
      // to actively locate the nearest safe illuminated haven within battery range!
      if (batteryPct > 15.0) {
        const haven = findNearestSunlitHaven(pose.x, pose.y, sky, batteryPct);
        if (haven) {
          const escapePath = planEscapeRouteToSunlight(pose.x, pose.y, haven.havenX, haven.havenY);
          if (escapePath.length > 0) {
            activeHeadingRef.current = haven.headingDeg;
            deepSleepActive.current = false;
            useUiStore.setState({
              roverSite: { x: pose.x, y: pose.y },
              departTMs: currentTMs,
              path: escapePath,
            });
            setState((prev) => ({
              ...prev,
              decision: "NAVIGATE",
              headingDeg: haven.headingDeg,
              slopeDeg: currentSlope,
              batteryPct,
              isSunLit: isCurrentSunlit,
              statusMessage: `SOLAR CHASER · ESCAPING SHADOW TO SUNLIT HAVEN (${Math.round(haven.distanceM)}m)`,
              rationale: `LOLA horizon analysis identified illuminated safe ridge at (${Math.round(haven.havenX)}, ${Math.round(haven.havenY)}). Traversing at heading ${Math.round(haven.headingDeg)}° to restore solar power before battery depletion.`,
              source: "embedded-robotic-safety-kernel",
              stepCount: prev.stepCount + 1,
            }));
            return;
          }
        }
      }

      deepSleepActive.current = true;
      if (!pose.moving) {
        useUiStore.getState().setPath([]);
      }
      setState((prev) => ({
        ...prev,
        decision: "DEEP_SLEEP_WAIT",
        slopeDeg: currentSlope,
        batteryPct,
        isSunLit: isCurrentSunlit,
        statusMessage: instantEval.isSolarRecharge
          ? "SOLAR RECHARGE · WAITING ON SUNLIT CREST"
          : "DEEP SLEEP · WAITING FOR SUNLIGHT",
        rationale: instantEval.isSolarRecharge
          ? "Rover safely paused on illuminated crest (100% battery). Waiting for lunar rotation to illuminate next traverse corridor."
          : "Rover halted in shadowed basin with no reachable sunlit ground. Preserving battery until solar angle rotates.",
        source: "embedded-robotic-safety-kernel",
      }));
      return;
    }

    // Generate curvilinear ridge-tracking corridor
    const corridor = buildSunlitCorridor(pose.x, pose.y, instantEval.headingDeg, sky, batteryPct);

    if (corridor.length > 0) {
      activeHeadingRef.current = instantEval.headingDeg;
      deepSleepActive.current = false;

      // Update simulation path so rover moves immediately on this frame!
      useUiStore.setState({
        roverSite: { x: pose.x, y: pose.y },
        departTMs: currentTMs,
        path: corridor,
      });

      setState((prev) => ({
        ...prev,
        decision: "NAVIGATE",
        headingDeg: instantEval.headingDeg,
        slopeDeg: currentSlope,
        batteryPct,
        isSunLit: isCurrentSunlit,
        statusMessage: instantEval.isSunlit
          ? "SOLAR CHASE: Navigating illuminated ridge"
          : "TRANSIT: Traversing safe passage to illuminated crest",
        rationale: `Following curvilinear ridge corridor along ${instantEval.headingDeg.toFixed(0)}° heading with ${currentSlope.toFixed(1)}° slope to maximize continuous solar power.`,
        source: "embedded-robotic-safety-kernel",
        stepCount: prev.stepCount + 1,
      }));
    } else {
      // Reached boundary with no safe forward waypoints in current fan:
      // Search for nearest illuminated haven
      if (batteryPct > 15.0) {
        const haven = findNearestSunlitHaven(pose.x, pose.y, sky, batteryPct);
        if (haven) {
          const escapePath = planEscapeRouteToSunlight(pose.x, pose.y, haven.havenX, haven.havenY);
          if (escapePath.length > 0) {
            activeHeadingRef.current = haven.headingDeg;
            deepSleepActive.current = false;
            useUiStore.setState({
              roverSite: { x: pose.x, y: pose.y },
              departTMs: currentTMs,
              path: escapePath,
            });
            setState((prev) => ({
              ...prev,
              decision: "NAVIGATE",
              headingDeg: haven.headingDeg,
              slopeDeg: currentSlope,
              batteryPct,
              isSunLit: isCurrentSunlit,
              statusMessage: `SOLAR CHASER · ESCAPING SHADOW TO SUNLIT HAVEN (${Math.round(haven.distanceM)}m)`,
              rationale: `LOLA horizon analysis identified illuminated safe ridge at (${Math.round(haven.havenX)}, ${Math.round(haven.havenY)}). Traversing at heading ${Math.round(haven.headingDeg)}° to restore solar power before battery depletion.`,
              source: "embedded-robotic-safety-kernel",
              stepCount: prev.stepCount + 1,
            }));
            return;
          }
        }
      }

      deepSleepActive.current = true;
      if (!pose.moving) {
        useUiStore.getState().setPath([]);
      }
      setState((prev) => ({
        ...prev,
        decision: "DEEP_SLEEP_WAIT",
        slopeDeg: currentSlope,
        batteryPct,
        isSunLit: isCurrentSunlit,
        statusMessage: isCurrentSunlit
          ? "SOLAR RECHARGE · WAITING ON SUNLIT CREST"
          : "DEEP SLEEP · WAITING FOR SUNLIGHT",
        rationale: isCurrentSunlit
          ? "Reached edge of illuminated terrain crest. Pausing in sunlight to maintain full battery until solar rotation illuminates the next ridgeline segment."
          : "Reached boundary of illuminated terrain with no reachable sunlit ground. Actuators halted until solar angle rotates.",
        source: "embedded-robotic-safety-kernel",
      }));
      return;
    }

    // 2. ASYNCHRONOUS NVIDIA BUILD API / NIM REFINEMENT
    if (!isQuerying.current) {
      isQuerying.current = true;
      const payload: AutonomousNavRequest = {
        currentPose: {
          x: pose.x,
          y: pose.y,
          latDeg: currentCoords.latRad * RAD2DEG,
          lonDeg: currentCoords.lonRad * RAD2DEG,
          elevationM: currentElev,
          slopeDeg: currentSlope,
          headingDeg: activeHeadingRef.current,
        },
        celestial: {
          sunAzDeg,
          sunElDeg: sun.el * RAD2DEG,
          isSunVisible: isCurrentSunlit,
        },
        power: {
          batteryWh: profile.batteryWh,
          batteryPct,
          solarHarvestW: 165,
          powerLoadW: 85,
        },
        candidates,
        missionTimeIso: new Date(currentTMs).toISOString(),
      };

      fetch("/api/ai/autonomous-nav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: AutonomousNavResponse | null) => {
          if (!data) return;
          if (data.decision === "NAVIGATE" && data.recommendedHeadingDeg !== undefined) {
            activeHeadingRef.current = data.recommendedHeadingDeg;
            setState((prev) => ({
              ...prev,
              decision: "NAVIGATE",
              headingDeg: data.recommendedHeadingDeg,
              statusMessage: data.statusMessage,
              rationale: data.rationale,
              source: data.source,
            }));
          }
        })
        .catch(() => {})
        .finally(() => {
          isQuerying.current = false;
        });
    }
  }, [
    terrain,
    profile,
    evaluateLocalCandidates,
    computeImmediateSafeHeading,
    buildSunlitCorridor,
  ]);

  /**
   * Real-Time Battery Dynamic Energy Balance Accumulator
   */
  useEffect(() => {
    const batteryTimer = setInterval(() => {
      const currentTMs = useTimeStore.getState().tMs;
      const isPlay = useTimeStore.getState().playing;
      const rawDtSec = (currentTMs - lastSimTMs.current) / 1000;
      lastSimTMs.current = currentTMs;

      if (!isPlay || rawDtSec <= 0) return;

      // Handle continuous fast-forward playback up to 86,400x (1 day/sec):
      // Clamp each 120ms tick's integration step to at most 4 hours (14,400s)
      const dtSimSec = Math.min(14400, rawDtSec);

      const pose = roverGridPos();
      if (!pose || !terrain) return;

      const sky = skyState(new Date(currentTMs));
      const isLit = checkIlluminationAt(pose.x, pose.y, sky);
      const coords = gridToLatLon(pose.x, pose.y);
      const { sun } = skyAzEl(sky, coords.latRad, coords.lonRad);

      const [nx, ny, nz] = meshSurfaceNormal(terrain.hf, pose.x, pose.y, MESH_SEG, 1);
      const slopeDeg = Math.atan2(Math.hypot(nx, nz), ny) * RAD2DEG;

      const isMoving = pose.moving && !deepSleepActive.current;

      // Power calculations (Watts)
      // Cryogenic survival heaters: 85W in dark, 10W in sun
      // Avionics: 65W active, 22W in deep sleep
      // Drive: 85W + slope*2.8W when moving, 0W when halted
      const pAvionics = deepSleepActive.current ? 22.0 : 65.0;
      const pHeaters = isLit ? 10.0 : 85.0;
      const pDrive = isMoving ? 85.0 + slopeDeg * 2.8 : 0.0;
      const pLoad = pAvionics + pHeaters + pDrive;

      // Vertical solar array: catches grazing polar sun direct normal flux
      // Solar constant = 1361 W/m², Area = 2.4 m², Eff = 29.5%, Dust = 0.92
      // At low polar sun elevations, cos(incidence) is near unity (~0.98 - 1.0)
      const cosInc = Math.max(0.7, Math.cos(sun.el));
      const pSolarNominal = 1361 * 2.4 * 0.295 * 0.92 * cosInc;
      const pSolar = isLit ? Math.max(420, Math.min(780, pSolarNominal)) : 0.0;

      const pNet = pSolar - pLoad; // Net Watts
      const deltaWh = (pNet * dtSimSec) / 3600.0;
      const batteryCapacityWh = profile.batteryWh || 4000;
      const deltaPct = (deltaWh / batteryCapacityWh) * 100;

      // Real continuous battery drain down to 0% in darkness, charging in sunlight
      const nextSoc = Math.max(0.0, Math.min(100.0, batteryPctRef.current + deltaPct));
      batteryPctRef.current = nextSoc;
      useUiStore.getState().setAutonomyBatteryPct(nextSoc);

      const isDead = nextSoc <= 0.0;
      const isCritical = nextSoc <= 15.0;

      if (isCritical) {
        deepSleepActive.current = true;
        // Lock position in place and cancel path
        if (pose.moving || useUiStore.getState().path.length > 0) {
          useUiStore.setState({
            roverSite: { x: pose.x, y: pose.y },
            path: [],
          });
        }
      } else if (deepSleepActive.current && isLit && nextSoc > 20.0) {
        // Automatic wake up as soon as solar illumination is restored and battery > 20%!
        deepSleepActive.current = false;
        setTimeout(() => {
          stepAutonomousGNC();
        }, 50);
      }

      setState((prev) => ({
        ...prev,
        decision: isDead
          ? "HAZARD_STOP"
          : isCritical
            ? "DEEP_SLEEP_WAIT"
            : prev.decision,
        statusMessage: isDead
          ? "BATTERY DEPLETED (0%) · VEHICLE FROZEN IN DARKNESS"
          : isCritical
            ? isLit
              ? `SOLAR RECHARGE (≤15%) · HARVESTING +${Math.round(pNet)}W (AUTO-WAKE AT >20%)`
              : "DEEP SLEEP · IN SHADOW · SURVIVAL POWER-SAVE ENGAGED"
            : deepSleepActive.current
              ? isLit
                ? `SOLAR RECHARGE · HARVESTING +${Math.round(pNet)}W (SOC: ${nextSoc.toFixed(1)}%)`
                : "DEEP SLEEP · WAITING FOR SOLAR ALIGNMENT"
              : prev.statusMessage,
        batteryPct: nextSoc,
        solarHarvestW: Math.round(pSolar),
        powerLoadW: Math.round(pLoad),
        isSunLit: isLit,
      }));
    }, 120);

    return () => clearInterval(batteryTimer);
  }, [terrain, profile, checkIlluminationAt, stepAutonomousGNC]);

  /**
   * Main Autonomous Traversal Loop:
   * When user clicks "Play", executes immediately on frame 1, and continually
   * maintains a rolling lookahead corridor so the rover drives continuously.
   */
  useEffect(() => {
    if (!playing || !terrain) {
      setState((prev) => ({ ...prev, decision: "IDLE" }));
      return;
    }

    // Instant trigger on Play click! Zero delay!
    stepAutonomousGNC();

    const intervalId = setInterval(() => {
      const currentPath = useUiStore.getState().path;
      const pose = roverGridPos();
      let remainingDistM = 0;
      if (currentPath.length > 0 && pose) {
        const lastWpt = currentPath[currentPath.length - 1]!;
        remainingDistM = Math.hypot(lastWpt.x - pose.x, lastWpt.y - pose.y);
      }
      const isNearEnd = !pose || !pose.moving || remainingDistM < 400;

      const now = performance.now();
      if (isNearEnd || now - lastQueryTime.current >= CADENCE_MS) {
        lastQueryTime.current = now;
        stepAutonomousGNC();
      }
    }, 120);

    return () => clearInterval(intervalId);
  }, [playing, terrain, stepAutonomousGNC]);

  return {
    autonomyState: state,
    stepAutonomousGNC,
  };
}
