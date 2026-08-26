/**
 * Deterministic counter-based RNG (spec 06 §9).
 *
 * Each randomness stream is an independent counter sequence seeded from the run
 * manifest's master seed. Every draw records (stream, counter, population,
 * params, sampled, result) so resume does NOT re-sample. This module provides
 * the pure PRNG; the receipt-logging lives in the controller.
 *
 * Algorithm: splitmix64 seeded by (masterSeed, streamName) → a 64-bit stream
 * seed; each draw advances a per-stream counter and mixes it. Deterministic
 * across hosts (no BigInt endianness issues — we use BigInt arithmetic over
 * uint64). Beta sampling uses exact Gamma variates (Marsaglia–Tsang) so the
 * same (alpha, beta, counter) always yields the same draw.
 */

/** A named counter stream. */
export class RngStream {
  private counter = 0n
  private readonly streamSeed: bigint

  constructor(
    masterSeed: bigint,
    private readonly streamName: string,
  ) {
    // Mix the master seed with the stream name to derive an independent seed.
    const nameHash = hashString(streamName)
    this.streamSeed = splitmix64(masterSeed ^ nameHash)
  }

  /** Advance and return the next uint64 (as a bigint, 0 .. 2^64-1). */
  nextU64(): bigint {
    this.counter += 1n
    return splitmix64(this.streamSeed ^ (this.counter * GOLDEN_GAMMA))
  }

  /** Uniform double in [0, 1). */
  nextDouble(): number {
    // Use the top 53 bits for a full-precision double.
    const u = this.nextU64() >> 11n
    return Number(u) / Number(1n << 53n)
  }

  /** The current counter value (for receipt logging / resume). */
  currentCounter(): number {
    return Number(this.counter)
  }
}

/** 64-bit golden gamma for Weyl-sequence mixing (from splitmix64). */
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n

/** splitmix64 mixing function (deterministic, no endianness dependence). */
function splitmix64(z: bigint): bigint {
  const MASK = (1n << 64n) - 1n
  z = (z + GOLDEN_GAMMA) & MASK
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK
  return (z ^ (z >> 31n)) & MASK
}

/** FNV-1a style hash of a string into a uint64 seed. */
function hashString(s: string): bigint {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i) & 0xff)) * 0x100000001b3n
    h = h & ((1n << 64n) - 1n)
  }
  return h
}

/**
 * Sample from Beta(alpha, beta) using exact Gamma variates.
 *
 * Marsaglia–Tsang (2000) generates Gamma(shape) with shape >= 1 via one
 * standard-normal transform plus a bounded rejection loop, and shape < 1 via
 * the boost Gamma(shape+1) * U^(1/shape) transformation. The Beta draw is
 * Gamma(alpha) / (Gamma(alpha) + Gamma(beta)), which is exact for all positive
 * finite parameters and produces no boundary clipping artifacts. Given the
 * same stream state and parameters the rejection loop is deterministic, so
 * resume replay reproduces every draw.
 */
export function sampleBeta(rng: RngStream, alpha: number, beta: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || !Number.isFinite(beta) || beta <= 0) {
    throw new Error(`sampleBeta: parameters must be finite and positive (${alpha}, ${beta})`)
  }
  const x = sampleGamma(rng, alpha)
  const y = sampleGamma(rng, beta)
  return x / (x + y)
}

/** Deterministic Gamma(shape, 1) sampler (Marsaglia–Tsang). */
function sampleGamma(rng: RngStream, shape: number): number {
  if (shape >= 1) {
    const d = shape - 1 / 3
    const c = 1 / Math.sqrt(9 * d)
    for (;;) {
      const z = invNormalCdf(clamp(rng.nextDouble(), 1e-12, 1 - 1e-12))
      const v = (1 + c * z) ** 3
      if (v <= 0) continue
      const u = clamp(rng.nextDouble(), 1e-12, 1 - 1e-12)
      if (u < 1 - 0.0331 * z ** 4) return d * v
      if (Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v
    }
  }
  // shape < 1: boost a Gamma(shape + 1) draw with U^(1/shape).
  const boosted = sampleGamma(rng, shape + 1)
  const u = clamp(rng.nextDouble(), 1e-12, 1 - 1e-12)
  return boosted * u ** (1 / shape)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

/** Beasley-Springer-Moro inverse standard-normal CDF approximation. */
function invNormalCdf(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  let q: number
  let r: number
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= phigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}
