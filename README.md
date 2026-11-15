# L-SPOC · Lunar South Pole Operations Console

[![NASA Space Apps Challenge 2026](https://img.shields.io/badge/NASA%20Space%20Apps-2026-0B3D91?style=flat-square&logo=nasa)](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
[![Challenge](https://img.shields.io/badge/Challenge-Lunar%20Landing%20Site%20Navigator-blue?style=flat-square)](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
[![Tests](https://img.shields.io/badge/Tests-83%2F83%20Passing-22c55e?style=flat-square)](packages/core/tests)
[![License: MIT](https://img.shields.io/badge/License-MIT-gray?style=flat-square)](LICENSE)

An intuitive, browser-based mission console to rapidly evaluate candidate landing sites, power availability, and direct-to-Earth communication windows across the Moon's South Pole.

Built with real NASA elevation models and JPL Horizons ephemeris.

---

## Overview

Missions to the lunar south pole face razor-sharp shadows, extreme temperature shifts, and communication blackouts. When launch dates or hardware schedules shift, mission planners need to evaluate alternative landing sites and dates instantly.

**L-SPOC** delivers:
- **Side-by-Side Landing Site Matrix**: Compare 8 candidate landing sites across Artemis III, CLPS IM-2, and VIPER for 14-day solar illumination %, direct-to-Earth line of sight, and slope trafficability.
- **Horizon-Aware Sun & Earth Tracking**: Pre-computed 64-azimuth horizon elevation masks calculate real shadow occlusions across 150 km of terrain in under 0.25 ms.
- **Polar Threat Countdown**: Forward-looking counters calculating exact hours to sunset, Earth communication loss, and cryogenic freeze limits.
- **Autonomous Surface Traverses**: Least-cost pathfinder routing rovers along sunlit ridge corridors while strictly avoiding steep crater slopes (>20°).
- **Interactive 3D Selenographic Console**: 60 FPS Three.js viewport featuring Lommel-Seeliger regolith scattering, first-person MastCam viewfinder, and topocentric sky charts.

---

## NASA Data & Scientific Sources

| Dataset / Source | Instrument / Agency | Purpose in L-SPOC |
| :--- | :--- | :--- |
| **LOLA DEM (20m)** | Lunar Reconnaissance Orbiter (LRO) / NASA | 20 m/px polar digital elevation model (`LDEM_875S_20M`) |
| **JPL Horizons DE440** | NASA JPL Solar System Dynamics | Sub-arcsecond Sun and Earth topocentric vectors (2026–2028) |
| **LROC WAC Albedo** | LROC Science Operations Center | Lunar surface reflectance and true albedo texturing |
| **NASA DONKI** | NASA Space Weather Database of Notifications | Live solar flare telemetry and space radiation monitoring |
| **Artemis & CLPS Specs** | NASA Exploration Systems / CLPS | Candidate site coordinates and rover power profiles |

---

## Quickstart

### Prerequisites
- Node.js >= 20
- pnpm >= 9

### Setup & Run
```bash
git clone https://github.com/LMGXENON/NASA-Space-Apps-Hackathon.git
cd NASA-Space-Apps-Hackathon

# Install dependencies
pnpm install

# Start local console
pnpm dev
```
Open **[http://localhost:3210](http://localhost:3210)** in your browser.

### Run Automated Tests
```bash
pnpm test
```
Runs all 83 unit tests verifying ephemeris vectors, coordinate frames, power models, and horizon marchers.

---

## Repository Structure

```
├── apps/
│   └── web/                   # Next.js 15 + Three.js mission operations web app
│       ├── app/               # Page shell and API endpoints
│       ├── components/        # Mission controls, threat monitor, charts, HUD
│       ├── hooks/             # Ephemeris, autonomy, and space weather hooks
│       ├── three/             # Terrain shaders, celestial bodies, camera rig
│       └── public/data/       # LOLA elevation rasters and horizon tensors
├── packages/
│   └── core/                  # Zero-dependency scientific TypeScript library
│       ├── src/               # Ephemeris, lunar frames, pathfinder, power
│       └── tests/             # Vitest test suite (83 unit tests)
├── tools/                     # Python data prep pipelines (LOLA & Horizons)
└── docs/                      # Challenge submission documentation & pitch deck
```

---

## License

MIT
