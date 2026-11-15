"use client";

/**
 * InterstellarGalaxy — Photorealistic deep-space celestial dome & Milky Way galaxy.
 *
 * Provides a physically grounded, high-contrast astronomical space environment
 * for the lunar surface:
 * 1. Milky Way galactic plane with organic dust lanes (Great Rift absorption)
 *    and galactic core bulge (Sagittarius A* direction).
 * 2. Multi-spectral starfield (12,000+ stars) mapped to real Harvard spectral classes
 *    (O/B blue giants, A/F white stars, G solar yellow, K/M red giants).
 * 3. Deep-space emission nebulae (H-alpha crimson & OIII cyan interstellar clouds).
 * 4. Infinite optical parallax: locked to camera position every frame so celestial bodies
 *    never shift distance during camera moves or rover traverse.
 */

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

const SKY_RADIUS = 4_800_000;
const STAR_COUNT = 14_000;

// Galactic plane orientation: tilted ~60.2° relative to lunar/ecliptic plane
const GALACTIC_ROTATION = new THREE.Euler(
  THREE.MathUtils.degToRad(60.2),
  THREE.MathUtils.degToRad(28.5),
  THREE.MathUtils.degToRad(12.3),
  "XYZ",
);

// Procedural GLSL shader for the continuous Milky Way galactic backdrop & nebulae
const GalacticShader = {
  uniforms: {
    uTime: { value: 0 },
    uBrightness: { value: 1.0 },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vWorldPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vWorldPosition;
    uniform float uBrightness;

    // Pseudo-random & simplex-style 3D hash
    vec3 hash3(vec3 p) {
      p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
               dot(p, vec3(269.5, 183.3, 246.1)),
               dot(p, vec3(113.5, 271.9, 124.6)));
      return fract(sin(p) * 43758.5453123);
    }

    // 3D Value Noise
    float noise3D(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      vec3 u = f * f * (3.0 - 2.0 * f);

      float n000 = dot(hash3(i + vec3(0,0,0)) - 0.5, f - vec3(0,0,0));
      float n100 = dot(hash3(i + vec3(1,0,0)) - 0.5, f - vec3(1,0,0));
      float n010 = dot(hash3(i + vec3(0,1,0)) - 0.5, f - vec3(0,1,0));
      float n110 = dot(hash3(i + vec3(1,1,0)) - 0.5, f - vec3(1,1,0));
      float n001 = dot(hash3(i + vec3(0,0,1)) - 0.5, f - vec3(0,0,1));
      float n101 = dot(hash3(i + vec3(1,0,1)) - 0.5, f - vec3(1,0,1));
      float n011 = dot(hash3(i + vec3(0,1,1)) - 0.5, f - vec3(0,1,1));
      float n111 = dot(hash3(i + vec3(1,1,1)) - 0.5, f - vec3(1,1,1));

      return 0.5 + 0.8 * mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z
      );
    }

    // Fractional Brownian Motion (fBm) for organic cosmic dust & gas
    float fbm(vec3 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * noise3D(p);
        p *= 2.15;
        a *= 0.48;
      }
      return v;
    }

    void main() {
      vec3 dir = normalize(vWorldPosition);

      // Distance from galactic equator (dir.y in rotated frame)
      float lat = dir.y;
      float absLat = abs(lat);

      // 1. Galactic Disk Luminosity: concentrated near galactic equator (lat = 0)
      float diskWidth = 0.075;
      float disk = exp(- (absLat * absLat) / (2.0 * diskWidth * diskWidth));

      // 2. Galactic Core Bulge: centered near dir.z > 0.6
      float coreDist = length(dir - vec3(0.0, 0.0, 1.0));
      float core = exp(- (coreDist * coreDist) / 0.05) * 1.5;

      // 3. Interstellar Dust Lanes: Great Rift molecular absorption clouds
      vec3 dustCoords = dir * 22.0;
      float dustNoise = fbm(dustCoords);
      float dustRift = smoothstep(0.40, 0.72, dustNoise) * exp(- (absLat * absLat) / 0.015);
      float visibility = clamp(1.0 - dustRift * 0.90, 0.06, 1.0);

      // 4. Fine turbulent star clusters along the arms
      float armClusters = fbm(dir * 36.0);
      float starlight = (disk * 0.70 + core * 1.30) * (0.55 + 0.55 * armClusters) * visibility;

      // 5. Interstellar Emission Nebulae (H-alpha & OIII ionized gas)
      float nebNoise1 = fbm(dir * 8.0 + vec3(1.2, -3.4, 0.8));
      float nebNoise2 = fbm(dir * 12.0 + vec3(-2.1, 4.2, 1.5));
      float hAlpha = smoothstep(0.58, 0.84, nebNoise1) * disk * 0.70;
      float oIII = smoothstep(0.62, 0.88, nebNoise2) * disk * 0.40;

      // Color Palette: Deep Space, Golden Core, Violet/Magenta H-Alpha, Cyan OIII
      vec3 deepSpace = vec3(0.002, 0.003, 0.005);
      vec3 coreColor = vec3(1.0, 0.88, 0.68);
      vec3 diskColor = vec3(0.72, 0.82, 1.0);
      vec3 hAlphaColor = vec3(0.85, 0.18, 0.42);
      vec3 oIIIColor = vec3(0.12, 0.58, 0.75);

      vec3 finalColor = deepSpace;
      finalColor += mix(diskColor, coreColor, clamp(core * 0.6, 0.0, 1.0)) * starlight * 0.38;
      finalColor += hAlphaColor * hAlpha * 0.16;
      finalColor += oIIIColor * oIII * 0.12;

      gl_FragColor = vec4(finalColor * uBrightness, 1.0);
    }
  `,
};

// Generates procedural star Airy disc PSF texture
function createStarTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const s = 32;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;

  const cx = s / 2;
  const cy = s / 2;

  // Pure optical Airy disc profile (Gaussian falloff) for vacuum space observation
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s / 2);
  g.addColorStop(0, "rgba(255, 255, 255, 1.0)");
  g.addColorStop(0.28, "rgba(255, 255, 255, 0.95)");
  g.addColorStop(0.60, "rgba(230, 240, 255, 0.40)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

// Shader for multi-magnitude point stars with exact screen-pixel sizing
const StarPointsShader = {
  vertexShader: `
    attribute float size;
    attribute vec3 color;
    varying vec3 vColor;
    void main() {
      vColor = color;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform sampler2D pointTexture;
    varying vec3 vColor;
    void main() {
      vec4 tex = texture2D(pointTexture, gl_PointCoord);
      if (tex.a < 0.04) discard;
      gl_FragColor = vec4(vColor * tex.rgb, tex.a);
    }
  `,
};

export default function InterstellarGalaxy() {
  const galaxyGroup = useRef<THREE.Group>(null);
  const shaderMatRef = useRef<THREE.ShaderMaterial>(null);

  // Star texture for point-sprites
  const starTexture = useMemo(() => createStarTexture(), []);
  const starUniforms = useMemo(
    () => ({ pointTexture: { value: starTexture } }),
    [starTexture],
  );

  // Multi-spectral starfield points geometry
  const starfieldGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);

    // Harvard Spectral Classification Colors
    const SPECTRAL_PALETTES = [
      new THREE.Color("#9bb0ff"), // O / B Class: Hot Blue-White
      new THREE.Color("#cad7ff"), // A Class: Pure White
      new THREE.Color("#f8f9ff"), // F Class: White-Yellow
      new THREE.Color("#fff4e8"), // G Class: Solar Yellow
      new THREE.Color("#ffd2a1"), // K Class: Warm Amber
      new THREE.Color("#ffaa66"), // M Class: Red Giant
    ];

    const tempColor = new THREE.Color();

    for (let i = 0; i < STAR_COUNT; i++) {
      // Fibonacci sphere distribution for uniform base coverage
      const y = 1 - (i / (STAR_COUNT - 1)) * 2;
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = 2.399963229728653 * i; // Golden angle

      let x = Math.cos(theta) * radiusAtY;
      let z = Math.sin(theta) * radiusAtY;

      // Concentrate a portion of stars directly along the Milky Way band
      if (Math.random() < 0.55) {
        // Narrow latitude towards the galactic equator
        const bandLat = (Math.random() - 0.5) * 0.28;
        const rBand = Math.sqrt(1 - bandLat * bandLat);
        const lon = Math.random() * Math.PI * 2;
        x = Math.cos(lon) * rBand;
        z = Math.sin(lon) * rBand;
      }

      // Position at astronomical infinity
      const pIdx = i * 3;
      positions[pIdx] = x * SKY_RADIUS;
      positions[pIdx + 1] = y * SKY_RADIUS;
      positions[pIdx + 2] = z * SKY_RADIUS;

      // Assign realistic stellar spectral color
      const p = Math.random();
      let specColor: THREE.Color;
      if (p < 0.15) specColor = SPECTRAL_PALETTES[0]!; // O/B
      else if (p < 0.40) specColor = SPECTRAL_PALETTES[1]!; // A
      else if (p < 0.65) specColor = SPECTRAL_PALETTES[2]!; // F
      else if (p < 0.85) specColor = SPECTRAL_PALETTES[3]!; // G
      else if (p < 0.95) specColor = SPECTRAL_PALETTES[4]!; // K
      else specColor = SPECTRAL_PALETTES[5]!; // M

      // Slight intensity variance
      const intensity = 0.7 + Math.random() * 0.6;
      tempColor.copy(specColor).multiplyScalar(intensity);
      colors[pIdx] = tempColor.r;
      colors[pIdx + 1] = tempColor.g;
      colors[pIdx + 2] = tempColor.b;

      // Apparent magnitude distribution: power law (many faint stars, few bright jewels)
      // Realistic astronomical angular diameter: 1.4px to 3.5px on screen
      const magPower = Math.pow(Math.random(), 5);
      sizes[i] = 1.4 + magPower * 2.1;
    }

    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    return geo;
  }, []);

  // Update position to track camera at infinity (zero parallax error)
  useFrame(({ camera }) => {
    if (galaxyGroup.current) {
      galaxyGroup.current.position.copy(camera.position);
    }
  });

  return (
    <group ref={galaxyGroup} rotation={GALACTIC_ROTATION}>
      {/* Continuous Milky Way Galactic Haze & Dust Sphere */}
      <mesh>
        <sphereGeometry args={[SKY_RADIUS * 0.99, 64, 48]} />
        <shaderMaterial
          ref={shaderMatRef}
          vertexShader={GalacticShader.vertexShader}
          fragmentShader={GalacticShader.fragmentShader}
          uniforms={GalacticShader.uniforms}
          side={THREE.BackSide}
          depthWrite={false}
          transparent={false}
        />
      </mesh>

      {/* Optical Pinprick Multi-Spectral Starfield Points */}
      <points geometry={starfieldGeo}>
        <shaderMaterial
          vertexShader={StarPointsShader.vertexShader}
          fragmentShader={StarPointsShader.fragmentShader}
          uniforms={starUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
