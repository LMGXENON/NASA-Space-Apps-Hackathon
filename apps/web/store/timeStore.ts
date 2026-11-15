"use client";

/**
 * Time state (PRD Part B §6). tMs is epoch ms clamped to [T0, T1].
 * High-frequency updates are consumed via imperative subscribe, not re-renders.
 */

import { create } from "zustand";

/** Timeline span: 2026-01-01T00:00Z → 2027-12-31T23:59Z (PRD FR-E1) */
export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
export const T1 = Date.UTC(2027, 11, 31, 23, 59, 0);

interface TimeState {
  tMs: number;
  playing: boolean;
  /** Sim seconds per real second */
  speed: number;
  set: (tMs: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  tick: (dtRealSec: number) => void;
}

export const useTimeStore = create<TimeState>((set) => ({
  tMs: Date.UTC(2026, 10, 20, 0, 0, 0), // demo default: 2026-11-20 (tour date)
  playing: false,
  speed: 60, // 1 min/s (60x real-time for smooth, readable traversal)
  set: (tMs) => set({ tMs: Math.min(T1, Math.max(T0, tMs)) }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  tick: (dtRealSec) =>
    set((s) => ({
      tMs: Math.min(T1, Math.max(T0, s.tMs + s.speed * 1000 * dtRealSec)),
    })),
}));

if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TIME_STORE__ = useTimeStore;
}
