"use client";

/**
 * Timeline transport (PRD FR-E1..E3, E5): play/pause, speed, UTC scrubber with
 * keyboard stepping (←/→ = 10 sim-minutes), an editable UTC field (FR-E2,
 * out-of-range input clamps with a toast) and "Jump to next…" event buttons
 * (FR-E5, rover-site sunrise/sunset/Earth-rise/set/eclipse).
 */

import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { T0, T1, useTimeStore } from "../store/timeStore";
import { useUiStore } from "../store/uiStore";
import { roverApi } from "../lib/roverClient";
import { playQuindarTone, playTelemetryPing } from "../lib/audioService";

interface SpeedOption {
  label: string;
  value: number;
  multiplier: string;
}

const SPEEDS: SpeedOption[] = [
  { label: "1 min/s", value: 60, multiplier: "60×" },
  { label: "10 min/s", value: 600, multiplier: "600×" },
  { label: "1 h/s", value: 3600, multiplier: "3,600×" },
  { label: "6 h/s", value: 21600, multiplier: "21,600×" },
  { label: "1 d/s", value: 86400, multiplier: "86,400×" },
];

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

const JUMPS: { kind: "sunrise" | "sunset" | "earthrise" | "earthset" | "eclipse"; label: string }[] = [
  { kind: "sunrise", label: "Sunrise" },
  { kind: "sunset", label: "Sunset" },
  { kind: "earthrise", label: "Earth-rise" },
  { kind: "earthset", label: "Earth-set" },
  { kind: "eclipse", label: "Eclipse" },
];

/**
 * Isolated transport controls (Play/Pause + Upward Speed Popover).
 * Memoized to prevent 60fps re-rendering during time progression.
 */
const TransportCluster = memo(function TransportCluster() {
  const playing = useTimeStore((s) => s.playing);
  const speed = useTimeStore((s) => s.speed);
  const setPlaying = useTimeStore((s) => s.setPlaying);
  const setSpeed = useTimeStore((s) => s.setSpeed);
  const [open, setOpen] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);

  // Close popover on click outside or Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (clusterRef.current && !clusterRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Spacebar shortcut to toggle play/pause
  useEffect(() => {
    const handleSpace = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target instanceof HTMLElement) {
        const tag = e.target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) {
          return;
        }
        e.preventDefault();
        const next = !useTimeStore.getState().playing;
        if (next && !useUiStore.getState().roverSite) {
          useUiStore.getState().setRoverSite({ x: 10721, y: 10721 });
          useUiStore.getState().setToast("Rover deployed to Connecting Ridge · Autonomous navigation starting");
        }
        setPlaying(next);
        playQuindarTone(next ? "intro" : "outro");
      }
    };
    window.addEventListener("keydown", handleSpace);
    return () => window.removeEventListener("keydown", handleSpace);
  }, [setPlaying]);

  const activeOption = SPEEDS.find((s) => s.value === speed) ?? SPEEDS[0]!;

  return (
    <div ref={clusterRef} className="relative inline-flex items-center shrink-0">
      <div className="flex items-center h-8 rounded border border-[var(--line-strong)] bg-[#0c121e] overflow-visible shadow-sm">
        {/* Play/Pause Button */}
        <button
          type="button"
          onClick={() => {
            const next = !playing;
            if (next && !useUiStore.getState().roverSite) {
              useUiStore.getState().setRoverSite({ x: 10721, y: 10721 });
              useUiStore.getState().setToast("Rover deployed to Connecting Ridge · Autonomous navigation starting");
            }
            setPlaying(next);
            playQuindarTone(next ? "intro" : "outro");
          }}
          className={`h-full px-2 sm:px-2.5 flex items-center gap-1.5 transition-colors cursor-pointer select-none rounded-l ${
            playing
              ? "bg-[rgba(252,61,33,0.18)] text-[#fc3d21] hover:bg-[rgba(252,61,33,0.26)]"
              : "text-[var(--text-1)] hover:bg-[rgba(255,255,255,0.08)]"
          }`}
          aria-label={playing ? "Pause simulation" : "Play simulation"}
          title={playing ? "Pause simulation (Space)" : "Start simulation (Space)"}
        >
          {playing ? (
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden className="fill-current">
              <rect x="2" y="1.5" width="3" height="9" rx="1" />
              <rect x="7" y="1.5" width="3" height="9" rx="1" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden className="fill-current">
              <path d="M2.5 1.8 10.5 6l-8 4.2z" />
            </svg>
          )}
          <span className="mono text-[10.5px] font-semibold tracking-wider uppercase hidden xs:inline">
            {playing ? "Pause" : "Play"}
          </span>
        </button>

        {/* Divider */}
        <div className="h-4 w-px bg-[var(--line-strong)] shrink-0" />

        {/* Speed Dropdown Trigger */}
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className={`h-full px-2 sm:px-2.5 flex items-center gap-1 font-mono text-[11px] transition-colors cursor-pointer select-none rounded-r ${
            open
              ? "bg-[rgba(255,255,255,0.12)] text-white"
              : "text-[var(--text-2)] hover:text-white hover:bg-[rgba(255,255,255,0.06)]"
          }`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Playback speed: ${activeOption.label}`}
          title="Adjust simulation speed"
        >
          <span>{activeOption.label}</span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 12 12"
            aria-hidden
            className={`transition-transform duration-150 ${open ? "rotate-180 text-white" : "text-[var(--text-4)]"}`}
          >
            <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Upward Floating Popover Menu */}
      {open && (
        <div
          role="listbox"
          aria-label="Simulation speed options"
          className="absolute bottom-full left-0 mb-2 w-48 rounded border border-[var(--line-strong)] bg-[#0c1424] shadow-2xl py-1 z-50 backdrop-blur-md"
        >
          <div className="px-3 py-1 text-[9.5px] uppercase tracking-wider text-[var(--text-4)] font-mono border-b border-[var(--line)]">
            Simulation Speed
          </div>
          {SPEEDS.map((s) => {
            const isSelected = s.value === speed;
            return (
              <button
                key={s.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  setSpeed(s.value);
                  setOpen(false);
                  playTelemetryPing();
                }}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-[11.5px] font-mono text-left transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-[rgba(252,61,33,0.15)] text-[#fc3d21] font-semibold"
                    : "text-[var(--text-2)] hover:text-white hover:bg-[rgba(255,255,255,0.07)]"
                }`}
              >
                <span>{s.label}</span>
                <span className={`text-[10px] ${isSelected ? "text-[#fc3d21]" : "text-[var(--text-4)]"}`}>
                  {s.multiplier}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

/**
 * Responsive Quick Jumps control.
 * Displays inline buttons on 2xl screens, and a compact dropdown button on smaller screens.
 */
const JumpControls = memo(function JumpControls({
  jump,
  jumping,
}: {
  jump: (kind: (typeof JUMPS)[number]["kind"], label: string) => Promise<void>;
  jumping: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      {/* On wide screens (2xl: >= 1536px), show the full buttons */}
      <div className="hidden 2xl:flex items-center gap-1 shrink-0">
        {JUMPS.map((j) => (
          <button
            key={j.kind}
            type="button"
            className={`btn btn-ghost px-2 py-0.5 text-[10.5px] shrink-0 ${jumping === j.kind ? "opacity-55" : ""}`}
            disabled={jumping !== null}
            onClick={() => void jump(j.kind, j.label)}
            title={`Jump to the next ${j.label.toLowerCase()} at the rover site`}
          >
            {j.label}
          </button>
        ))}
      </div>

      {/* On standard screens (< 2xl), show a compact Jump dropdown */}
      <div ref={ref} className="relative 2xl:hidden shrink-0">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className={`h-8 px-2 rounded border border-[var(--line-strong)] bg-[#0c121e] flex items-center gap-1 text-[11px] font-mono transition-colors cursor-pointer ${
            open ? "bg-[rgba(255,255,255,0.12)] text-white" : "text-[var(--text-3)] hover:text-white hover:bg-[rgba(255,255,255,0.06)]"
          }`}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Jump to the next site-specific sky event"
        >
          <span className="text-[#ffd60a] text-[10px]">⚡</span>
          <span>Jump</span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 12 12"
            aria-hidden
            className={`transition-transform duration-150 ${open ? "rotate-180 text-white" : "text-[var(--text-4)]"}`}
          >
            <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {open && (
          <div
            role="listbox"
            className="absolute bottom-full right-0 mb-2 w-44 rounded border border-[var(--line-strong)] bg-[#0c1424] shadow-2xl py-1 z-50 backdrop-blur-md"
          >
            <div className="px-3 py-1 text-[9.5px] uppercase tracking-wider text-[var(--text-4)] font-mono border-b border-[var(--line)]">
              Next Site Event
            </div>
            {JUMPS.map((j) => (
              <button
                key={j.kind}
                type="button"
                disabled={jumping !== null}
                onClick={() => {
                  setOpen(false);
                  void jump(j.kind, j.label);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-mono text-left text-[var(--text-2)] hover:text-white hover:bg-[rgba(255,255,255,0.07)] transition-colors cursor-pointer"
              >
                <span>{j.label}</span>
                {jumping === j.kind && <span className="text-[10px] text-[var(--kapton)] animate-pulse">...</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
});

export default function Timeline() {
  const tMs = useTimeStore((s) => s.tMs);
  const playing = useTimeStore((s) => s.playing);
  const set = useTimeStore((s) => s.set);
  const raf = useRef(0);
  const last = useRef(0);
  const [text, setText] = useState(fmt(tMs));
  const editing = useRef(false);
  const [jumping, setJumping] = useState<string | null>(null);

  // FR-E2: the field follows the slider/playback unless the user is typing.
  useEffect(() => {
    if (!editing.current) setText(fmt(tMs));
  }, [tMs]);

  const commit = () => {
    editing.current = false;
    const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
    const v = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)) : NaN;
    if (!Number.isFinite(v)) {
      useUiStore.getState().setToast("Unrecognized time — use YYYY-MM-DD HH:MM (UTC)");
      setText(fmt(tMs));
      return;
    }
    const clamped = Math.min(T1, Math.max(T0, v));
    if (clamped !== v) {
      useUiStore.getState().setToast("Time clamped to the mission range (2026-01-01 → 2027-12-31 UTC)");
    }
    set(clamped);
    setText(fmt(clamped));
  };

  // FR-E5: jump the scrubber to the next site-specific sky event.
  const jump = async (kind: (typeof JUMPS)[number]["kind"], label: string) => {
    const s = useUiStore.getState();
    if (!s.roverSite) {
      s.setToast("Place the rover first — events depend on the site horizon");
      return;
    }
    setJumping(kind);
    try {
      const fromMs = useTimeStore.getState().tMs;
      const maxDays = Math.max(0, (T1 - fromMs) / 86_400_000);
      const r = (await roverApi.nextEvent({
        kind,
        fromMs,
        x: s.roverSite.x,
        y: s.roverSite.y,
        maxDays,
      })) as { t: number; kind: string } | null;
      if (!r) {
        s.setToast(`No ${label.toLowerCase()} within the mission range`);
      } else {
        set(r.t);
        s.setToast(`${label} at ${fmt(r.t)} UTC`);
        playTelemetryPing();
      }
    } catch (e) {
      s.setToast(`Event search failed: ${String(e)}`);
    } finally {
      setJumping(null);
    }
  };

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const loop = (now: number) => {
      const dt = (now - last.current) / 1000;
      last.current = now;
      useTimeStore.getState().tick(dt);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const stepSec = 600;
  const pct = ((tMs - T0) / (T1 - T0)) * 100;

  return (
    <div className="flex items-center gap-2 sm:gap-3 px-1 pt-0.5 w-full min-w-0">
      {/* Integrated Flight-ops Transport Controls */}
      <TransportCluster />

      {/* Flexible Scrubber Slider (shrinks/expands without pushing elements off-screen) */}
      <div className="w-0 flex-1 min-w-[50px] flex items-center">
        <input
          type="range"
          role="slider"
          aria-label="Mission time (UTC)"
          aria-valuetext={new Date(tMs).toISOString()}
          aria-valuemin={T0}
          aria-valuemax={T1}
          min={T0}
          max={T1}
          step={60000}
          value={tMs}
          onChange={(e) => set(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") set(tMs - stepSec * 1000);
            if (e.key === "ArrowRight") set(tMs + stepSec * 1000);
          }}
          className="w-full"
          style={{ "--pct": pct } as CSSProperties}
        />
      </div>

      {/* Compact Unified UTC Field (never wraps or overflows) */}
      <div className="flex items-center shrink-0 h-8 rounded border border-[var(--line-strong)] bg-[#0c121e] px-2 shadow-sm">
        <input
          className="mono bg-transparent text-[11.5px] tabular-nums text-white w-[114px] outline-none text-center font-mono select-all"
          value={text}
          aria-label="Mission time (UTC, YYYY-MM-DD HH:MM)"
          onFocus={() => (editing.current = true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="text-[10px] text-[var(--text-4)] font-mono ml-1 select-none">
          UTC
        </span>
      </div>

      {/* Horizon Quick Jump Targets */}
      <JumpControls jump={jump} jumping={jumping} />
    </div>
  );
}
