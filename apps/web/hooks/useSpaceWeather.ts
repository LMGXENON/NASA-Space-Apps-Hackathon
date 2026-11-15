"use client";

/**
 * useSpaceWeather — NASA DONKI solar-activity context for the S-band DTE link
 * panel. Follows the mission clock like `useNasaEphemeris`:
 *
 * - Window = ±7 days around the mission epoch ("at mission epoch"). Real
 *   events show up when scrubbing through recorded history.
 * - When the whole window lies in the future — no observations can exist for
 *   it — the hook falls back to the latest 30 days of real observations
 *   ("latest observed"), so the panel always shows genuine data.
 *
 * Requests are debounced + rate-gated and cached across consumers, so slider
 * scrubbing never floods the api.nasa.gov rate limit. Never throws: the
 * service reports unavailability explicitly (`source: "unavailable"`).
 */

import { useEffect, useMemo, useState } from "react";
import {
  clampSpaceWeatherWindow,
  nasaDataService,
  type SpaceWeatherReport,
  type SpaceWeatherWindow,
} from "../lib/nasaDataService";
import { useTimeStore } from "../store/timeStore";

const HALF_WINDOW_MS = 7 * 86_400_000;
const LATEST_WINDOW_MS = 30 * 86_400_000;
/** Minimum spacing between real DONKI requests (rate-limit guard). */
const MIN_NET_INTERVAL_MS = 5000;

/** Window → report, shared by every hook instance. */
const cache = new Map<string, SpaceWeatherReport>();
let lastNetMs = 0;

/** Pick the query window/mode for a mission epoch (hour-quantised input). */
function windowFor(epochMs: number): SpaceWeatherWindow {
  const now = Date.now();
  if (epochMs - HALF_WINDOW_MS > now) {
    return clampSpaceWeatherWindow(now - LATEST_WINDOW_MS, now, "latest");
  }
  return clampSpaceWeatherWindow(epochMs - HALF_WINDOW_MS, epochMs + HALF_WINDOW_MS, "epoch");
}

function windowKey(win: SpaceWeatherWindow): string {
  return `${win.mode}:${Math.round(win.startMs / 3_600_000)}:${Math.round(win.endMs / 3_600_000)}`;
}

export interface SpaceWeatherView {
  /** Latest report for the current window, or null before the first answer. */
  report: SpaceWeatherReport | null;
  isLoading: boolean;
}

/** The NASA space-weather hook. Debounced, latest-wins, offline-safe. */
export function useSpaceWeather(debounceMs = 800): SpaceWeatherView {
  const tMs = useTimeStore((s) => s.tMs);
  const epochHour = Math.round(tMs / 3_600_000);
  const win = useMemo(() => windowFor(epochHour * 3_600_000), [epochHour]);
  const key = windowKey(win);

  const [report, setReport] = useState<SpaceWeatherReport | null>(() => cache.get(key) ?? null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setReport(hit);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    const gap = Math.max(0, lastNetMs + MIN_NET_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      lastNetMs = Date.now();
      setIsLoading(true);
      nasaDataService
        .fetchSpaceWeather(win.startMs, win.endMs, win.mode)
        .then((r) => {
          cache.set(key, r);
          if (cache.size > 32) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          if (!cancelled) {
            setReport(r);
            setIsLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setIsLoading(false);
        });
    }, debounceMs + gap);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, win.startMs, win.endMs, win.mode, debounceMs]);

  return { report, isLoading };
}
