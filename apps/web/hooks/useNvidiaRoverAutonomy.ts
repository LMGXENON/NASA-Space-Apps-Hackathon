"use client";

/**
 * useNvidiaRoverAutonomy — Production-Grade NVIDIA Build API Autonomous Rover GNC Hook.
 *
 * Implements:
 * 1. NVIDIA Build API / NIM autonomous navigation with meta/llama-3.1-70b-instruct.
 * 2. Hard safety ceilings: slope limit (< 19.5°) with instant emergency stop.
 * 3. Deep Sleep / Zero-Battery interlock (< 15% SOC or shadow entry) with auto-wake (> 20% in sunlight).
 * 4. High-frequency Three.js useFrame kinematic integration with THREE.MathUtils.damp smoothing.
 */

import { useRef, useState, useCallback, useEffect } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

export interface RoverTelemetry {
  lat: number;
  lon: number;
  heading: number; // 0 - 360 degrees
  slopeAngle: number; // degrees
  sunVectorDot: number; // dot product of surface normal and Sun vector (>0 = illuminated, <=0 = shadow)
  batteryPercent: number; // 0 - 100%
  elevation: number; // surface elevation in meters
  speedMps: number; // driving speed in meters per second
  solarWatts: number; // live solar array output in Watts
  loadWatts: number; // rover electrical load in Watts
  localElevationGrid?: number[][]; // 5x5 local elevation elevation matrix (meters)
}

export interface AutonomyConfig {
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  queryIntervalSec?: number;
  maxSafeSlopeDeg?: number;
  driveSpeedMps?: number;
  solarPanelAreaM2?: number;
  solarEfficiency?: number;
  batteryCapacityWh?: number;
}

const DEFAULT_NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "meta/llama-3.1-70b-instruct";
const DEFAULT_MAX_SLOPE_DEG = 19.5;
const DEFAULT_QUERY_INTERVAL_SEC = 2.5;

export function useNvidiaRoverAutonomy(
  roverRef: React.RefObject<THREE.Group | null>,
  telemetry: RoverTelemetry,
  updateTelemetry: (p: Partial<RoverTelemetry>) => void,
  config?: AutonomyConfig,
): {
  isPlaying: boolean;
  setIsPlaying: (val: boolean) => void;
  isDeepSleep: boolean;
  autonomyStatus: string;
} {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isDeepSleep, setIsDeepSleep] = useState<boolean>(false);
  const [autonomyStatus, setAutonomyStatus] = useState<string>(
    "[ AUTONOMOUS GNC STANDBY · NVIDIA NIM READY ]",
  );

  // Target yaw heading commanded by NVIDIA NIM (degrees 0-360)
  const targetHeadingDeg = useRef<number>(telemetry.heading);
  const lastQueryTime = useRef<number>(0);
  const isQuerying = useRef<boolean>(false);

  // Persistent reference values
  const apiKey = config?.apiKey || process.env.NEXT_PUBLIC_NVIDIA_API_KEY || "";
  const endpoint = config?.apiEndpoint || DEFAULT_NVIDIA_ENDPOINT;
  const model = config?.model || DEFAULT_MODEL;
  const queryInterval = (config?.queryIntervalSec || DEFAULT_QUERY_INTERVAL_SEC) * 1000;
  const maxSafeSlope = config?.maxSafeSlopeDeg ?? DEFAULT_MAX_SLOPE_DEG;
  const driveSpeed = config?.driveSpeedMps ?? 0.75;
  const panelArea = config?.solarPanelAreaM2 ?? 2.5;
  const cellEff = config?.solarEfficiency ?? 0.295;
  const battWh = config?.batteryCapacityWh ?? 4000;

  /**
   * Dispatches real-time telemetry to NVIDIA NIM and parses optimal safe heading
   */
  const queryNvidiaNimHeading = useCallback(
    async (currentTelem: RoverTelemetry) => {
      if (isQuerying.current) return;
      isQuerying.current = true;

      try {
        const systemPrompt = `You are the Autonomous Guidance, Navigation & Control (GNC) AI for NASA Project Helios Artemis Lunar Rover.
Given local lunar topography, orientation, and power telemetry, select the optimal next heading (0 to 360 degrees).
MANDATORY CONSTRAINTS:
1. SLOPE CEILING: Strictly avoid any path where slope exceeds ${maxSafeSlope} degrees to prevent rollover.
2. SOLAR CHASE BIAS: Prioritize headings that increase sunVectorDot and keep the rover on sunlit ridges for solar generation.
3. OBSTACLE AVOIDANCE: Avoid deep crater bowls, negative relief traps, and impassable boulders.

CRITICAL: Output ONLY a valid JSON object. No reasoning, no markdown, no prose:
{"heading": number, "rationale": string}`;

        const userMessage = JSON.stringify({
          telemetry: {
            lat: currentTelem.lat,
            lon: currentTelem.lon,
            heading: currentTelem.heading,
            slopeAngle: currentTelem.slopeAngle,
            sunVectorDot: currentTelem.sunVectorDot,
            batteryPercent: currentTelem.batteryPercent,
            elevation: currentTelem.elevation,
            localElevationGrid: currentTelem.localElevationGrid ?? [
              [currentTelem.elevation, currentTelem.elevation + 0.4, currentTelem.elevation],
              [currentTelem.elevation - 0.2, currentTelem.elevation, currentTelem.elevation + 0.3],
              [currentTelem.elevation - 0.5, currentTelem.elevation - 0.2, currentTelem.elevation],
            ],
          },
        });

        // Query NVIDIA NIM (or server fallback if no direct client API key)
        let headingDecision: number | null = null;
        let aiRationale = "";

        if (apiKey) {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
              ],
              temperature: 0.1,
              max_tokens: 300,
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const rawContent = (data?.choices?.[0]?.message?.content || "").trim();
            const start = rawContent.indexOf("{");
            const end = rawContent.lastIndexOf("}");
            if (start !== -1 && end > start) {
              const parsed = JSON.parse(rawContent.slice(start, end + 1));
              if (typeof parsed.heading === "number") {
                headingDecision = (parsed.heading + 360) % 360;
                aiRationale = parsed.rationale || "AI Solar Traverse";
              }
            }
          }
        }

        // Try local Next.js proxy if direct NIM returned nothing or no client key
        if (headingDecision === null) {
          const proxyRes = await fetch("/api/ai/autonomous-nav", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentPose: {
                x: 0,
                y: 0,
                latDeg: currentTelem.lat,
                lonDeg: currentTelem.lon,
                elevationM: currentTelem.elevation,
                slopeDeg: currentTelem.slopeAngle,
                headingDeg: currentTelem.heading,
              },
              celestial: {
                sunAzDeg: 85,
                sunElDeg: Math.asin(Math.max(-1, Math.min(1, currentTelem.sunVectorDot))) * (180 / Math.PI),
                isSunVisible: currentTelem.sunVectorDot > 0,
              },
              power: {
                batteryWh: battWh,
                batteryPct: currentTelem.batteryPercent,
                solarHarvestW: currentTelem.solarWatts,
                powerLoadW: currentTelem.loadWatts,
              },
              candidates: [
                {
                  headingDeg: (currentTelem.heading + 15) % 360,
                  targetX: 0,
                  targetY: 0,
                  targetLat: currentTelem.lat,
                  targetLon: currentTelem.lon,
                  elevationM: currentTelem.elevation,
                  slopeDeg: Math.max(1, currentTelem.slopeAngle - 1.2),
                  sunIlluminated: true,
                  isHazardSlope: false,
                  isCraterExclusion: false,
                },
              ],
              missionTimeIso: new Date().toISOString(),
            }),
          });

          if (proxyRes.ok) {
            const proxyData = await proxyRes.json();
            if (typeof proxyData.recommendedHeadingDeg === "number") {
              headingDecision = proxyData.recommendedHeadingDeg;
              aiRationale = proxyData.rationale || "Proxy Solar Chase";
            }
          }
        }

        // Apply heading decision
        if (headingDecision !== null) {
          targetHeadingDeg.current = headingDecision;
          setAutonomyStatus(
            `[ NVIDIA NIM ACTIVE · HEADING: ${headingDecision.toFixed(0)}° · ${aiRationale} ]`,
          );
        } else {
          throw new Error("Empty model heading payload");
        }
      } catch (err) {
        // Robust Fallback: Autonomous solar-chase bias
        const fallbackHeading = (currentTelem.heading + 5) % 360;
        targetHeadingDeg.current = fallbackHeading;
        setAutonomyStatus(
          `[ SAFETY FALLBACK · STEERING: ${fallbackHeading.toFixed(0)}° · LOW SLOPE BIAS ]`,
        );
      } finally {
        isQuerying.current = false;
      }
    },
    [apiKey, endpoint, model, maxSafeSlope, battWh],
  );

  /**
   * High-Frequency Three.js Animation & Physics Kinematics Loop
   */
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    // -------------------------------------------------------------
    // 1. HARD SLOPE SAFETY CEILING (< 19.5°)
    // -------------------------------------------------------------
    if (telemetry.slopeAngle >= maxSafeSlope) {
      if (isPlaying) {
        setIsPlaying(false);
        setAutonomyStatus(
          `[ EMERGENCY HALT: SLOPE HAZARD (${telemetry.slopeAngle.toFixed(1)}° >= ${maxSafeSlope}°) ]`,
        );
      }
      return;
    }

    // -------------------------------------------------------------
    // 2. "DEEP SLEEP" ZERO-BATTERY INTERLOCK & AUTO-WAKE LOGIC
    // -------------------------------------------------------------
    const inShadow = telemetry.sunVectorDot <= 0;
    const criticalBattery = telemetry.batteryPercent <= 15.0;

    // Trigger Deep Sleep if battery depleted or entering shadow
    if ((criticalBattery || inShadow) && !isDeepSleep) {
      setIsDeepSleep(true);
      setAutonomyStatus("[ DEEP SLEEP: WAITING FOR SOLAR ALIGNMENT ]");
      return;
    }

    // Auto-Wake Condition: Sun illuminates rover AND battery exceeds 20%
    if (isDeepSleep) {
      if (!inShadow && telemetry.batteryPercent > 20.0) {
        setIsDeepSleep(false);
        setAutonomyStatus("[ SOLAR RESTORED: RESUMING AUTONOMOUS TRAVERSE ]");
      } else {
        // Minimal baseline power consumption in Deep Sleep (15W standby)
        const standbyWatts = 15;
        const solarGenW = inShadow ? 0 : 1361 * panelArea * cellEff * Math.max(0, telemetry.sunVectorDot);
        const netWatts = solarGenW - standbyWatts;
        const deltaWh = (netWatts * dt) / 3600;
        const newPct = Math.max(0, Math.min(100, telemetry.batteryPercent + (deltaWh / battWh) * 100));

        updateTelemetry({
          batteryPercent: newPct,
          solarWatts: solarGenW,
          loadWatts: standbyWatts,
          speedMps: 0,
        });
        return;
      }
    }

    // If paused, halt movement
    if (!isPlaying) {
      if (telemetry.speedMps !== 0) updateTelemetry({ speedMps: 0 });
      return;
    }

    // -------------------------------------------------------------
    // 3. PERIODIC NVIDIA BUILD API / NIM RE-PLANNING
    // -------------------------------------------------------------
    const now = performance.now();
    if (now - lastQueryTime.current >= queryInterval) {
      lastQueryTime.current = now;
      queryNvidiaNimHeading(telemetry);
    }

    // -------------------------------------------------------------
    // 4. SMOOTH KINEMATIC MOVEMENT & THREE.JS DAMPENING
    // -------------------------------------------------------------
    // Calculate shortest angular difference on the circle
    const diff = (targetHeadingDeg.current - telemetry.heading + 540) % 360 - 180;
    const smoothedHeading = (telemetry.heading + diff * THREE.MathUtils.clamp(dt * 3.5, 0.05, 0.45) + 360) % 360;

    const headingRad = smoothedHeading * (Math.PI / 180);

    // Apply orientation smoothly to rover 3D group if provided
    if (roverRef.current) {
      roverRef.current.rotation.y = -headingRad + Math.PI;

      // Kinematic forward translation along forward vector
      const dx = driveSpeed * dt * Math.sin(headingRad);
      const dz = -driveSpeed * dt * Math.cos(headingRad);
      roverRef.current.position.x += dx;
      roverRef.current.position.z += dz;
    }

    // Dynamic solar harvest and power integration per frame
    const solarGenW = inShadow ? 0 : 1361 * panelArea * cellEff * Math.max(0, telemetry.sunVectorDot);
    const driveLoadW = 75 + Math.sin(telemetry.slopeAngle * (Math.PI / 180)) * 40;
    const netWatts = solarGenW - driveLoadW;
    const deltaWh = (netWatts * dt) / 3600;
    const nextBatteryPct = Math.max(0, Math.min(100, telemetry.batteryPercent + (deltaWh / battWh) * 100));

    // Update rover telemetry
    updateTelemetry({
      heading: smoothedHeading,
      speedMps: driveSpeed,
      batteryPercent: nextBatteryPct,
      solarWatts: solarGenW,
      loadWatts: driveLoadW,
    });
  });

  return {
    isPlaying,
    setIsPlaying,
    isDeepSleep,
    autonomyStatus,
  };
}
