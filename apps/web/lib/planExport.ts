"use client";

/**
 * Route-plan analysis + export (PRD demo finale).
 *
 * Two jobs, both driven by the same draped-route maths the viewport renders:
 *
 *  - `corridorStats` grades the straight corridor from the rover site to a
 *    candidate target so the planner UI and the guided tour can reject targets
 *    whose corridor crosses lethal (> 25°) slopes — the "route around lethal
 *    slopes" step.
 *  - `exportPlan` downloads the current plan (site, waypoints, per-leg grades,
 *    survival class, DEM provenance) as a CSV any judge can open in Excel,
 *    Numbers or QGIS.
 */

import { SLOPE_LETHAL_DEG, SLOPE_SAFE_DEG, drapeRoute, gridToLatLon, RAD2DEG } from "@helios/core";
import type { SlopeClass } from "@helios/core";
import { useUiStore } from "../store/uiStore";
import { useTimeStore } from "../store/timeStore";
import { sampleHeight } from "./sceneMath";

export interface CorridorStats {
  /** Longest per-sample grade along the corridor [deg]. */
  maxGradeDeg: number;
  /** Corridor length [m]. */
  lengthM: number;
  /** Length of spans graded lethal (worst class), 0 when the corridor is clear. */
  worstClass: SlopeClass;
  /** Class-name lookup for display. */
  classLabel: string;
}

const CLASS_LABELS = [
  `traversable (≤ ${SLOPE_SAFE_DEG}°)`,
  `marginal (${SLOPE_SAFE_DEG}–${SLOPE_LETHAL_DEG}°)`,
  `lethal (> ${SLOPE_LETHAL_DEG}°)`,
] as const;

/** Grade the straight corridor site → target on the real heightfield. */
export function corridorStats(
  site: { x: number; y: number },
  target: { x: number; y: number },
): CorridorStats | null {
  const terrain = useUiStore.getState().terrain;
  if (!terrain) return null;
  const hf = terrain.hf;
  const route = drapeRoute(site, [target], (x, y) => sampleHeight(hf, x, y), {
    segmentM: 10,
  });
  let maxGradeDeg = 0;
  let worst: SlopeClass = 0;
  for (let i = 0; i < route.samples.length - 1; i++) {
    const g = route.slopesDeg[i] ?? 0;
    if (g > maxGradeDeg) maxGradeDeg = g;
    const c = route.classes[i] ?? 0;
    if (c > worst) worst = c;
  }
  const lengthM = Math.hypot(target.x - site.x, target.y - site.y);
  return { maxGradeDeg, lengthM, worstClass: worst, classLabel: CLASS_LABELS[worst]! };
}

const CLASS_NAMES = [
  "Dead — no sun, no comm",
  "Solar only",
  "Survivable — sun + comm",
  "Comm only — no power",
];

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build the plan CSV: header comments carry provenance (mission time, survival
 * class, DEM product), then one row per node (site + waypoints) with grid and
 * selenographic coordinates, elevation, leg length and the leg's worst grade.
 */
export function buildPlanCsv(): string | null {
  const { terrain, roverSite, path, sim, profile } = useUiStore.getState();
  if (!terrain || !roverSite) return null;
  const hf = terrain.hf;
  const nodes = [{ ...roverSite }, ...path];
  const now = useTimeStore.getState().tMs;

  const idx = sim
    ? Math.min(
        sim.n - 1,
        Math.max(0, Math.round((now - sim.t0) / (sim.dtSec * 1000))),
      )
    : -1;
  const cls = idx >= 0 ? sim!.cls[idx]! : null;

  const dem = terrain.meta.dem;
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    total += Math.hypot(nodes[i]!.x - nodes[i - 1]!.x, nodes[i]!.y - nodes[i - 1]!.y);
  }
  const lines: string[] = [
    "# Helios route plan — lunar south pole rover operations planner",
    `# generated,${new Date().toISOString()}`,
    `# mission_time_utc,${new Date(now).toISOString()}`,
    `# survival_class,${cls ?? "n/a"},${cls != null ? CLASS_NAMES[cls] : ""}`,
    `# data_version,${terrain.meta.dataVersion}`,
    `# dem,${dem?.mode ?? "unknown"}${dem?.product ? `,${dem.product}` : ""}${
      dem?.registration?.ok ? ",registration-verified" : ""
    }`,
    `# route_length_m,${total.toFixed(1)}`,
    `# rover_profile,${profile.batteryWh} Wh battery,${profile.arrayAreaM2} m2 array,${profile.speedMps} m/s`,
    "role,node,x_m,y_m,latitude_deg,longitude_deg,elevation_m,leg_m,leg_max_grade_deg,leg_class",
  ];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const { latRad, lonRad } = gridToLatLon(n.x, n.y);
    const h = sampleHeight(hf, n.x, n.y);
    let legM = 0;
    let legMax = 0;
    let legClass: SlopeClass = 0;
    if (i > 0) {
      const prev = nodes[i - 1]!;
      const route = drapeRoute(prev, [n], (x, y) => sampleHeight(hf, x, y), {
        segmentM: 5,
      });
      for (let k = 0; k < route.samples.length - 1; k++) {
        legMax = Math.max(legMax, route.slopesDeg[k] ?? 0);
        legClass = Math.max(legClass, route.classes[k] ?? 0) as SlopeClass;
      }
      legM = Math.hypot(n.x - prev.x, n.y - prev.y);
    }
    lines.push(
      [
        i === 0 ? "site" : "waypoint",
        i,
        n.x.toFixed(1),
        n.y.toFixed(1),
        (latRad * RAD2DEG).toFixed(5),
        Number((((lonRad * RAD2DEG + 540) % 360) - 180).toFixed(5)),
        h.toFixed(1),
        legM.toFixed(1),
        legMax.toFixed(1),
        i === 0 ? "-" : CLASS_LABELS[legClass],
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return lines.join("\n");
}

/** Build and download the plan CSV. Returns the file name, or null. */
export function exportPlan(): string | null {
  const csv = buildPlanCsv();
  if (csv == null) return null;
  const day = new Date(useTimeStore.getState().tMs).toISOString().slice(0, 10);
  const name = `helios-route-plan-${day}.csv`;
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}
