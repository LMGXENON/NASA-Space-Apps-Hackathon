"use client";

/**
 * RoverModel — Aerospace-grade articulated lunar exploration rover (PRD §5.3).
 *
 * Implements authentic NASA JPL rocker-bogie kinematic geometry and NASA flight-article detail:
 * 1. 6 driven titanium-chevron cleated wheels with airless mesh grousers & planetary hub motors.
 * 2. Inboard rocker-bogie linkage with transverse differential pivot and lateral drive axles.
 * 3. Gold Kapton multi-layer insulation (MLI) thermal blanket with procedural crinkles.
 * 4. High-efficiency triple-junction GaAs solar array with silver busbar micro-grids.
 * 5. Articulated MastCam stereo camera head with optical navigation sensors & spectrometer.
 * 6. High-gain steerable parabolic antenna (Earth S-band comms) with Cassegrain sub-reflector.
 * 7. Starboard TRIDENT cryogenic volatiles drill arm & aft radiatively-cooled avionics bay.
 * 8. Dual HazCams, forward LED floodlights, and NASA Artemis mission insignia.
 */

import { Component, Suspense, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { roverGridPos } from "../lib/roverPos";
import { useUiStore } from "../store/uiStore";

const ROVER_GLB = process.env.NEXT_PUBLIC_ROVER_GLB;
/** Longest horizontal dimension the model is normalised to (scene metres). */
const TARGET_LEN = 470;

// ------------------------------------------------------------------ materials
const MAT = {
  hull: { color: "#c8d0da", roughness: 0.52, metalness: 0.38 },
  darkChassis: { color: "#1c222b", roughness: 0.65, metalness: 0.40 },
  foil: { color: "#dfa735", roughness: 0.28, metalness: 0.92 },
  panelFrame: { color: "#0e1622", roughness: 0.45, metalness: 0.65 },
  metal: { color: "#9ca6b4", roughness: 0.38, metalness: 0.72 },
  titanium: { color: "#7b8594", roughness: 0.32, metalness: 0.85 },
  goldArm: { color: "#e5b342", roughness: 0.35, metalness: 0.88 },
  lens: { color: "#001a33", roughness: 0.10, metalness: 0.90 },
  accent: { color: "#2ee6ff", roughness: 0.30, metalness: 0.2, emissive: "#0b6a80", emissiveIntensity: 0.7 },
  ledHeadlight: { color: "#ffffff", roughness: 0.2, metalness: 0.1, emissive: "#fff8e0", emissiveIntensity: 1.4 },
} as const;

const MESH = (m: keyof typeof MAT) => <meshStandardMaterial {...MAT[m]} />;

// -------------------------------------------------------- procedural textures
function createCrinkleFoilTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, s, s);

  // Multi-frequency crinkled Mylar/Kapton facet creases
  for (let i = 0; i < 110; i++) {
    const x1 = Math.random() * s;
    const y1 = Math.random() * s;
    const len = 12 + Math.random() * 50;
    const ang = Math.random() * Math.PI * 2;
    const x2 = x1 + Math.cos(ang) * len;
    const y2 = y1 + Math.sin(ang) * len;

    const shade = Math.random() > 0.5 ? "rgba(255, 255, 255, 0.45)" : "rgba(0, 0, 0, 0.40)";
    ctx.strokeStyle = shade;
    ctx.lineWidth = 1 + Math.random() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.needsUpdate = true;
  return tex;
}

function createSolarArrayTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const w = 512, h = 512;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;

  // Space-grade GaAs dark indigo/purple antireflective background
  ctx.fillStyle = "#081020";
  ctx.fillRect(0, 0, w, h);

  const cols = 6;
  const rows = 4;
  const cellW = (w - 20) / cols;
  const cellH = (h - 20) / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = 10 + c * cellW;
      const cy = 10 + r * cellH;

      // Cell body gradient
      const g = ctx.createLinearGradient(cx, cy, cx + cellW, cy + cellH);
      g.addColorStop(0, "#0f1c34");
      g.addColorStop(0.5, "#152646");
      g.addColorStop(1, "#0a1428");
      ctx.fillStyle = g;
      ctx.fillRect(cx + 2, cy + 2, cellW - 4, cellH - 4);

      // Fine micro-grid contact fingers
      ctx.strokeStyle = "rgba(175, 210, 250, 0.35)";
      ctx.lineWidth = 0.8;
      for (let y = cy + 6; y < cy + cellH - 4; y += 6) {
        ctx.beginPath();
        ctx.moveTo(cx + 3, y);
        ctx.lineTo(cx + cellW - 3, y);
        ctx.stroke();
      }

      // Dual silver main busbars
      ctx.strokeStyle = "#d4e4f7";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(cx + cellW * 0.33, cy + 2);
      ctx.lineTo(cx + cellW * 0.33, cy + cellH - 2);
      ctx.moveTo(cx + cellW * 0.67, cy + 2);
      ctx.lineTo(cx + cellW * 0.67, cy + cellH - 2);
      ctx.stroke();

      // Inter-cell solder tabs
      ctx.fillStyle = "#e2edf8";
      ctx.fillRect(cx + cellW * 0.33 - 1.5, cy, 3, 3);
      ctx.fillRect(cx + cellW * 0.67 - 1.5, cy, 3, 3);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function createNasaBadgeTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const w = 256, h = 128;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;

  // Titanium insignia plaque
  ctx.fillStyle = "#2a3442";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#5a6878";
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  // NASA Red / Blue typographic insignia
  ctx.fillStyle = "#fc3d21";
  ctx.font = "bold 42px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("NASA", w / 2, h * 0.40);

  ctx.fillStyle = "#6f93d8";
  ctx.font = "bold 15px monospace";
  ctx.fillText("ARTEMIS · HELIOS", w / 2, h * 0.76);

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function createCalibrationTargetTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#222a36";
  ctx.fillRect(0, 0, s, s);

  // NASA MastCam color calibration chips (corners and center)
  const chips = [
    { x: 30, y: 30, color: "#fc3d21" }, // Red
    { x: 98, y: 30, color: "#22c55e" }, // Green
    { x: 30, y: 98, color: "#3b82f6" }, // Blue
    { x: 98, y: 98, color: "#eab308" }, // Yellow
    { x: 64, y: 64, color: "#f8fafc" }, // 100% White
  ];

  for (const c of chips) {
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------- wheel
function Wheel({ x, z }: { x: number; z: number }) {
  const R = 66;
  const W = 46;
  const isRight = x > 0;
  return (
    <group position={[x, R, z]}>
      {/* Outer tyre mesh cylinder */}
      <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[R, R, W, 28]} />
        {MESH("darkChassis")}
      </mesh>

      {/* Titanium bead-lock outer rim rings */}
      <mesh position={[isRight ? W * 0.5 : -W * 0.5, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <torusGeometry args={[R * 0.98, 4, 8, 28]} />
        {MESH("titanium")}
      </mesh>
      <mesh position={[isRight ? -W * 0.5 : W * 0.5, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <torusGeometry args={[R * 0.98, 4, 8, 28]} />
        {MESH("titanium")}
      </mesh>

      {/* 16 authentic titanium chevron grousers for regolith traction */}
      {Array.from({ length: 16 }).map((_, i) => {
        const ang = (i / 16) * Math.PI * 2;
        return (
          <group key={i} rotation={[ang, 0, 0]}>
            <mesh position={[0, R * 0.98, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
              <boxGeometry args={[W * 0.46, 5, 3.5]} />
              {MESH("titanium")}
            </mesh>
            <mesh position={[0, R * 0.98, 0]} rotation={[0, -Math.PI / 4, 0]} castShadow>
              <boxGeometry args={[W * 0.46, 5, 3.5]} />
              {MESH("titanium")}
            </mesh>
          </group>
        );
      })}

      {/* Central planetary gear hub motor casing */}
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[R * 0.44, R * 0.44, W + 8, 18]} />
        {MESH("hull")}
      </mesh>

      {/* Wheel hub faceplate with hex bolt circle */}
      <mesh position={[isRight ? W * 0.54 : -W * 0.54, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[R * 0.32, R * 0.32, 4, 16]} />
        {MESH("titanium")}
      </mesh>

      {/* Inboard drive spindle axle extending cleanly to the suspension bogie */}
      <mesh
        position={[isRight ? -W * 0.70 : W * 0.70, 0, 0]}
        rotation={[0, 0, Math.PI / 2]}
      >
        <cylinderGeometry args={[11, 11, 38, 14]} />
        {MESH("metal")}
      </mesh>
    </group>
  );
}

// -------------------------------------------------------- procedural rover
function ProceduralRover() {
  const wheelsGroupRef = useRef<THREE.Group>(null);
  const cameraMode = useUiStore((s) => s.cameraMode);
  const mastcamPan = useUiStore((s) => s.mastcamPan);
  const mastcamTilt = useUiStore((s) => s.mastcamTilt);
  const panRad = (mastcamPan * Math.PI) / 180;
  const tiltRad = (mastcamTilt * Math.PI) / 180;

  // Procedural aerospace textures
  const shadowTex = useMemo(() => {
    if (typeof document === "undefined") return null;
    const s = 128;
    const cv = document.createElement("canvas");
    cv.width = cv.height = s;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(0,0,0,0.65)");
    g.addColorStop(0.45, "rgba(0,0,0,0.30)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }, []);

  const foilBumpTex = useMemo(() => createCrinkleFoilTexture(), []);
  const solarTex = useMemo(() => createSolarArrayTexture(), []);
  const badgeTex = useMemo(() => createNasaBadgeTexture(), []);
  const calibTex = useMemo(() => createCalibrationTargetTexture(), []);

  // 6 wheels placed with clearance outside the chassis (chassis half-width = 110)
  const wheels: [number, number][] = [
    [-164, -140], [-164, 0], [-164, 140],
    [164, -140],  [164, 0],  [164, 140],
  ];

  // Dynamic wheel drive rotation when rover is in motion
  useFrame((_, delta) => {
    const p = roverGridPos();
    if (p && p.moving && wheelsGroupRef.current) {
      wheelsGroupRef.current.children.forEach((wheel) => {
        wheel.rotation.x += delta * 3.2;
      });
    }
  });

  return (
    <group>
      {/* Ground contact shadow decal */}
      {shadowTex && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.5, 0]}>
          <planeGeometry args={[620, 620]} />
          <meshBasicMaterial map={shadowTex} transparent depthWrite={false} opacity={0.88} />
        </mesh>
      )}

      {/* ----------------------------- CHASSIS ----------------------------- */}
      {/* Central Warm Electronics Box monocoque body (W: 220, H: 86, L: 260) */}
      <mesh position={[0, 160, 0]} castShadow receiveShadow>
        <boxGeometry args={[220, 86, 260]} />
        {MESH("hull")}
      </mesh>

      {/* Gold Kapton MLI thermal blanket deck with tactile crinkle bump */}
      <mesh position={[0, 206, 0]} castShadow>
        <boxGeometry args={[228, 10, 268]} />
        <meshStandardMaterial
          color="#dfa735"
          roughness={0.28}
          metalness={0.92}
          bumpMap={foilBumpTex ?? undefined}
          bumpScale={0.85}
        />
      </mesh>

      {/* NASA Artemis mission insignia plaques on port and starboard flanks */}
      {badgeTex && (
        <>
          <mesh position={[-111, 160, 0]} rotation={[0, -Math.PI / 2, 0]}>
            <planeGeometry args={[90, 45]} />
            <meshStandardMaterial map={badgeTex} roughness={0.4} metalness={0.6} />
          </mesh>
          <mesh position={[111, 160, 0]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[90, 45]} />
            <meshStandardMaterial map={badgeTex} roughness={0.4} metalness={0.6} />
          </mesh>
        </>
      )}

      {/* ----------------------- ROCKER-BOGIE LINKAGE ----------------------- */}
      {/* Sits at x = ±132 (safely between chassis wall x=110 and wheels x=164) */}
      {[-132, 132].map((sx) => (
        <group key={sx}>
          {/* Main differential rocker arm (long diagonal from front to center pivot) */}
          <mesh position={[sx, 126, -55]} rotation={[0.42, 0, 0]} castShadow>
            <boxGeometry args={[14, 16, 190]} />
            {MESH("titanium")}
          </mesh>

          {/* Rear bogie pivot link (connecting middle to rear wheel) */}
          <mesh position={[sx, 114, 70]} rotation={[-0.32, 0, 0]} castShadow>
            <boxGeometry args={[12, 14, 165]} />
            {MESH("titanium")}
          </mesh>

          {/* Differential pivot joint hub with central bearing */}
          <mesh position={[sx, 154, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[18, 18, 20, 16]} />
            {MESH("darkChassis")}
          </mesh>
        </group>
      ))}

      {/* Transverse differential rocker cross-bar across the chassis roof */}
      <mesh position={[0, 214, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[9, 9, 270, 14]} />
        {MESH("titanium")}
      </mesh>

      {/* 6 Driven wheels with rotation group */}
      <group ref={wheelsGroupRef}>
        {wheels.map(([x, z]) => (
          <Wheel key={`${x}:${z}`} x={x} z={z} />
        ))}
      </group>

      {/* --------------------------- SOLAR ARRAY --------------------------- */}
      {/* Structural support pylons from deck */}
      {[-85, 85].flatMap((px) =>
        [-60, 60].map((pz) => (
          <mesh key={`${px}:${pz}`} position={[px, 224, pz]}>
            <cylinderGeometry args={[5, 6, 26, 8]} />
            {MESH("metal")}
          </mesh>
        )),
      )}

      {/* Photovoltaic panel deck with GaAs micro-grid texture */}
      <mesh position={[0, 240, 0]} rotation={[0.04, 0, 0]} castShadow>
        <boxGeometry args={[340, 8, 280]} />
        <meshStandardMaterial
          map={solarTex ?? undefined}
          roughness={0.22}
          metalness={0.65}
          color="#ffffff"
        />
      </mesh>

      {/* Protective titanium perimeter bezel */}
      <mesh position={[0, 240, 0]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[344, 2, 284]} />
        {MESH("panelFrame")}
      </mesh>

      {/* MastCam color calibration target palette on deck */}
      {calibTex && (
        <mesh position={[95, 245, 80]} rotation={[-Math.PI / 2 + 0.04, 0, 0]}>
          <planeGeometry args={[42, 42]} />
          <meshStandardMaterial map={calibTex} roughness={0.6} />
        </mesh>
      )}

      {/* --------------------------- CAMERA MAST --------------------------- */}
      {/* Front-mounted telescoping titanium mast column */}
      <mesh position={[0, 310, -85]}>
        <cylinderGeometry args={[9, 12, 140, 14]} />
        {MESH("titanium")}
      </mesh>

      {/* Articulated Pan-Tilt Gimbal Yoke (Azimuth pan rotation) */}
      <group position={[0, 375, -85]} rotation={[0, -panRad, 0]}>
        <mesh>
          <boxGeometry args={[34, 14, 28]} />
          {MESH("metal")}
        </mesh>

        {/* Articulated Stereo Camera Head (Elevation tilt rotation) - hidden in MastCam view so the sensor head never occludes the camera */}
        {cameraMode !== "mastcam" && (
          <group position={[0, 21, 0]} rotation={[-tiltRad, 0, 0]}>
            {/* MastCam pan-tilt stereo sensor head */}
            <mesh castShadow>
              <boxGeometry args={[92, 42, 38]} />
              {MESH("hull")}
            </mesh>

            {/* Dual stereo MastCam optical apertures with anti-reflective sapphire lenses */}
            {[-24, 24].map((lx) => (
              <group key={lx} position={[lx, 0, -19]}>
                {/* Lens barrel */}
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[11, 11, 10, 18]} />
                  {MESH("titanium")}
                </mesh>
                {/* Optical aperture glass */}
                <mesh position={[0, 0, -5]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[9, 9, 2, 18]} />
                  {MESH("accent")}
                </mesh>
              </group>
            ))}

            {/* Central laser spectrometer aperture */}
            <mesh position={[0, 0, -20]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[6, 6, 12, 14]} />
              {MESH("darkChassis")}
            </mesh>

            {/* Mini sun-sensor pyranometer dome */}
            <mesh position={[34, 24, 0]}>
              <sphereGeometry args={[6, 12, 12]} />
              {MESH("foil")}
            </mesh>
          </group>
        )}
      </group>

      {/* ------------------------ HIGH-GAIN ANTENNA ------------------------ */}
      {/* Dual-axis gimbal turret mount on aft-left deck */}
      <mesh position={[-75, 258, 85]} rotation={[0.3, 0, 0.2]}>
        <cylinderGeometry args={[9, 9, 28, 12]} />
        {MESH("metal")}
      </mesh>

      {/* Parabolic S-band dish reflector pointing Earthward */}
      <mesh position={[-75, 292, 85]} rotation={[0.7, 0, 0.4]}>
        <coneGeometry args={[48, 28, 24, 1, true]} />
        <meshStandardMaterial color="#c8d2de" roughness={0.32} metalness={0.78} side={THREE.DoubleSide} />
      </mesh>

      {/* Cassegrain sub-reflector feed horn at dish focal point */}
      <mesh position={[-66, 312, 92]} rotation={[0.7, 0, 0.4]}>
        <cylinderGeometry args={[3, 5, 14, 10]} />
        {MESH("goldArm")}
      </mesh>

      {/* ------------------------ ROBOTIC DRILL ARM ------------------------ */}
      {/* Starboard front TRIDENT volatiles drill assembly */}
      <group position={[85, 175, -110]}>
        {/* Arm mounting bracket */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[28, 36, 42]} />
          {MESH("darkChassis")}
        </mesh>
        {/* Drill percussion tower */}
        <mesh position={[0, -18, 14]}>
          <boxGeometry args={[14, 62, 14]} />
          {MESH("titanium")}
        </mesh>
        {/* Spiral carbide drill auger bit */}
        <mesh position={[0, -56, 14]} rotation={[0, 0, 0]}>
          <cylinderGeometry args={[4, 5, 36, 10]} />
          {MESH("goldArm")}
        </mesh>
      </group>

      {/* -------------------- FORWARD SENSORS & HAZCAMS -------------------- */}
      {/* Dual lower HazCams (Hazard Avoidance Cameras) on front bumper */}
      {[-65, 65].map((hx) => (
        <group key={hx} position={[hx, 134, -132]}>
          <mesh rotation={[0.25, 0, 0]}>
            <boxGeometry args={[18, 14, 12]} />
            {MESH("titanium")}
          </mesh>
          <mesh position={[0, 0, -7]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[4.5, 4.5, 4, 12]} />
            {MESH("accent")}
          </mesh>
        </group>
      ))}

      {/* Neutron Spectrometer System (NSS) sensor canisters on front nose */}
      {[-20, 20].map((nx) => (
        <mesh key={nx} position={[nx, 140, -134]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[7, 7, 18, 12]} />
          {MESH("foil")}
        </mesh>
      ))}

      {/* Forward LED exploration floodlights for permanently shadowed crater floors */}
      {[-45, 45].map((lx) => (
        <mesh key={lx} position={[lx, 150, -132]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[6, 6, 6, 14]} />
          {MESH("ledHeadlight")}
        </mesh>
      ))}

      {/* --------------------- AFT AVIONICS & RADIATOR --------------------- */}
      {/* Rear radiative heat louvers with finned cooling slots */}
      <mesh position={[0, 168, 134]} castShadow>
        <boxGeometry args={[186, 54, 16]} />
        {MESH("darkChassis")}
      </mesh>
      {[-60, -20, 20, 60].map((fx) => (
        <mesh key={fx} position={[fx, 168, 143]}>
          <boxGeometry args={[24, 46, 3]} />
          {MESH("titanium")}
        </mesh>
      ))}

      {/* Forward heading strobe beacon */}
      <mesh position={[0, 158, -135]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <coneGeometry args={[32, 60, 4]} />
        {MESH("accent")}
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------- GLB path
/** Swallow a failed GLTF load so the procedural rover still renders. */
class GlbBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function GlbRover({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const fitted = useMemo(() => {
    const c = scene.clone(true);
    const box = new THREE.Box3().setFromObject(c);
    const size = box.getSize(new THREE.Vector3());
    const scale = TARGET_LEN / Math.max(size.x, size.z, 1e-6);
    const center = box.getCenter(new THREE.Vector3());
    // Re-centre on x/z and drop the bounding-box floor to y = 0 (contact patch).
    c.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    c.scale.setScalar(scale);
    c.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return c;
  }, [scene]);
  return <primitive object={fitted} />;
}

// ------------------------------------------------------------------- export
export default function RoverModel() {
  if (ROVER_GLB) {
    return (
      <GlbBoundary fallback={<ProceduralRover />}>
        <Suspense fallback={<ProceduralRover />}>
          <GlbRover url={ROVER_GLB} />
        </Suspense>
      </GlbBoundary>
    );
  }
  return <ProceduralRover />;
}
