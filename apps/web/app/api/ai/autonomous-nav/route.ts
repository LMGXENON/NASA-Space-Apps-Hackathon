import { NextResponse } from "next/server";

export interface CandidateArc {
  headingDeg: number;
  targetX: number;
  targetY: number;
  targetLat: number;
  targetLon: number;
  elevationM: number;
  slopeDeg: number;
  sunIlluminated: boolean;
  isHazardSlope: boolean;
  isCraterExclusion: boolean;
  canExitShadow?: boolean;
  shadowDistanceM?: number;
  projectedBatteryPct?: number;
}

export interface AutonomousNavRequest {
  currentPose: {
    x: number;
    y: number;
    latDeg: number;
    lonDeg: number;
    elevationM: number;
    slopeDeg: number;
    headingDeg: number;
  };
  celestial: {
    sunAzDeg: number;
    sunElDeg: number;
    isSunVisible: boolean;
  };
  power: {
    batteryWh: number;
    batteryPct: number;
    solarHarvestW: number;
    powerLoadW: number;
  };
  candidates: CandidateArc[];
  missionTimeIso: string;
}

export interface AutonomousNavResponse {
  decision: "NAVIGATE" | "DEEP_SLEEP_WAIT" | "HAZARD_STOP";
  recommendedHeadingDeg: number;
  stepDistanceM: number;
  targetWaypoint: {
    x: number;
    y: number;
    latDeg: number;
    lonDeg: number;
  };
  statusMessage: string;
  rationale: string;
  telemetrySummary: {
    slopeDeg: number;
    batteryPct: number;
    sunExposureExpectedPct: number;
    safetyMarginDeg: number;
  };
  source: "nvidia-nim" | "embedded-robotic-safety-kernel";
}

const NVIDIA_NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// We default to NVIDIA's fast multimodal / instruction NIM
const NIM_MODEL = process.env.NVIDIA_NAV_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b";

export async function POST(req: Request) {
  try {
    const payload: AutonomousNavRequest = await req.json();
    const { currentPose, celestial, power, candidates, missionTimeIso } = payload;

    // -------------------------------------------------------------
    // RULE 1: SUNLIGHT-ONLY & ZERO-BATTERY PREVENTION FAIL-SAFE
    // The rover moves in sunlight only. If the rover enters shadow,
    // or if no safe sunlit path exists ahead, enter Deep Sleep.
    // -------------------------------------------------------------
    const safeSunlitCandidates = candidates.filter(
      (c) => !c.isHazardSlope && !c.isCraterExclusion && c.sunIlluminated && c.slopeDeg < 20,
    );

    const safePassableCandidates = candidates.filter(
      (c) => !c.isHazardSlope && !c.isCraterExclusion && c.slopeDeg < 20,
    );

    // Critical battery reserve check (<= 15%): Actuators strictly lock
    if (power.batteryPct <= 15.0) {
      return NextResponse.json<AutonomousNavResponse>({
        decision: "DEEP_SLEEP_WAIT",
        recommendedHeadingDeg: currentPose.headingDeg,
        stepDistanceM: 0,
        targetWaypoint: {
          x: currentPose.x,
          y: currentPose.y,
          latDeg: currentPose.latDeg,
          lonDeg: currentPose.lonDeg,
        },
        statusMessage: "CRITICAL RESERVE (≤15%): Actuators locked — waiting for solar recharge.",
        rationale: `Actuators locked at ${power.batteryPct.toFixed(1)}% battery to preserve emergency life support and thermal survival heaters.`,
        telemetrySummary: {
          slopeDeg: currentPose.slopeDeg,
          batteryPct: power.batteryPct,
          sunExposureExpectedPct: celestial.isSunVisible ? 100 : 0,
          safetyMarginDeg: 20 - currentPose.slopeDeg,
        },
        source: "embedded-robotic-safety-kernel",
      });
    }

    // If no safe sunlit paths exist ahead:
    if (!celestial.isSunVisible || safeSunlitCandidates.length === 0) {
      // Check if any shadow can be safely crossed to sunlight:
      const safeShadowCrossable = safePassableCandidates.filter(
        (c) => c.canExitShadow && (c.projectedBatteryPct ?? 0) > 15.0,
      );

      if (safeShadowCrossable.length === 0 || celestial.isSunVisible) {
        return NextResponse.json<AutonomousNavResponse>({
          decision: "DEEP_SLEEP_WAIT",
          recommendedHeadingDeg: currentPose.headingDeg,
          stepDistanceM: 0,
          targetWaypoint: {
            x: currentPose.x,
            y: currentPose.y,
            latDeg: currentPose.latDeg,
            lonDeg: currentPose.lonDeg,
          },
          statusMessage: celestial.isSunVisible
            ? "SOLAR RECHARGE: Holding on sunlit crest — waiting for solar alignment."
            : "DEEP SLEEP: Preserving battery at shadow boundary — waiting for solar alignment.",
          rationale: celestial.isSunVisible
            ? `Rover safely parked on illuminated ridge crest (SOC ${power.batteryPct.toFixed(1)}%) to maintain full solar charge and avoid unilluminated crater terrain.`
            : `Actuators locked at shadow boundary (SOC ${power.batteryPct.toFixed(1)}%). Waiting for sun elevation/rotation to restore direct array illumination.`,
          telemetrySummary: {
            slopeDeg: currentPose.slopeDeg,
            batteryPct: power.batteryPct,
            sunExposureExpectedPct: celestial.isSunVisible ? 100 : 0,
            safetyMarginDeg: 20 - currentPose.slopeDeg,
          },
          source: "embedded-robotic-safety-kernel",
        });
      }
    }

    // Rollover safety stop: ONLY when all 360° arcs physically exceed 20° slope
    if (safePassableCandidates.length === 0) {
      return NextResponse.json<AutonomousNavResponse>({
        decision: "HAZARD_STOP",
        recommendedHeadingDeg: currentPose.headingDeg,
        stepDistanceM: 0,
        targetWaypoint: {
          x: currentPose.x,
          y: currentPose.y,
          latDeg: currentPose.latDeg,
          lonDeg: currentPose.lonDeg,
        },
        statusMessage: "HAZARD STOP: All candidate traverse arcs exceed strict 20.0° slope limit.",
        rationale: "Autonomous drive halted to prevent vehicle rollover on extreme terrain.",
        telemetrySummary: {
          slopeDeg: currentPose.slopeDeg,
          batteryPct: power.batteryPct,
          sunExposureExpectedPct: 0,
          safetyMarginDeg: 0,
        },
        source: "embedded-robotic-safety-kernel",
      });
    }

    // -------------------------------------------------------------
    // NVIDIA BUILD API / NIM CALL
    // -------------------------------------------------------------
    const apiKey = process.env.NVIDIA_API_KEY;

    if (apiKey) {
      try {
        const systemPrompt = `You are the Autonomous Guidance, Navigation & Control (GNC) AI for NASA Project Helios Artemis Lunar Rover.
You receive real-time telemetry vectors and 360-degree candidate traverse arcs evaluated against NASA LOLA altimetry.
Select the optimal next heading that satisfies these MANDATORY rules:
1. SLOPE LIMIT: STRICT < 20.0 DEGREES. Discard any candidate with slope >= 20.0°.
2. CRATER & OBSTACLE AVOIDANCE: Discard any crater exclusion zone or boulder hazard.
3. SUNLIGHT PRIORITY (SOLAR CHASE): Bias heading toward sunIlluminated=true arcs to maximize solar array generation.
4. ZERO-BATTERY PREVENTION: If battery < 15% and in shadow, halt and return DEEP_SLEEP_WAIT.

CRITICAL INSTRUCTION: Output ONLY a single JSON object. No reasoning, no markdown, no scratchpad:
{
  "decision": "NAVIGATE" | "DEEP_SLEEP_WAIT" | "HAZARD_STOP",
  "recommendedHeadingDeg": number,
  "rationale": "one concise sentence"
}`;

        const userPrompt = JSON.stringify({
          currentTelemetry: {
            latDeg: currentPose.latDeg,
            lonDeg: currentPose.lonDeg,
            elevationM: currentPose.elevationM,
            currentSlopeDeg: currentPose.slopeDeg,
            batteryPct: power.batteryPct,
            solarHarvestW: power.solarHarvestW,
            sunAzimuthDeg: celestial.sunAzDeg,
            sunElevationDeg: celestial.sunElDeg,
            isSunVisible: celestial.isSunVisible,
            missionTime: missionTimeIso,
          },
          candidateArcs: candidates.map((c) => ({
            headingDeg: c.headingDeg,
            slopeDeg: c.slopeDeg,
            sunIlluminated: c.sunIlluminated,
            isHazardSlope: c.isHazardSlope,
            isCraterExclusion: c.isCraterExclusion,
          })),
        });

        const nimResponse = await fetch(NVIDIA_NIM_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: NIM_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.1,
            max_tokens: 500,
          }),
          signal: AbortSignal.timeout(2000),
        });

        if (nimResponse.ok) {
          const resData = await nimResponse.json();
          const content = (resData?.choices?.[0]?.message?.content || "").trim();
          const startIdx = content.indexOf("{");
          const endIdx = content.lastIndexOf("}");
          if (startIdx !== -1 && endIdx > startIdx) {
            const parsed = JSON.parse(content.slice(startIdx, endIdx + 1));
            const chosenHeading = Number(parsed.recommendedHeadingDeg);

            // Find closest candidate arc matching the AI heading
            let bestCand = safePassableCandidates[0]!;
            let minDiff = 360;
            for (const cand of safePassableCandidates) {
              const diff = Math.abs(cand.headingDeg - chosenHeading);
              if (diff < minDiff) {
                minDiff = diff;
                bestCand = cand;
              }
            }

            // Hard safety check on model choice
            if (bestCand.slopeDeg < 20 && !bestCand.isCraterExclusion) {
              return NextResponse.json<AutonomousNavResponse>({
                decision: parsed.decision === "DEEP_SLEEP_WAIT" ? "DEEP_SLEEP_WAIT" : "NAVIGATE",
                recommendedHeadingDeg: bestCand.headingDeg,
                stepDistanceM: 35,
                targetWaypoint: {
                  x: bestCand.targetX,
                  y: bestCand.targetY,
                  latDeg: bestCand.targetLat,
                  lonDeg: bestCand.targetLon,
                },
                statusMessage: bestCand.sunIlluminated
                  ? "NVIDIA NIM: Autonomous Solar Chase Active (Crest Illumination)"
                  : "NVIDIA NIM: Safe Transit (Traversing Low Slope Corridor)",
                rationale: String(parsed.rationale || "Following AI optimized illumination corridor."),
                telemetrySummary: {
                  slopeDeg: bestCand.slopeDeg,
                  batteryPct: power.batteryPct,
                  sunExposureExpectedPct: bestCand.sunIlluminated ? 100 : 0,
                  safetyMarginDeg: 20 - bestCand.slopeDeg,
                },
                source: "nvidia-nim",
              });
            }
          }
        }
      } catch (err) {
        console.warn("NVIDIA NIM dynamic query error, falling back to embedded safety kernel:", err);
      }
    }

    // -------------------------------------------------------------
    // EMBEDDED REAL-TIME ROBOTIC SAFETY KERNEL (DETERMINISTIC FALLBACK)
    // -------------------------------------------------------------
    // Rank candidates by:
    // 1. Continuous sunlight priority (solar chase): +2000 pts if illuminated
    // 2. High ridge elevation bonus: + elevation * 0.25
    // 3. Low slope bonus: prefer lower slopes (< 10°)
    // 4. Sun heading alignment
    const scoredCandidates = safePassableCandidates.map((cand) => {
      let score = 0;
      if (cand.sunIlluminated) {
        score += 2000;
      } else if (cand.canExitShadow) {
        score += 500 - (cand.shadowDistanceM ?? 0) * 0.5;
      } else {
        score -= 10000;
      }
      // High crest elevation bonus
      score += cand.elevationM * 0.25;
      // Low slope bonus
      score += Math.max(0, (20 - cand.slopeDeg) * 20);
      // Angular alignment to sun
      const sunDiff = Math.abs((cand.headingDeg - celestial.sunAzDeg + 540) % 360 - 180);
      score += (180 - sunDiff) * 0.5;
      return { cand, score };
    });

    scoredCandidates.sort((a, b) => b.score - a.score);
    const chosen = scoredCandidates[0]!.cand;

    return NextResponse.json<AutonomousNavResponse>({
      decision: "NAVIGATE",
      recommendedHeadingDeg: chosen.headingDeg,
      stepDistanceM: 35,
      targetWaypoint: {
        x: chosen.targetX,
        y: chosen.targetY,
        latDeg: chosen.targetLat,
        lonDeg: chosen.targetLon,
      },
      statusMessage: chosen.sunIlluminated
        ? "SOLAR CHASE: Steering toward sunlit terrain ridge"
        : "LOW-SLOPE TRAVERSE: Navigating safe transit corridor",
      rationale:
        "Selected heading " +
        chosen.headingDeg.toFixed(0) +
        "° with " +
        chosen.slopeDeg.toFixed(1) +
        "° slope to maintain " +
        (chosen.sunIlluminated ? "continuous solar array energy harvest." : "vehicle rollover safety margin."),
      telemetrySummary: {
        slopeDeg: chosen.slopeDeg,
        batteryPct: power.batteryPct,
        sunExposureExpectedPct: chosen.sunIlluminated ? 100 : 0,
        safetyMarginDeg: 20 - chosen.slopeDeg,
      },
      source: "embedded-robotic-safety-kernel",
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Autonomous navigation processing failed: " + String(error) },
      { status: 500 },
    );
  }
}
