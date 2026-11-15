"use client";

/**
 * TerrainPath — the terrain-conforming route (the "smart rope").
 *
 * The rope is a dense polyline whose Y at every sample is the height of the
 * *rendered* terrain surface, plus a small lift. Spans are graded from the true
 * (unexaggerated) DEM heights and coloured by severity, so mission control can see
 * at a glance where the rover would tip.
 *
 * Rendering notes:
 *  - `@react-three/drei`'s `<Line>` is a three-stdlib `Line2`, the only way to get
 *    a real screen-space `lineWidth` in WebGL; `linewidth` on a plain
 *    `LineBasicMaterial` is ignored by every core WebGL backend. drei forwards
 *    `vertexColors` to the geometry's per-instance colour attributes
 *    (`instanceColorStart` / `instanceColorEnd`), which `LineMaterial` applies as
 *    `diffuseColor.rgb *= vLineColor` — so these colours are what reaches the frame.
 *  - The geometry is emitted as **disconnected pairs** (`segments`) with the colour
 *    duplicated on both endpoints. A connected `Line2` interpolates vertex colours
 *    across each span, which would smear the Kapton/Red boundaries into gradients
 *    and hide the exact point where the grade turns lethal.
 *  - Sample density is bounded by `MAX_POINTS`. Draping the requested 0.5 m over a
 *    40 km AOI route would emit ~100 000 vertices, but the surface being traced is
 *    the 256×256 render mesh (156 m quads, flat within each triangle), so samples
 *    below ~2 m only subdivide a straight line. The cap coarsens the spacing on long
 *    routes instead of allocating unbounded geometry.
 *
 * Why not a `THREE.Raycaster`: the terrain's displacement runs in the vertex shader
 * (`TerrainMaterial.ts`), so the CPU-side geometry a ray would test is still the
 * flat plane and every hit would come back at y = 0. `meshSurfaceHeight` is the CPU
 * mirror of the same displaced mesh, and it is the surface this rope drapes onto.
 */

import { Line } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { MESH_SEG, meshSurfaceHeight, meshSurfaceNormal } from "../lib/sceneMath";
import { PATH_COLORS, generateDrapedRoute, sceneYFromHeight } from "../lib/drapedPath";
import { useUiStore } from "../store/uiStore";

/** Screen-space rope width [px]. */
const LINE_WIDTH = 3;
/**
 * Vertical lift above the draped surface [scene units].
 *
 * The camera's far plane is 6 000 km while the rope is viewed from 0.3–120 km, so
 * the depth buffer resolves well under a metre at the closest zoom. 0.1 is small
 * enough to read as "on the ground" at every zoom the camera allows and still wins
 * the depth test there; the rope has shown no striping from 6500 units in, or at the
 * 26 km AOI overview.
 */
const PATH_LIFT_M = 0.1;
/** Sampling targets: one sample per 0.5 m, capped at `MAX_POINTS` per route. */
const SEGMENT_M = 0.5;
const MAX_POINTS = 20_000;

/** Height of a waypoint pin (the rover model is ~470 units long). */
const PIN_H = 260;
const PIN_R = 34;

/** A glowing pin locked to the surface normal at a grid point. */
function SurfacePin({
  hf,
  x,
  y,
  hMin,
  exaggeration,
  color,
  kind,
}: {
  hf: Parameters<typeof meshSurfaceHeight>[0];
  x: number;
  y: number;
  hMin: number;
  exaggeration: number;
  color: string;
  kind: "site" | "waypoint";
}) {
  const { position, quaternion } = useMemo(() => {
    const h = meshSurfaceHeight(hf, x, y, MESH_SEG);
    const [nx, ny, nz] = meshSurfaceNormal(hf, x, y, MESH_SEG, exaggeration);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(nx, ny, nz),
    );
    // Scene X = grid X, scene Z = −grid Y, scene Y = shaped height — the same
    // mapping the terrain vertex shader applies to the plane.
    return {
      position: new THREE.Vector3(x, sceneYFromHeight(h, hMin, exaggeration, PATH_LIFT_M), -y),
      quaternion: q,
    };
  }, [hf, x, y, hMin, exaggeration]);

  const r = kind === "site" ? 1 : 0.72;
  return (
    <group position={position} quaternion={quaternion}>
      {/* contact ring — lies flat on the slope because the group is normal-aligned */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[PIN_H * 0.62 * r, PIN_H * 0.86 * r, 28]} />
        <meshBasicMaterial color={color} side={THREE.DoubleSide} transparent opacity={0.75} depthWrite={false} />
      </mesh>
      <mesh position={[0, (PIN_H / 2) * r, 0]}>
        <cylinderGeometry args={[PIN_R * 0.16 * r, PIN_R * 0.16 * r, PIN_H * r, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[0, PIN_H * r, 0]}>
        <sphereGeometry args={[PIN_R * 0.7 * r, 14, 14]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

export default function TerrainPath() {
  const terrain = useUiStore((s) => s.terrain);
  const site = useUiStore((s) => s.roverSite);
  const path = useUiStore((s) => s.path);
  const exaggeration = useUiStore((s) => s.exaggeration);

  // Drape the whole route (site → each waypoint) as one ribbon. Rebuilt only when
  // the terrain, the rover site, the waypoints or the vertical scale change — never
  // per frame.
  const route = useMemo(() => {
    if (!terrain || !site || path.length === 0) return null;
    return generateDrapedRoute(terrain.hf, site, path, {
      hMin: terrain.meta.height.min,
      exaggeration,
      liftM: PATH_LIFT_M,
      segmentM: SEGMENT_M,
      // Core splits this budget across the legs, so a long multi-waypoint route
      // cannot allocate unbounded geometry.
      maxPoints: MAX_POINTS,
    });
  }, [terrain, site, path, exaggeration]);

  const { points, colors } = useMemo(() => {
    if (!route || route.points.length < 2)
      return { points: [] as THREE.Vector3[], colors: [] as [number, number, number][] };
    const pts: THREE.Vector3[] = [];
    const cols: [number, number, number][] = [];
    for (let i = 0; i < route.points.length - 1; i++) {
      const a = route.points[i]!;
      const b = route.points[i + 1]!;
      // Disconnected pairs, colour repeated on both endpoints, so the severity
      // colour is constant across the whole span (see the header note).
      pts.push(new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2]));
      const c = PATH_COLORS[route.classes[i]!]!;
      cols.push(c, c);
    }
    return { points: pts, colors: cols };
  }, [route]);

  if (!terrain || !site) return null;

  return (
    <group>
      {points.length > 0 && (
        <Line points={points} vertexColors={colors} lineWidth={LINE_WIDTH} segments />
      )}
      <SurfacePin
        hf={terrain.hf}
        x={site.x}
        y={site.y}
        hMin={terrain.meta.height.min}
        exaggeration={exaggeration}
        color="#2ee6ff"
        kind="site"
      />
      {path.map((w, i) => (
        <SurfacePin
          key={`${w.x}:${w.y}:${i}`}
          hf={terrain.hf}
          x={w.x}
          y={w.y}
          hMin={terrain.meta.height.min}
          exaggeration={exaggeration}
          color="#d4af37"
          kind="waypoint"
        />
      ))}
    </group>
  );
}
