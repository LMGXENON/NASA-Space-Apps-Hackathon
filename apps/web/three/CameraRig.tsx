"use client";

/**
 * CameraRig — NASA-grade First-Person MastCam Rig & Orbital Controller.
 *
 * Implements:
 * 1. Attached Chassis & Mast Hierarchy: Camera is anchored to the rover chassis
 *    pivot in world coordinates, eliminating motion glitching or desync.
 * 2. Inertial Dampening & Vibration Filtering: Filters out high-frequency terrain
 *    surface normal jumps (rocker-bogie shock absorption) with dual-stage EMA lerp.
 * 3. Dynamic Gimbal Motion: Smoothly dampens user pan, tilt, and optical zoom inputs
 *    with zero hard snapping.
 * 4. Smooth Reset View: Transitions pan, tilt, and zoom back to forward alignment
 *    over ~0.6 seconds using cubic ease-out math.
 */

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useUiStore } from "../store/uiStore";
import { roverGridPos } from "../lib/roverPos";
import { gridToScene, meshSurfaceHeight, meshSurfaceNormal, MESH_SEG } from "../lib/sceneMath";

const ORBIT_DURATION_S = 1.1;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const cubicEaseOut = (t: number) => 1 - Math.pow(1 - t, 3);

// Scratch vectors and quaternions hoisted to eliminate per-frame allocations
const UP_VEC = new THREE.Vector3(0, 1, 0);
const N_VEC = new THREE.Vector3();
const TILT_Q = new THREE.Quaternion();
const YAW_Q = new THREE.Quaternion();
const TARGET_ROVER_Q = new THREE.Quaternion();
const TARGET_ROVER_POS = new THREE.Vector3();

// Mast stereo camera aperture offset in rover chassis local space (mm -> scene units)
// Placed at the top-front of the mast head (Y=415, Z=-125) looking forward into lunar vista
const LOCAL_MAST_PIVOT = new THREE.Vector3(0, 415, -125);
const APERTURE_WORLD = new THREE.Vector3();
const LOCAL_LOOK = new THREE.Vector3();
const LOOK_WORLD = new THREE.Vector3();
const CAM_TARGET = new THREE.Vector3();
const CAM_UP = new THREE.Vector3();

export default function CameraRig() {
  const lastNonce = useRef(0);
  const orbitAnim = useRef<{
    t: number;
    from: THREE.Vector3;
    fromPos: THREE.Vector3;
    to: THREE.Vector3;
    dir: THREE.Vector3;
    distance: number;
  } | null>(null);

  // Inertial dampening state for rover chassis smoothing (Forza-style stable rig)
  const smoothedRoverPos = useRef(new THREE.Vector3());
  const smoothedRoverQuat = useRef(new THREE.Quaternion());
  const isInitialized = useRef(false);

  // Gimbal angle smoothing refs
  const currentPan = useRef(0);
  const currentTilt = useRef(-5);
  const currentZoom = useRef(1.0);

  // Smooth Reset Animation state
  const resetAnim = useRef<{
    active: boolean;
    startTime: number;
    duration: number;
    startPan: number;
    startTilt: number;
    startZoom: number;
  } | null>(null);

  // Listen for smooth reset requests via custom window event or keyboard
  useEffect(() => {
    const handleSmoothReset = () => {
      resetAnim.current = {
        active: true,
        startTime: performance.now(),
        duration: 600, // 0.6 seconds
        startPan: currentPan.current,
        startTilt: currentTilt.current,
        startZoom: currentZoom.current,
      };
    };

    window.addEventListener("helios-mastcam-reset", handleSmoothReset);
    return () => window.removeEventListener("helios-mastcam-reset", handleSmoothReset);
  }, []);

  useFrame((state, dt) => {
    const controls = (state as unknown as { controls?: { target: THREE.Vector3; update: () => void } | null }).controls;
    const s = useUiStore.getState();

    // -------------------------------------------------------------
    // MODE 1: FIRST-PERSON MASTCAM (ROVER ATTACHED GIMBAL)
    // -------------------------------------------------------------
    if (s.cameraMode === "mastcam") {
      const terrain = s.terrain;
      const p = roverGridPos();

      if (terrain && p) {
        const ex = s.exaggeration;
        const h = meshSurfaceHeight(terrain.hf, p.x, p.y);
        const [sx, , sz] = gridToScene(p.x, p.y);
        const [nx, ny, nz] = meshSurfaceNormal(terrain.hf, p.x, p.y, MESH_SEG, ex);

        // Ground clearance matching 3D RoverModel
        const slopeSin = Math.sqrt(nx * nx + nz * nz);
        const groundSag = slopeSin * 36;
        const roverY = (h - terrain.meta.height.min) * ex + groundSag + 2.5;

        TARGET_ROVER_POS.set(sx, roverY, sz);

        // Rover orientation: terrain slope tilt * driving heading
        N_VEC.set(nx, ny, nz);
        TILT_Q.setFromUnitVectors(UP_VEC, N_VEC);
        YAW_Q.setFromAxisAngle(UP_VEC, -p.heading + Math.PI);
        TARGET_ROVER_Q.copy(TILT_Q).multiply(YAW_Q);

        // Initialize smoothing immediately on first activation
        if (!isInitialized.current) {
          smoothedRoverPos.current.copy(TARGET_ROVER_POS);
          smoothedRoverQuat.current.copy(TARGET_ROVER_Q);
          currentPan.current = s.mastcamPan;
          currentTilt.current = s.mastcamTilt;
          currentZoom.current = s.mastcamZoom;
          isInitialized.current = true;
        } else {
          // Inertial dampening & shock absorption: filters out terrain polygonal vibration
          const posDamp = THREE.MathUtils.clamp(dt * 16, 0.05, 0.45);
          const rotDamp = THREE.MathUtils.clamp(dt * 12, 0.05, 0.35);
          smoothedRoverPos.current.lerp(TARGET_ROVER_POS, posDamp);
          smoothedRoverQuat.current.slerp(TARGET_ROVER_Q, rotDamp);
        }

        // Handle Smooth Reset Interpolation over ~0.6 seconds
        if (resetAnim.current?.active) {
          const elapsed = performance.now() - resetAnim.current.startTime;
          const progress = Math.min(1, elapsed / resetAnim.current.duration);
          const ease = cubicEaseOut(progress);

          const newPan = THREE.MathUtils.lerp(resetAnim.current.startPan, 0, ease);
          const newTilt = THREE.MathUtils.lerp(resetAnim.current.startTilt, -5, ease);
          const newZoom = THREE.MathUtils.lerp(resetAnim.current.startZoom, 1.0, ease);

          currentPan.current = newPan;
          currentTilt.current = newTilt;
          currentZoom.current = newZoom;

          // Sync back to store without snapping
          s.setMastcamPan(newPan);
          s.setMastcamTilt(newTilt);
          s.setMastcamZoom(newZoom);

          if (progress >= 1) {
            resetAnim.current = null;
          }
        } else {
          // Regular dynamic gimbal smoothing
          const gimbalDamp = THREE.MathUtils.clamp(dt * 10, 0.05, 0.45);
          currentPan.current = THREE.MathUtils.lerp(currentPan.current, s.mastcamPan, gimbalDamp);
          currentTilt.current = THREE.MathUtils.lerp(currentTilt.current, s.mastcamTilt, gimbalDamp);
          currentZoom.current = THREE.MathUtils.lerp(currentZoom.current, s.mastcamZoom, gimbalDamp);
        }

        // Attach MastCam Stereo Aperture natively to smoothed chassis frame
        APERTURE_WORLD.copy(LOCAL_MAST_PIVOT)
          .applyQuaternion(smoothedRoverQuat.current)
          .add(smoothedRoverPos.current);

        // -----------------------------------------------------------------
        // YAW & TILT GIMBAL ROTATION
        // Rover forward heading is -Z in rover chassis local coordinates.
        // pan=0, tilt=0 points straight ahead along -Z into the lunar terrain.
        // Positive pan turns right (+X), positive tilt aims up (+Y).
        // -----------------------------------------------------------------
        const panRad = (currentPan.current * Math.PI) / 180;
        const tiltRad = (currentTilt.current * Math.PI) / 180;

        LOCAL_LOOK.set(
          Math.sin(panRad) * Math.cos(tiltRad),
          Math.sin(tiltRad),
          -Math.cos(panRad) * Math.cos(tiltRad),
        );
        LOOK_WORLD.copy(LOCAL_LOOK).applyQuaternion(smoothedRoverQuat.current);

        // Position camera directly at mast aperture and aim along gimbal line of sight
        state.camera.position.copy(APERTURE_WORLD);
        CAM_TARGET.copy(APERTURE_WORLD).addScaledVector(LOOK_WORLD, 450);

        CAM_UP.copy(UP_VEC).applyQuaternion(smoothedRoverQuat.current);
        state.camera.up.copy(CAM_UP);
        state.camera.lookAt(CAM_TARGET);

        if (controls && controls.target) {
          controls.target.copy(CAM_TARGET);
        }

        // Dynamic optical zoom (50° down to 12.5° FOV)
        if ("isPerspectiveCamera" in state.camera && state.camera.isPerspectiveCamera) {
          const persCam = state.camera as THREE.PerspectiveCamera;
          const targetFov = 50 / currentZoom.current;
          if (Math.abs(persCam.fov - targetFov) > 0.02) {
            persCam.fov = targetFov;
            persCam.updateProjectionMatrix();
          }
        }

        return;
      }
    } else {
      isInitialized.current = false;
      // Reset perspective camera FOV when returning to orbit mode
      if ("isPerspectiveCamera" in state.camera && state.camera.isPerspectiveCamera) {
        const persCam = state.camera as THREE.PerspectiveCamera;
        if (persCam.fov !== 50) {
          persCam.fov = 50;
          persCam.up.set(0, 1, 0);
          persCam.updateProjectionMatrix();
        }
      }
    }

    // -------------------------------------------------------------
    // MODE 2: ORBIT CAMERA SMOOTH FOCUS ANIMATION
    // -------------------------------------------------------------
    if (!controls || !controls.target) return;

    const focus = s.focus;
    if (focus && focus.nonce !== lastNonce.current) {
      lastNonce.current = focus.nonce;
      const to = new THREE.Vector3(focus.target[0], focus.target[1], focus.target[2]);
      let dir: THREE.Vector3;
      if (focus.dir) {
        dir = new THREE.Vector3(focus.dir[0], focus.dir[1], focus.dir[2]).normalize();
      } else {
        dir = state.camera.position.clone().sub(controls.target);
        if (dir.lengthSq() < 1e-6 || dir.y > 0.9) dir.set(0.6, 0.45, 0.6);
        dir.normalize();
      }
      orbitAnim.current = {
        t: 0,
        from: controls.target.clone(),
        fromPos: state.camera.position.clone(),
        to,
        dir,
        distance: focus.distance,
      };
    }

    const a = orbitAnim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / ORBIT_DURATION_S);
    const e = easeInOut(a.t);
    controls.target.lerpVectors(a.from, a.to, e);
    const camPosTarget = a.to.clone().addScaledVector(a.dir, a.distance);
    state.camera.position.lerpVectors(a.fromPos, camPosTarget, e);
    controls.update();
    if (a.t >= 1) orbitAnim.current = null;
  });

  return null;
}
