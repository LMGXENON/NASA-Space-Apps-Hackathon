/**
 * Shared physical and encoding constants (PRD Part B §3, §7; Part C §C.4 rule 4).
 * CPU and GLSL must use identical values — injected into shaders via #define.
 */

/** Moon mean radius [m] */
export const R_MOON = 1_737_400;

/** Astronomical unit [km] */
export const AU_KM = 149_597_870.7;

/** Solar constant at 1 AU [W/m²] */
export const SOLAR_CONSTANT = 1361.0;

/** Sun angular radius at 1 AU [rad] (0.53° disc → ~0.265° radius) */
export const SUN_ANG_RADIUS_1AU = Math.asin(695_700 / AU_KM);

/** Earth equatorial radius [m] */
export const R_EARTH = 6_378_137;

/** Horizon-map encoding: quantized byte b covers θ = THETA_MIN + b·THETA_STEP (deg) */
export const THETA_MIN_DEG = -10.0;
export const THETA_STEP_DEG = 0.25;

/** Default classification thresholds (PRD §7.1) */
export const THETA_SUN_MIN = 0.1; // minimum useful solar fraction
export const THETA_EARTH_MIN = 0.5; // Earth fraction needed for a comms link

/** Default horizon bake parameters */
export const DEFAULT_AZ_BINS = 64;
export const HORIZON_MAX_DISTANCE_M = 150_000;

/** Orbital / link parameters (PRD §8–9, illustrative defaults) */
export const BOLTZMANN_DB = 10 * Math.log10(1.380649e-23); // ≈ -228.6 dBW/Hz/K

/** Speed of light [m/s] */
export const C_LIGHT = 299_792_458;

/** Standard gravity [m/s²] */
export const G_MOON = 1.62; // lunar surface gravity [m/s²]
