"use client";

/**
 * Tour Director — Interactive NASA Mission Flight Tour.
 * Guides operators step-by-step through the lunar South Pole environment,
 * real-time grazing illumination, Earth direct comm link, rover deployment,
 * Dijkstra slope routing, 14-day duty-cycle illumination, and mission telemetry.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, X, Compass, Check } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiStore } from "../store/uiStore";
import { useTimeStore } from "../store/timeStore";
import { latLonToGrid, skyAzEl, skyState } from "@helios/core";
import { runAutoPlan, triggerDutyMap } from "../lib/useMission";
import { corridorStats, type CorridorStats } from "../lib/planExport";
import { gridToScene, meshSurfaceHeight } from "../lib/sceneMath";
import { playQuindarTone, playTelemetryPing } from "../lib/audioService";

interface TourStep {
  title: string;
  desc: string;
  action?: (stepIdx: number) => Promise<void> | void;
}

// Prime landing site: Connecting Ridge (89.5°S, 45.0°E)
const CONNECTING_RIDGE_SITE = latLonToGrid(-89.5 * (Math.PI / 180), 45.0 * (Math.PI / 180));

// Consistent, comfortable orbital camera distance (16km–20km) so the whole crater and landscape remain clearly visible without jarring zooms
const ORBIT_SURVEY_DISTANCE = 19_500;
const ORBIT_TACTICAL_DISTANCE = 15_500;

const STEPS: TourStep[] = [
  {
    title: "Shackleton Crater & Lunar South Pole",
    desc: "Target exploration corridor at 89.9°S. At the lunar South Pole, the Sun never rises higher than 1.5° above the horizon, casting 16 km moving shadows across the crater rims.",
    action: () => {
      const ui = useUiStore.getState();
      ui.setCameraMode("orbit");
      ui.setHeatMode(0); // Photometric regolith
      ui.setDutyMode(false);
      useTimeStore.getState().setPlaying(false);
      useTimeStore.getState().set(Date.UTC(2026, 10, 20, 0, 0));
      // Stable 3/4 aerial view showing the full Shackleton crater rim and surrounding mountain peaks
      ui.requestFocus([0, 800, 0], ORBIT_SURVEY_DISTANCE, [0.6, 0.45, 0.65]);
    },
  },
  {
    title: "Real-Time Solar Grazing & Moving Shadows",
    desc: "Sunlight occlusion is resolved in a single 0.25 ms texture fetch using 64-azimuth LOLA horizon maps. Watch dynamic shadow fronts crawl across mountain massifs and crater floors.",
    action: () => {
      const ui = useUiStore.getState();
      ui.setCameraMode("orbit");
      ui.setHeatMode(0);
      ui.setDutyMode(false);
      useTimeStore.getState().set(Date.UTC(2026, 10, 21, 6, 0));
      useTimeStore.getState().setSpeed(3600); // 1 hour per real second
      useTimeStore.getState().setPlaying(true);
      // Smooth orbital perspective showing the entire terrain with sweeping shadows
      ui.requestFocus([1000, 600, 1000], ORBIT_SURVEY_DISTANCE, [0.65, 0.45, 0.6]);
    },
  },
  {
    title: "Direct-to-Earth Comm Link & Optical Libration",
    desc: "The blue telemetry vector tracks direct line of sight to Earth. Optical libration causes Earth to wobble ±7°, dipping below mountain massifs for 3 to 5 days every month.",
    action: () => {
      useTimeStore.getState().setPlaying(false);
      useTimeStore.getState().set(Date.UTC(2026, 10, 23, 12, 0));
      const ui = useUiStore.getState();
      ui.setCameraMode("orbit");
      useUiStore.setState({ showEarthRay: true, showSunRay: true });
      ui.setRoverSite(CONNECTING_RIDGE_SITE);

      // Elevated orbital perspective showing both the rover on the terrain and Earth in the sky
      ui.requestFocus([0, 800, 0], ORBIT_SURVEY_DISTANCE, [0.55, 0.42, 0.7]);
    },
  },
  {
    title: "Surface Rover Deployment & Telemetry Deck",
    desc: "The autonomous rover is placed on Connecting Ridge. The telemetry deck monitors battery state of charge, solar array wattage, and countdown clocks to sunset and Earthset.",
    action: () => {
      useTimeStore.getState().setPlaying(false);
      const ui = useUiStore.getState();
      ui.setCameraMode("orbit");
      ui.setHeatMode(0);
      ui.setRoverSite(CONNECTING_RIDGE_SITE);

      const [sx, , sz] = gridToScene(CONNECTING_RIDGE_SITE.x, CONNECTING_RIDGE_SITE.y);
      const t = ui.terrain;
      const h = t ? meshSurfaceHeight(t.hf, CONNECTING_RIDGE_SITE.x, CONNECTING_RIDGE_SITE.y) : 800;
      const targetY = t ? (h - t.meta.height.min) * ui.exaggeration + 200 : 800;

      // Comfortable tactical overview framing the rover in context on Connecting Ridge
      ui.requestFocus([sx, targetY, sz], ORBIT_TACTICAL_DISTANCE, [0.6, 0.45, 0.65]);
    },
  },
  {
    title: "Autonomous Least-Cost Route Navigation",
    desc: "A Dijkstra search evaluates cumulative sunlight and battery intake. Slopes between 15° and 20° trigger wheel slip warnings, while slopes exceeding 20° form impassable hard limits.",
    action: async () => {
      useTimeStore.getState().setPlaying(false);
      const ui = useUiStore.getState();
      ui.setCameraMode("orbit");
      ui.setRoverSite(CONNECTING_RIDGE_SITE);
      try {
        const candidates = await runAutoPlan();
        if (candidates.length > 0) {
          const corridors: Record<string, CorridorStats> = {};
          for (const cand of candidates) {
            const s = corridorStats(CONNECTING_RIDGE_SITE, cand);
            if (s) corridors[`${cand.x},${cand.y}`] = s;
          }
          ui.setPlan(candidates, corridors);
          const target = candidates[0]!;
          ui.setPath([{ x: target.x, y: target.y }]);
          const mid = gridToScene((CONNECTING_RIDGE_SITE.x + target.x) / 2, (CONNECTING_RIDGE_SITE.y + target.y) / 2);
          // Overview framing the entire route corridor along the ridge crest
          ui.requestFocus([mid[0], 700, mid[2]], ORBIT_TACTICAL_DISTANCE, [0.55, 0.5, 0.65]);
        }
      } catch (e) {
        console.warn("Auto plan route skipped", e);
      }
    },
  },
  {
    title: "Peaks of Eternal Light & Solar Illumination",
    desc: "Simulates 14 days of solar visibility across the entire 40 km AOI, pinpointing high-elevation mountain peaks that receive >90% continuous sunlight for permanent solar power towers.",
    action: () => {
      useTimeStore.getState().setPlaying(false);
      triggerDutyMap(96, 14);
      const ui = useUiStore.getState();
      ui.setCameraMode("orbit");
      ui.setDutyMode(true);
      // High-altitude wide-angle showing golden PEL peaks across the whole 40km map
      ui.requestFocus([0, 800, 0], ORBIT_SURVEY_DISTANCE, [0.5, 0.55, 0.65]);
    },
  },
  {
    title: "Mission Console & Real-Time Flight Ops",
    desc: "L-SPOC translates complex NASA ephemeris and 20m LOLA altimetry into an interactive decision tool for Artemis III and CLPS mission planners, keeping surface assets powered and connected.",
    action: () => {
      useTimeStore.getState().setPlaying(false);
      const ui = useUiStore.getState();
      ui.setDutyMode(false);
      ui.setHeatMode(0);
      ui.setCameraMode("orbit");
      ui.requestFocus([0, 800, 0], ORBIT_SURVEY_DISTANCE, [0.6, 0.45, 0.65]);
      playQuindarTone("intro");
    },
  },
];

export function TourRunner() {
  const active = useUiStore((s) => s.tourActive);
  const setActive = useUiStore((s) => s.setTourActive);
  const [currentStep, setCurrentStep] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const autoPlayTimer = useRef<NodeJS.Timeout | null>(null);

  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

  const closeTour = useCallback(() => {
    setActive(false);
    useTimeStore.getState().setPlaying(false);
    useUiStore.getState().setCameraMode("orbit");
    if (autoPlayTimer.current) clearInterval(autoPlayTimer.current);
    setAutoPlay(false);
  }, [setActive]);

  // Execute step action on step change
  useEffect(() => {
    if (!active) return;
    const step = STEPS[currentStep];
    if (step?.action) {
      void step.action(currentStep);
    }
  }, [active, currentStep]);

  // Handle auto-advance
  useEffect(() => {
    if (!active || !autoPlay) {
      if (autoPlayTimer.current) clearInterval(autoPlayTimer.current);
      return;
    }

    autoPlayTimer.current = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= STEPS.length - 1) {
          setAutoPlay(false);
          return prev;
        }
        return prev + 1;
      });
    }, 7000); // 7s per slide in autoplay

    return () => {
      if (autoPlayTimer.current) clearInterval(autoPlayTimer.current);
    };
  }, [active, autoPlay]);

  if (!active) return null;

  const step = STEPS[currentStep]!;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mission Guided Tour"
      className="fixed bottom-24 right-4 z-40 w-96 rounded-xl border border-[var(--line-strong)] bg-[var(--bg-1)]/95 p-4 shadow-2xl backdrop-blur-md"
    >
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-2.5">
        <div className="flex items-center gap-2">
          <Compass size={14} className="text-[var(--accent)]" />
          <span className="mono text-[11px] font-semibold uppercase tracking-wider text-white">
            Mission Tour · Step {currentStep + 1} of {STEPS.length}
          </span>
        </div>
        <button
          onClick={closeTour}
          className="text-[var(--text-3)] hover:text-white transition-colors"
          title="Exit Tour"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-3">
        <h4 className="text-[13px] font-semibold text-white tracking-tight">{step.title}</h4>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-2)]">{step.desc}</p>
      </div>

      {/* Progress dots */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => {
              setCurrentStep(i);
              playTelemetryPing();
            }}
            className={cn(
              "h-1.5 rounded-full transition-all",
              i === currentStep
                ? "w-6 bg-[var(--accent)]"
                : "w-1.5 bg-white/20 hover:bg-white/40",
            )}
            title={`Step ${i + 1}: ${STEPS[i]!.title}`}
          />
        ))}
      </div>

      {/* Controls */}
      <div className="mt-3.5 flex items-center justify-between border-t border-[var(--line)] pt-3">
        <button
          onClick={() => setAutoPlay(!autoPlay)}
          className={cn(
            "btn btn-ghost !h-7 px-2 text-[10.5px] border border-[var(--line)] flex items-center gap-1",
            autoPlay && "text-[var(--accent)] border-[var(--accent)]",
          )}
          title={autoPlay ? "Pause Auto-Tour" : "Start Auto-Play (7s per slide)"}
        >
          {autoPlay ? <Pause size={10} /> : <Play size={10} />}
          <span>{autoPlay ? "PAUSE" : "AUTO-PLAY"}</span>
        </button>

        <div className="flex items-center gap-1.5">
          <button
            disabled={isFirst}
            onClick={() => {
              setCurrentStep((p) => Math.max(0, p - 1));
              playTelemetryPing();
            }}
            className="btn btn-ghost !h-7 px-2 text-[10.5px] border border-[var(--line)] disabled:opacity-30"
          >
            <ChevronLeft size={12} />
            <span>Prev</span>
          </button>

          {isLast ? (
            <button
              onClick={closeTour}
              className="btn btn-primary !h-7 px-2.5 text-[10.5px] flex items-center gap-1"
            >
              <Check size={12} />
              <span>Finish</span>
            </button>
          ) : (
            <button
              onClick={() => {
                setCurrentStep((p) => Math.min(STEPS.length - 1, p + 1));
                playTelemetryPing();
              }}
              className="btn btn-primary !h-7 px-2.5 text-[10.5px] flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
