"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { BookOpen, LayoutTemplate, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "../lib/cn";
import MissionCtrl from "../components/MissionCtrl";
import Telemetry from "../components/Telemetry";
import Timeline from "../components/Timeline";
import Ribbon from "../components/Ribbon";
import InfoModal from "../components/InfoModal";
import { TourRunner } from "../components/Tour";
import { useMission, useSimWindowRefresh } from "../lib/useMission";
import { applyUrlState, scheduleUrlWrite } from "../lib/urlState";
import { useUiStore } from "../store/uiStore";
import { useTimeStore } from "../store/timeStore";
import { playQuindarTone } from "../lib/audioService";

const Viewport = dynamic(() => import("../components/Viewport"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs text-[var(--text-3)]">
      Initialising renderer…
    </div>
  ),
});

function Logo() {
  return (
    <span
      className="grid h-8 w-8 place-items-center rounded bg-[var(--nasa-blue)] border border-[var(--nasa-blue-light)]"
      aria-hidden
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7.2" fill="#ffffff" />
        <circle cx="14.4" cy="9.2" r="6.2" fill="#0b3d91" />
        <path d="M3.4 19.6h17.2" stroke="#fc3d21" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6.6 17.2h3.2M13 17.2h4.4" stroke="#d4af37" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
      </svg>
    </span>
  );
}

/** Mission clock strip: the always-on "we are live" cue of a control room. */
function MissionStatus() {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 19) + "Z");
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="hidden items-center gap-3 lg:flex">
      <span className="hud-label text-[var(--text-3)]">
        Artemis surface ops
      </span>
      <span className="flex items-center gap-1.5">
        <span className="dot bg-[var(--ok)]" style={{ animation: "hud-blink 2s steps(1) infinite" }} />
        <span className="hud-label">LINK NOMINAL</span>
      </span>
      <span className="mono text-[11.5px] text-[var(--kapton)]">
        {clock}
      </span>
    </div>
  );
}

/** Transient feedback (PRD FR-E2: clamped-input toast). */
function Toast() {
  const toast = useUiStore((s) => s.toast);
  const setToast = useUiStore((s) => s.setToast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(id);
  }, [toast, setToast]);
  if (!toast) return null;
  return (
    <div
      role="status"
      className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg px-3.5 py-2 text-[12px] shadow-lg bg-[var(--bg-3)] border border-[var(--line-strong)] text-white"
    >
      {toast}
    </div>
  );
}

export default function Home() {
  const audioEnabled = useUiStore((s) => s.audioEnabled);
  const setAudioEnabled = useUiStore((s) => s.setAudioEnabled);
  const [cinemaMode, setCinemaMode] = useState(false);

  useMission();
  useSimWindowRefresh();
  useEffect(() => {
    applyUrlState();
    // FR-D3: keep the address bar shareable as mission state evolves.
    const unsubs = [
      useTimeStore.subscribe(() => scheduleUrlWrite()),
      useUiStore.subscribe(() => scheduleUrlWrite()),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <header
        className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 py-2"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-2">
              <span className="text-[14.5px] font-semibold tracking-tight text-white">L-SPOC</span>
            </div>
            <div className="hidden truncate text-[11px] sm:block text-[var(--text-3)]">
              Lunar South Pole Operations Console · 1:1 NASA LOLA Altimetry
            </div>
          </div>
        </div>

        {/* Center: Mission Clock & Live Telemetry Status */}
        <div className="flex items-center gap-3">
          <MissionStatus />
        </div>

        {/* Right: Pitch Deck, Audio Comms, Tour, Method & Data */}
        <div className="flex items-center gap-2">
          <button
            className={cn(
              "btn btn-ghost px-2.5 text-[11px] transition-colors",
              cinemaMode && "border-[var(--accent)] text-[var(--accent-strong)] bg-[var(--accent-soft)]",
            )}
            onClick={() => setCinemaMode(!cinemaMode)}
            title={cinemaMode ? "Show Mission Control Panels" : "Expand 3D Lunar Surface View to Full Screen"}
          >
            <LayoutTemplate size={13} />
            <span className="hidden md:inline">{cinemaMode ? "EXIT CINEMA" : "CINEMA VIEW"}</span>
          </button>

          <button
            className={cn("btn btn-ghost px-2.5 text-[11px]", audioEnabled && "text-[var(--kapton)] border-[var(--kapton)]")}
            onClick={() => {
              const next = !audioEnabled;
              setAudioEnabled(next);
              if (next) playQuindarTone("intro");
            }}
            title={audioEnabled ? "Mute Mission Audio (Quindar Tones & Telemetry)" : "Enable NASA Mission Audio (Apollo / Artemis Quindar Tones)"}
          >
            {audioEnabled ? <Volume2 size={13} className="text-[var(--kapton)]" /> : <VolumeX size={13} />}
            <span className="hidden md:inline">{audioEnabled ? "AUDIO ON" : "AUDIO"}</span>
          </button>

          <button className="btn btn-ghost text-[11px]" onClick={() => useUiStore.getState().setTourActive(true)}>
            <Play size={12} aria-hidden />
            Guided tour
          </button>
          <button className="btn text-[11px]" onClick={() => useUiStore.getState().setInfoOpen(true)}>
            <BookOpen size={12} aria-hidden />
            Method &amp; data
          </button>
        </div>
      </header>

      {/* Workspace: Spacious, uncluttered 3-column control console or immersive cinema view */}
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 transition-all duration-300",
          cinemaMode
            ? "grid-cols-1 overflow-hidden"
            : "lg:grid-cols-2 lg:content-start xl:h-full xl:grid-cols-[330px_minmax(0,1fr)_360px] xl:content-stretch xl:overflow-hidden",
        )}
      >
        <main
          className={cn(
            "order-1 min-h-[340px] rounded-xl overflow-hidden border border-[var(--line)] shadow-2xl transition-all duration-300",
            cinemaMode
              ? "col-span-full h-full"
              : "h-[56vh] lg:col-span-2 lg:h-[58vh] xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:h-auto xl:min-h-0",
          )}
        >
          <Viewport />
        </main>

        {!cinemaMode && (
          <>
            <div className="order-2 flex min-w-0 flex-col xl:col-start-1 xl:row-start-1 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
              <MissionCtrl />
            </div>

            <div className="order-3 flex min-w-0 flex-col xl:col-start-3 xl:row-start-1 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
              <Telemetry />
            </div>
          </>
        )}
      </div>

      <footer className="shrink-0 border-t border-[var(--line)] bg-[var(--bg-1)] px-3 pb-2 pt-2.5">
        <Ribbon />
        <Timeline />
      </footer>

      <InfoModal />
      <TourRunner />
      <Toast />
    </div>
  );
}
