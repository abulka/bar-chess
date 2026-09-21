/**
 * Small deterministic PRNG (mulberry32). Determinism lets the recorded event
 * stream act as a reproducible trace of the simulation.
 */
export class Rng {
  private state: number

  constructor(seed = 0x9e3779b9) {
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

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]
  }

  reset(seed = 0x9e3779b9): void {
    this.state = seed >>> 0
  }

  getState(): number {
    return this.state
  }

  setState(state: number): void {
    this.state = state >>> 0
  }
}
