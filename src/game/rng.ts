/** Default battle seed, kept stable so existing replays/tests are unchanged. */
export const DEFAULT_SEED = 0x9e3779b9

/**
 * Small deterministic PRNG (mulberry32). Determinism lets the recorded event
 * stream act as a reproducible trace of the simulation.
 */
export class Rng {
  private state: number

  constructor(seed = DEFAULT_SEED) {
    this.state = seed >>> 0
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1))
  }

  reset(seed = DEFAULT_SEED): void {
    this.state = seed >>> 0
  }

  getState(): number {
    // `next()` accumulates without truncating; canonicalize to the 32-bit word
    // `setState` restores, so a saved/restored stream is byte-identical.
    return this.state >>> 0
  }

  setState(state: number): void {
    this.state = state >>> 0
  }
}
