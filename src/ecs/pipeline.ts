import type { SimContext } from './types'

export interface System {
  name: string
  update(ctx: SimContext): void
}

export interface SystemTiming {
  name: string
  ms: number
  ema: number
}

export class Pipeline {
  readonly timings: SystemTiming[]
  /** When true a `phase` event is emitted for every system every tick. */
  verbose = false
  systems: System[]

  constructor(systems: System[]) {
    this.systems = systems
    this.timings = systems.map((s) => ({ name: s.name, ms: 0, ema: 0 }))
  }

  run(ctx: SimContext): void {
    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i]
      ctx.bus.phase = system.name
      const t0 = performance.now()
      system.update(ctx)
      const ms = performance.now() - t0
      const timing = this.timings[i]
      timing.ms = ms
      timing.ema = timing.ema === 0 ? ms : timing.ema * 0.9 + ms * 0.1
      if (this.verbose) {
        ctx.bus.emit('phase', `${system.name} ${ms.toFixed(2)}ms`)
      }
    }
  }
}
