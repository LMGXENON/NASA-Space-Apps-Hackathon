"use client";

/**
 * NASA Mission Control Audio Synthesizer (Web Audio API).
 *
 * Implements mathematically generated audio cues used in NASA mission control:
 * 1. Apollo / Artemis Quindar Tones:
 *    - Intro beep: 2525 Hz (Push-to-Talk Validated Indicator), 200 ms duration
 *    - Outro beep: 2475 Hz (Release-to-Listen Indicator), 200 ms duration
 * 2. Telemetry Packet Ping:
 *    - Dual-tone data burst (1760 Hz + 2200 Hz), 75 ms duration
 * 3. Alert / Hazard warning chime:
 *    - Low-frequency alert tone for battery SOC < 30% or comm link loss
 *
 * Zero external audio files; pure mathematical synthesis with gain ramping to
 * avoid clicks or pops. Checks `uiStore.audioEnabled` before emitting.
 */

import { useUiStore } from "../store/uiStore";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playQuindarTone(type: "intro" | "outro" = "intro") {
  if (!useUiStore.getState().audioEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  // Intro: 2525 Hz, Outro: 2475 Hz
  osc.type = "sine";
  osc.frequency.setValueAtTime(type === "intro" ? 2525 : 2475, now);

  // Soft envelope: 15ms attack, 185ms decay
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.22);
}

export function playTelemetryPing() {
  if (!useUiStore.getState().audioEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain = ctx.createGain();

  osc1.type = "sine";
  osc1.frequency.setValueAtTime(1760, now);
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(2200, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.035, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(ctx.destination);

  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + 0.08);
  osc2.stop(now + 0.08);
}

export function playAlertTone() {
  if (!useUiStore.getState().audioEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "triangle";
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.setValueAtTime(660, now + 0.12);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.26);
}
