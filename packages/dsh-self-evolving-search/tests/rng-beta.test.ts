/**
 * Beta sampler contract (issue #76).
 *
 * `sampleBeta` must draw from the actual Beta distribution: Beta(1,1) is
 * uniform on [0,1] with no atoms; skewed posteriors concentrate correctly;
 * draws are deterministic per (stream, counter) and parameters are validated.
 */
import { describe, expect, it } from 'vitest'
import { RngStream, sampleBeta } from '../src/rng.js'

function draws(alpha: number, beta: number, count: number): number[] {
  const rng = new RngStream(0x12345678n, 'beta-contract')
  return Array.from({ length: count }, () => sampleBeta(rng, alpha, beta))
}

describe('sampleBeta exact distribution', () => {
  it('Beta(1,1) is uniform on (0,1) with no boundary atoms', () => {
    const samples = draws(1, 1, 20_000)
    for (const value of samples) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThan(1)
    }
    // No clamped point masses: every value unique under continuous sampling.
    expect(new Set(samples).size).toBe(samples.length)
    // Mean of U(0,1) is 0.5 with standard error ~0.0036 at 20k draws.
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.02)
    // Decile occupancy must be roughly equal (uniform): each ~10% ± 1.5%.
    for (let decile = 0; decile < 10; decile += 1) {
      const occupied = samples.filter(
        (value) => value >= decile / 10 && value < (decile + 1) / 10,
      ).length
      expect(Math.abs(occupied / samples.length - 0.1)).toBeLessThan(0.015)
    }
  })

  it('skewed posteriors concentrate near their Beta means', () => {
    // Beta(1, 100): mean 1/101 ≈ 0.0099, nearly all mass below 0.05.
    const low = draws(1, 100, 10_000)
    expect(low.filter((value) => value < 0.05).length / low.length).toBeGreaterThan(0.97)
    const lowMean = low.reduce((sum, value) => sum + value, 0) / low.length
    expect(Math.abs(lowMean - 1 / 101)).toBeLessThan(0.003)

    // Beta(100, 1): mean 100/101 ≈ 0.990, nearly all mass above 0.95.
    const high = draws(100, 1, 10_000)
    expect(high.filter((value) => value > 0.95).length / high.length).toBeGreaterThan(0.97)
    const highMean = high.reduce((sum, value) => sum + value, 0) / high.length
    expect(Math.abs(highMean - 100 / 101)).toBeLessThan(0.003)

    // Beta(5, 5): mean 0.5, and far fewer extreme draws than Beta(1,1).
    const centered = draws(5, 5, 10_000)
    expect(
      centered.filter((value) => value < 0.1 || value > 0.9).length / centered.length,
    ).toBeLessThan(0.01)
  })

  it('rejects invalid parameters', () => {
    const rng = new RngStream(1n, 'beta-contract')
    for (const [alpha, beta] of [
      [0, 1],
      [1, 0],
      [-1, 2],
      [Number.NaN, 1],
      [1, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => sampleBeta(rng, alpha, beta)).toThrow(/finite and positive/)
    }
  })

  it('is deterministic for the same stream state and parameters', () => {
    const first = new RngStream(0xc0ffee12345678n, 'determinism')
    const second = new RngStream(0xc0ffee12345678n, 'determinism')
    for (let index = 0; index < 200; index += 1) {
      expect(sampleBeta(first, 2.5, 3.5)).toBe(sampleBeta(second, 2.5, 3.5))
    }
  })
})
