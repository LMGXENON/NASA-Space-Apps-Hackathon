"use client";

/**
 * Method & data panel (PRD FR-D2): methodology, ephemeris, data credits,
 * validation summary, accuracy caveats and the required disclaimer.
 */

import { useEffect } from "react";
import { BookOpen, X } from "lucide-react";
import { useUiStore } from "../store/uiStore";
import type { TerrainMeta } from "../lib/data";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[12px] font-semibold text-[var(--accent-strong)]">
        {title}
      </h4>
      <div className="mt-1.5 space-y-2 text-[12.5px] leading-relaxed text-[var(--text-2)]">
        {children}
      </div>
    </section>
  );
}

/** One right-aligned provenance fact (label · value) inside the DEM section. */
function DemRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-[var(--text-4)]">
        {label}
      </span>
      <span className="mono text-right text-[11px] text-[var(--text-2)]">
        {children}
      </span>
    </div>
  );
}

/**
 * Terrain provenance straight from meta.json's `dem` block — product identity,
 * grid geometry, and the offline registration check that proves the grid sits
 * where it claims (rim fit vs USGS nomenclature).
 */
function DemSection({ meta }: { meta: TerrainMeta | undefined }) {
  const dem = meta?.dem;
  const versionLine = (
    <p className="mono text-[11px] text-[var(--text-4)]">
      version {meta?.dataVersion ?? "—"} · crs {meta?.crs ?? "—"}
    </p>
  );
  if (!dem || dem.mode !== "lola") {
    return (
      <Section title="Terrain data">
        <p>{meta?.credits ?? dem?.note ?? "See meta.json"}</p>
        {versionLine}
      </Section>
    );
  }
  const reg = dem.registration;
  const nom = dem.nomenclature;
  return (
    <Section title="Terrain data (DEM)">
      <p>
        Real measured terrain, not a procedural surface:{" "}
        <span className="mono text-[var(--text)]">{dem.product}</span> — the {dem.instrument} shape map ({dem.datasetId})
        from {dem.producer}. The 40 × 40 km AOI around the pole is cut from the {dem.mapScaleM} m
        polar-stereographic grid with a single HTTP range read and area-weighted to {dem.texelM} m per
        texel.
      </p>
      <div className="space-y-1 rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-2.5 py-2">
        <DemRow label="acquired">
          {dem.acquired} · retrieved {dem.retrieved}
        </DemRow>
        <DemRow label="projection">{dem.projection}</DemRow>
        <DemRow label="resample">{dem.resample}</DemRow>
        {reg && (
          <DemRow label="registration">
            Δ {reg.fitDeltaFromNomenclatureM.toFixed(1)} m from USGS ({reg.ok ? "verified" : "unverified"})
          </DemRow>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-3)]">
        {nom ? (
          <>
            Shackleton centre {nom.centerLatDeg}°S {nom.centerLonDeg}°E, dia {nom.diameterKm} km ({nom.name},{" "}
            {nom.source}).
          </>
        ) : null}
        {dem.sourceUrl && (
          <>
            {" "}
            <a href={dem.sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-white">
              PDS label
            </a>
          </>
        )}
        {nom?.sourceUrl && (
          <>
            {" "}·{" "}
            <a href={nom.sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-white">
              nomenclature
            </a>
          </>
        )}
      </p>
      {versionLine}
    </Section>
  );
}

export default function InfoModal() {
  const open = useUiStore((s) => s.infoOpen);
  const setOpen = useUiStore((s) => s.setInfoOpen);
  const terrain = useUiStore((s) => s.terrain);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Method and data"
    >
      <div
        className="modal-window max-w-[760px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-title">
            <BookOpen size={16} className="text-[var(--accent)]" />
            <span>Method &amp; Data Provenance</span>
            <span className="badge badge-accent">NASA LOLA Altimetry</span>
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body grid gap-5 sm:grid-cols-2">
          <Section title="Visibility model">
            <p>
              For every terrain cell, a precomputed horizon map stores the maximum curvature-corrected elevation
              angle of the horizon in 64 azimuth bins, baked offline from the DEM. Sun and Earth visibility are then
              analytic disc fractions above that horizon — a single O(1) lookup that runs identically per pixel in the
              GPU shader and per point in the worker&apos;s exact marcher, so the picture and the numbers agree by
              construction.
            </p>
            <p>
              Lunar curvature (≈115 m of drop at 20 km) is included, the Sun is treated as a 0.53° disc and the Earth
              as a ≈1.9° disc.
            </p>
          </Section>

          <Section title="Power &amp; link">
            <p>
              Solar power scales with the visible disc fraction, the array incidence angle and array mode; the load
              model covers drive, heater and comms duty. Lunar eclipses (Earth covering the Sun) reduce the fraction
              by the circle-overlap area.
            </p>
            <p>
              The direct-to-Earth margin uses free-space path loss at the selected band, transmit power and antenna
              gains, gated by Earth line of sight.
            </p>
          </Section>

          <Section title="Ephemeris">
            <p>
              Sun and Earth vectors are computed live in the browser with{" "}
              <span className="mono text-[var(--text)]">astronomy-engine</span> (EQJ → Moon-fixed via the IAU lunar rotation), validated
              at the poles against the PRD domain bounds: Sun elevation ±1.54° + 0.27°, Earth ±6.7°. For mission-window
              epochs the app instead serves state vectors pre-baked from JPL HORIZONS (DE441, 6 h knots over
              2026–2028) — the <span className="mono text-[var(--text)]">Model validation</span> panel sweeps the analytic model against
              those vectors and reports the worst deviation (≤ 0.05° bound).
            </p>
          </Section>

          <DemSection meta={terrain?.meta} />

          <Section title="Validation">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                A live <span className="mono text-[var(--text)]">Model validation</span> panel (telemetry column) computes the
                polar Sun/Earth elevation extremes and the Shackleton rim/floor illumination share with this app&apos;s
                own ephemeris and horizon model, then compares them against published LOLA / Diviner values with
                citations and tolerance windows.
              </li>
              <li>FSPL spot values 211.0 / 222.6 / 232.4 dB, battery drain to analytic time, disc-fraction limits (0, ½, 1), polar Sun/Earth elevation bounds — all unit-tested.</li>
              <li>Horizon map baked at 512² cells × 64 azimuths with 0.25° quantization.</li>
              <li>Polar-stereographic forward/inverse round-trips to &lt; 1e-6°.</li>
            </ul>
          </Section>

          <Section title="Caveats">
            <ul className="ml-4 list-disc space-y-1">
              {terrain?.meta.dem?.mode === "lola" ? (
                <li>
                  Terrain is real LOLA shape data area-weighted from 20 m native to the 39.1 m AOI texel — relief
                  finer than ~40 m is smoothed by that resample, so wall micro-topography is optimistic.
                </li>
              ) : (
                <li>Demo terrain is a synthetic Shackleton-like surface — physically plausible, not real LOLA data. Drop in real products via <span className="mono text-[var(--text)]">tools/prep_dem.py --lola</span>.</li>
              )}
              <li>The 3D view applies a fixed survey fill light so relief stays legible under a Sun that never rises above ~2°.</li>
              <li className="font-medium text-[var(--warn)]">
                Educational planning visualization. Not for operational use.
              </li>
            </ul>
          </Section>
        </div>

        {/* Modal Footer */}
        <div className="modal-footer">
          <span className="text-[11px] text-[var(--text-4)]">
            Shape data: NASA / GSFC LOLA (LDEM_875S_20M). Context: LROC, NASA / GSFC / ASU.
          </span>
          <button className="btn btn-primary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
