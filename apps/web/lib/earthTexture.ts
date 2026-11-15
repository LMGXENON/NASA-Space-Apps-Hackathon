import * as THREE from "three";

let cachedEarthTex: THREE.CanvasTexture | null = null;
let cachedSunFlareTex: THREE.CanvasTexture | null = null;

/**
 * Procedural Earth texture (Blue Marble standard):
 * Rich royal blue ocean, continental shelves (cyan), green continents, Sahara/Arabian sands,
 * polar ice sheets, and swirling white cloud cover.
 */
export function getEarthTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedEarthTex) return cachedEarthTex;

  const w = 1024;
  const h = 512;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;

  // Ocean base
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, h);
  oceanGrad.addColorStop(0, "#081d45");
  oceanGrad.addColorStop(0.5, "#0d316b");
  oceanGrad.addColorStop(1, "#081d45");
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, w, h);

  // Continental shelves (shallow cyan water along coastlines)
  ctx.fillStyle = "#1b5a94";
  ctx.beginPath();
  ctx.ellipse(w * 0.28, h * 0.38, 75, 48, -0.2, 0, Math.PI * 2);
  ctx.ellipse(w * 0.33, h * 0.68, 55, 78, 0.1, 0, Math.PI * 2);
  ctx.ellipse(w * 0.62, h * 0.35, 105, 55, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.58, h * 0.58, 65, 72, 0.1, 0, Math.PI * 2);
  ctx.ellipse(w * 0.82, h * 0.72, 45, 34, -0.1, 0, Math.PI * 2);
  ctx.fill();

  // Continents (green landmass)
  ctx.fillStyle = "#276838";
  ctx.beginPath();
  // North America
  ctx.ellipse(w * 0.27, h * 0.38, 65, 40, -0.2, 0, Math.PI * 2);
  // South America
  ctx.ellipse(w * 0.33, h * 0.68, 46, 68, 0.1, 0, Math.PI * 2);
  // Eurasia
  ctx.ellipse(w * 0.63, h * 0.34, 90, 46, 0, 0, Math.PI * 2);
  // Africa
  ctx.ellipse(w * 0.57, h * 0.58, 54, 62, 0.1, 0, Math.PI * 2);
  // Australia
  ctx.ellipse(w * 0.82, h * 0.72, 36, 26, -0.1, 0, Math.PI * 2);
  ctx.fill();

  // Desert regions (Sahara & Middle East)
  ctx.fillStyle = "#bfa365";
  ctx.beginPath();
  ctx.ellipse(w * 0.57, h * 0.44, 42, 18, 0.05, 0, Math.PI * 2);
  ctx.ellipse(w * 0.66, h * 0.41, 26, 14, 0.1, 0, Math.PI * 2);
  ctx.fill();

  // Polar ice caps
  ctx.fillStyle = "#f0f6ff";
  ctx.fillRect(0, h * 0.88, w, h * 0.12);
  ctx.fillRect(0, 0, w, h * 0.08);

  // Swirling cloud systems
  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  for (let i = 0; i < 28; i++) {
    ctx.beginPath();
    const cx = (i * 37 + 23) % w;
    const cy = h * 0.15 + (i * 31) % (h * 0.7);
    const rx = 45 + (i % 5) * 16;
    const ry = 10 + (i % 3) * 6;
    const rot = ((i % 4) - 1.5) * 0.3;
    ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
    ctx.fill();
  }

  // Tropical vortex
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.beginPath();
  ctx.arc(w * 0.22, h * 0.42, 22, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  cachedEarthTex = tex;
  return tex;
}

/**
 * Radial solar corona gradient texture
 */
export function getSunFlareTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (cachedSunFlareTex) return cachedSunFlareTex;

  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const cx = s / 2, cy = s / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s / 2);
  g.addColorStop(0, "rgba(255, 255, 255, 1.0)");
  g.addColorStop(0.18, "rgba(255, 245, 200, 0.95)");
  g.addColorStop(0.42, "rgba(255, 215, 110, 0.5)");
  g.addColorStop(0.72, "rgba(255, 160, 40, 0.15)");
  g.addColorStop(1, "rgba(255, 120, 20, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cachedSunFlareTex = tex;
  return tex;
}
