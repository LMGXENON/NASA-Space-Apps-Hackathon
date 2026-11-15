/**
 * TerrainMaterial (PRD Part B §5, §7.2, §7.5): vertex displacement from the
 * Terrain-RGB height texture, per-fragment normals via central differences,
 * O(1) horizon lookup in a DataArrayTexture, Sun/Earth disc-visibility
 * classification, and heat-overlay modes.
 */

import * as THREE from "three";

export const HEAT_MODE = {
  OFF: 0,
  CLASSIFIED: 1,
  SUN_GRADIENT: 2,
  DUTY: 3,
  SLOPE_HAZARD: 4,
  CONTOURS: 5,
  PSR_COLD_TRAP: 6,
} as const;

// Must match constants.ts in @helios/core:
const THETA_MIN = -10.0;
const THETA_STEP = 0.25;

export function createTerrainUniforms(opts: {
  heightTex: THREE.DataTexture;
  horizonTex: THREE.DataArrayTexture | null;
  px: number;
  aoiHalf: number;
  hMin: number;
  hMax: number;
}) {
  return {
    uHeight: { value: opts.heightTex },
    uHorizon: { value: opts.horizonTex },
    uPx: { value: opts.px },
    uAoiHalf: { value: opts.aoiHalf },
    uHMin: { value: opts.hMin },
    uHMax: { value: opts.hMax },
    uExaggeration: { value: 1.0 },
    uSunME: { value: new THREE.Vector3(1, 0, 0) },
    uEarthME: { value: new THREE.Vector3(0, 1, 0) },
    uSunR: { value: 0.00465 },
    uEarthR: { value: 0.0166 },
    uHeatMode: { value: HEAT_MODE.CLASSIFIED as number },
    uHeatOpacity: { value: 0.75 },
    uSunColor: { value: new THREE.Color("#ffe066") },
    uHasHorizon: { value: 0 },
    uDuty: { value: null as THREE.DataTexture | null },
    uDutyW: { value: 96 },
  };
}

export const terrainVert = /* glsl */ `
uniform sampler2D uHeight;
uniform float uPx;
uniform float uAoiHalf;
uniform float uHMin;
uniform float uHMax;
uniform float uExaggeration;

varying vec2 vUv;
varying float vHeight;
varying vec3 vWorldPos;

// terrain-rgb-0.01 (see tools/prep_dem.py).
// Decodes exact integer texel elevation:
float decodeRawTexel(vec2 uv) {
  vec3 c = texture2D(uHeight, uv).rgb * 255.0;
  return -10000.0 + (c.r * 65536.0 + c.g * 256.0 + c.b) * 0.01;
}

// Sub-texel Hermite cubic interpolation of decoded heights:
// Prevents byte-rollover spikes & stair-stepping facets when zooming in close!
float sampleBilinearHeight(vec2 uv) {
  vec2 texel = vec2(1.0 / uPx);
  vec2 coord = uv * uPx - 0.5;
  vec2 f = fract(coord);
  vec2 w = f * f * (3.0 - 2.0 * f); // Hermite smoothstep
  vec2 baseUv = (floor(coord) + 0.5) * texel;

  float h00 = decodeRawTexel(baseUv);
  float h10 = decodeRawTexel(baseUv + vec2(texel.x, 0.0));
  float h01 = decodeRawTexel(baseUv + vec2(0.0, texel.y));
  float h11 = decodeRawTexel(baseUv + vec2(texel.x, texel.y));

  return mix(mix(h00, h10, w.x), mix(h01, h11, w.x), w.y);
}

void main() {
  vUv = uv;
  float h = sampleBilinearHeight(uv);
  vHeight = h;
  // The plane's local (x, y) axes ARE the grid (X, Y) axes; map them onto the
  // ground plane so scene X = grid X, scene Z = -grid Y and Y is up.
  vec3 p = vec3(position.x, (h - uHMin) * uExaggeration, -position.y);
  vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
}
`;

export const terrainFrag = /* glsl */ `
precision highp float;

uniform sampler2D uHeight;
uniform highp sampler2DArray uHorizon;
uniform float uPx;
uniform float uAoiHalf;
uniform float uExaggeration;
uniform vec3 uSunME;
uniform vec3 uEarthME;
uniform float uSunR;
uniform float uEarthR;
uniform int uHeatMode;
uniform float uHeatOpacity;
uniform vec3 uSunColor;
uniform float uHasHorizon;
uniform sampler2D uDuty;
uniform float uDutyW;

varying vec2 vUv;
varying float vHeight;
varying vec3 vWorldPos;


const float THETA_MIN = ${THETA_MIN.toFixed(1)};
const float THETA_STEP = ${THETA_STEP.toFixed(2)};
const float PI = 3.14159265358979;

float decodeRawTexel(vec2 uv) {
  vec3 c = texture2D(uHeight, uv).rgb * 255.0;
  return -10000.0 + (c.r * 65536.0 + c.g * 256.0 + c.b) * 0.01;
}

float sampleBilinearHeight(vec2 uv) {
  vec2 texel = vec2(1.0 / uPx);
  vec2 coord = uv * uPx - 0.5;
  vec2 f = fract(coord);
  vec2 w = f * f * (3.0 - 2.0 * f);
  vec2 baseUv = (floor(coord) + 0.5) * texel;

  float h00 = decodeRawTexel(baseUv);
  float h10 = decodeRawTexel(baseUv + vec2(texel.x, 0.0));
  float h01 = decodeRawTexel(baseUv + vec2(0.0, texel.y));
  float h11 = decodeRawTexel(baseUv + vec2(texel.x, texel.y));

  return mix(mix(h00, h10, w.x), mix(h01, h11, w.x), w.y);
}

// Continuous Central-Difference normal with sub-texel precision:
vec3 terrainNormal(vec2 uv) {
  float texel = 1.0 / uPx;
  float hl = sampleBilinearHeight(uv - vec2(texel, 0.0));
  float hr = sampleBilinearHeight(uv + vec2(texel, 0.0));
  float hd = sampleBilinearHeight(uv - vec2(0.0, texel));
  float hu = sampleBilinearHeight(uv + vec2(0.0, texel));
  float ws = 2.0 * uAoiHalf / uPx;          // meters per texel
  float dhdx = (hr - hl) / (2.0 * ws);
  float dhdy = (hu - hd) / (2.0 * ws);
  vec3 n = normalize(vec3(-dhdx * uExaggeration, 1.0, dhdy * uExaggeration));
  return n;
}

// Horizon angle [deg] at this fragment for a GRID-frame azimuth (0 = +Y grid,
// toward +X grid — the convention bake_horizon.py used when packing the map).
float horizonDeg(vec2 uv, float azGridRad) {
  float a = mod(azGridRad, 6.28318530718) / 6.28318530718 * 64.0;   // uAzBins=64 baked
  float i0 = floor(a);
  float t = a - i0;
  float i1 = mod(i0 + 1.0, 64.0);
  float h0 = texture2D(uHorizon, vec3(uv, floor(i0 / 4.0)))[int(mod(i0, 4.0))];
  float h1 = texture2D(uHorizon, vec3(uv, floor(i1 / 4.0)))[int(mod(i1, 4.0))];
  return THETA_MIN + 255.0 * mix(h0, h1, t) * THETA_STEP;
}

// Fraction of a disc (angular radius r) whose center is at elevation e above horizon h:
float discVisible(float e, float h, float r) {
  float d = clamp((e - h) / r, -1.0, 1.0);
  float f = 1.0 - (acos(d) - d * sqrt(max(0.0, 1.0 - d * d))) / PI;
  return clamp(f, 0.0, 1.0);
}

// Smooth continuous 2D value noise (anti-aliased, zero square blocks)
float regolithHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float smoothNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = regolithHash(i);
  float b = regolithHash(i + vec2(1.0, 0.0));
  float c = regolithHash(i + vec2(0.0, 1.0));
  float d = regolithHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fractalMicroNoise(vec2 p) {
  float v = 0.0;
  v += 0.5000 * smoothNoise(p); p *= 2.02;
  v += 0.2500 * smoothNoise(p); p *= 2.04;
  v += 0.1250 * smoothNoise(p); p *= 2.01;
  v += 0.0625 * smoothNoise(p);
  return v;
}

float regolithGrain(vec2 worldXz) {
  // Multi-frequency smooth fractal micro-regolith: silky smooth right down to millimeters!
  float coarse = fractalMicroNoise(worldXz * 0.05);
  float fine = fractalMicroNoise(worldXz * 0.42);
  return 0.88 + 0.22 * (coarse * 0.65 + fine * 0.35);
}

void main() {
  vec3 n = terrainNormal(vUv);

  // --- local frame at this fragment (PRD §3.3 closed form) ---
  // uv -> grid meters. PlaneGeometry puts uv.y = 1 at +position.y, and the vertex
  // shader maps scene Z = -position.y, so grid Y = -position.y. This block must stay
  // bit-for-bit consistent with frames.ts gridToLatLon / localFrame: the CPU sim,
  // duty map, ribbon and auto-planner use exactly those, and any drift here shows up
  // as a heat overlay that disagrees with the KPIs.
  float gx = (vUv.x - 0.5) * 2.0 * uAoiHalf;
  float gy = (0.5 - vUv.y) * 2.0 * uAoiHalf;  // = scene Z = -grid Y (only |gy| is a distance)
  float gridY = -gy;
  float rho = length(vec2(gx, gy));
  // Stereographic inverse, R = R_MOON in meters (NOT 2*R here: rho = 2R tan(c/2)).
  float c = 2.0 * atan(rho / (2.0 * 1737400.0));
  float lat = -1.5707963 + c;
  float lon = atan(gx, gridY);
  float cl = cos(lat), sl = sin(lat), co = cos(lon), so = sin(lon);
  vec3 up    = vec3(cl * co, cl * so, sl);
  vec3 east  = vec3(-so, co, 0.0);
  vec3 north = vec3(-sl * co, -sl * so, cl);

  // Sun/Earth ME -> local az/el (PRD §3.3): s_local = (s·e, s·n, s·up)
  float sunEl = asin(clamp(dot(uSunME, up), -1.0, 1.0));
  float sunAz = atan(dot(uSunME, east), dot(uSunME, north));
  float earthEl = asin(clamp(dot(uEarthME, up), -1.0, 1.0));
  float earthAz = atan(dot(uEarthME, east), dot(uEarthME, north));

  // ENU azimuth -> grid azimuth. The stereographic grid is conformal, so the two
  // frames differ by a pure rotation equal to the selenographic longitude here
  // (verified against PRD §3.2: at the pole +Y grid = north, +X grid = east).
  float gridSunAz = sunAz + lon;
  float gridEarthAz = earthAz + lon;

  // Horizon lookup (grid-frame azimuths; bin 0 = +Y grid):
  float hSun = radians(horizonDeg(vUv, gridSunAz));
  float hEarth = radians(horizonDeg(vUv, gridEarthAz));

  float fSunT = uHasHorizon > 0.5 ? discVisible(sunEl, hSun, uSunR) : step(0.0, sunEl);
  float fEarthT = uHasHorizon > 0.5 ? discVisible(earthEl, hEarth, uEarthR) : step(0.0, earthEl);

  float thSun = 0.1;
  float thEarth = 0.5;
  bool green = fSunT >= thSun && fEarthT >= thEarth;
  bool yellow = fSunT >= thSun && !green;
  bool commOnly = fSunT < thSun && fEarthT >= thEarth;
  bool red = fSunT < thSun && fEarthT < thEarth;

  // --- shading (PRD §7.5 + Lunar Lommel-Seeliger Photometry) ---
  float phi = sunAz + lon;
  vec3 sunScene = normalize(vec3(cos(sunEl) * sin(phi), sin(sunEl), -cos(sunEl) * cos(phi)));
  
  // Lunar Hapke / Lommel-Seeliger retroreflective scattering:
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float mu0 = max(0.0, dot(n, sunScene));
  float mu = max(0.0, dot(n, viewDir));
  float phaseAngle = acos(clamp(dot(sunScene, viewDir), -1.0, 1.0));
  float ls = (mu0 + mu > 0.0001) ? (mu0 / (mu0 + mu)) : 0.0;
  float oppositionSurge = 1.0 + 0.65 * exp(-phaseAngle / 0.18);
  float lit = fSunT * ls * oppositionSurge;

  // Earthshine: pale blue reflected earthlight in shadows
  float phiEarth = earthAz + lon;
  vec3 earthScene = normalize(vec3(cos(earthEl) * sin(phiEarth), sin(earthEl), -cos(earthEl) * cos(phiEarth)));
  float nde = max(0.0, dot(n, earthScene));
  vec3 earthshineCol = vec3(0.08, 0.16, 0.30) * (fEarthT * nde * 0.55);

  // Micro-texture powdery regolith albedo:
  vec3 albedo = vec3(0.57, 0.56, 0.54) * regolithGrain(vWorldPos.xz);

  vec3 fillDir = normalize(vec3(-0.42, 0.80, -0.42));
  float fill = max(0.0, dot(n, fillDir));
  vec3 col = albedo * (vec3(0.045) + vec3(0.28) * fill + earthshineCol + uSunColor * (lit * 2.3));

  // --- heat / spectral / hazard overlay ---
  vec3 heat = red ? vec3(1.0, 0.231, 0.302)
            : yellow ? vec3(1.0, 0.839, 0.039)
            : green ? vec3(0.133, 1.0, 0.533)
            : vec3(1.0, 0.231, 0.302); // comm-only: red + hatch
  if (commOnly) {
    // Soft diagonal hatch (a hard step aliases badly at whole-AOI zoom levels).
    float hatch = 0.5 + 0.5 * sin((vWorldPos.x + vWorldPos.z) * (6.2831853 / 520.0));
    heat *= 0.62 + 0.38 * hatch;
  }
  if (uHeatMode == 1) {
    col = mix(col, heat, uHeatOpacity);
  } else if (uHeatMode == 2) {
    // sun-fraction gradient (dark blue -> yellow)
    vec3 grad = mix(vec3(0.05, 0.07, 0.25), vec3(1.0, 0.88, 0.4), pow(fSunT, 0.6));
    col = mix(col, grad, uHeatOpacity);
  } else if (uHeatMode == 3) {
    // duty-cycle map from the worker (FR): green% mapped through a colormap
    vec2 duv = (vUv);
    vec3 d = texture2D(uDuty, duv).rgb;
    float dutyGreen = d.g; // packed green duty
    vec3 dcol = mix(vec3(0.02, 0.04, 0.15), mix(vec3(0.1, 0.55, 0.25), vec3(0.13, 1.0, 0.53), dutyGreen), pow(dutyGreen, 0.7));
    col = mix(col, dcol, uHeatOpacity);
  } else if (uHeatMode == 4) {
    // Slope hazard map (trafficability per NASA Artemis EVA & rover limits)
    float cosSlope = clamp(n.y, 0.0, 1.0);
    float slopeDeg = degrees(acos(cosSlope));
    vec3 slopeCol = slopeDeg < 10.0 ? vec3(0.13, 0.88, 0.45)
                  : slopeDeg < 15.0 ? vec3(0.95, 0.82, 0.15)
                  : slopeDeg < 20.0 ? vec3(0.98, 0.48, 0.12)
                  : vec3(0.99, 0.15, 0.22);
    col = mix(col, slopeCol, uHeatOpacity);
  } else if (uHeatMode == 5) {
    // Cartographic contour lines (50m and 250m intervals)
    float hNorm = vHeight;
    float cMinor = abs(fract(hNorm / 50.0 - 0.5) - 0.5) / max(fwidth(hNorm / 50.0), 0.001);
    float cIndex = abs(fract(hNorm / 250.0 - 0.5) - 0.5) / max(fwidth(hNorm / 250.0), 0.001);
    float lineMinor = 1.0 - clamp(cMinor, 0.0, 1.0);
    float lineIndex = 1.0 - clamp(cIndex, 0.0, 1.0);
    vec3 contourColor = mix(vec3(0.18, 0.72, 1.0), vec3(0.95, 0.82, 0.25), lineIndex);
    float contourStrength = max(lineMinor * 0.55, lineIndex * 0.95);
    col = mix(col, contourColor, contourStrength * uHeatOpacity);
  } else if (uHeatMode == 6) {
    // Permanently Shadowed Regions (PSR) & Volatile Ice Cold Traps
    bool isPsr = (fSunT < 0.01 && vHeight < -1000.0);
    if (isPsr) {
      float frost = smoothNoise(vWorldPos.xz * 0.22);
      vec3 psrCol = mix(vec3(0.08, 0.42, 0.85), vec3(0.40, 0.92, 1.0), frost * 0.45);
      col = mix(col, psrCol, 0.82 * uHeatOpacity);
    } else {
      col = mix(col, vec3(0.2, 0.22, 0.26), 0.35 * uHeatOpacity);
    }
  }

  // depth cue fog
  float dist = length(vWorldPos - cameraPosition);
  col = mix(col, vec3(0.004, 0.006, 0.012), smoothstep(34000.0, 105000.0, dist));
  gl_FragColor = vec4(col, 1.0);
}
`;
