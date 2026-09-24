import { isTone, type FilterOptions, type NoiseOptions, type ToneOptions, type VoiceSpec } from './voices'

/**
 * Plays `VoiceSpec`s through Web Audio. Every voice is built from oscillators,
 * filtered noise and gain envelopes at play time, so the game stays
 * dependency-free and works offline. No audio assets.
 *
 * This module never touches the simulation — it only renders specs to sound.
 */

/** Small deterministic PRNG so noise is reproducible without `Math.random`. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.5)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  const rand = prng(0x9e3779b9)
  for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1
  return buffer
}

const MIN_GAIN = 0.0001

export class Synth {
  private readonly ctx: AudioContext
  private readonly out: AudioNode
  private readonly noiseBuffer: AudioBuffer

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx
    this.out = out
    this.noiseBuffer = createNoiseBuffer(ctx)
  }

  /** Play every event of a spec, scheduled from `currentTime`. */
  play(spec: VoiceSpec, destination: AudioNode = this.out): void {
    for (const event of spec) {
      if (isTone(event)) this.tone(event, destination)
      else this.noise(event, destination)
    }
  }

  /** Build a biquad filter from a voice's filter spec, ramping to `to` if set. */
  private filter(spec: FilterOptions, defaultQ: number, t0: number, duration: number): BiquadFilterNode {
    const filter = this.ctx.createBiquadFilter()
    filter.type = spec.type ?? 'lowpass'
    filter.Q.value = spec.q ?? defaultQ
    filter.frequency.setValueAtTime(Math.max(1, spec.from), t0)
    if (spec.to !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + duration)
    }
    return filter
  }

  private tone(o: ToneOptions, out: AudioNode): void {
    const ctx = this.ctx
    const stopAt = (o.delay ?? 0) + o.duration
    const t0 = ctx.currentTime + (o.delay ?? 0)
    const osc = ctx.createOscillator()
    osc.type = o.type
    osc.frequency.setValueAtTime(Math.max(1, o.from), t0)
    if (o.to !== undefined && o.to !== o.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.duration)
    }

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(MIN_GAIN, t0)
    gain.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, o.gain), t0 + (o.attack ?? 0.004))
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + o.duration)

    if (o.filter) {
      const filter = this.filter(o.filter, 1, t0, o.duration)
      osc.connect(filter)
      filter.connect(gain)
    } else {
      osc.connect(gain)
    }

    gain.connect(out)
    osc.start(t0)
    osc.stop(t0 + stopAt + 0.02)
    osc.onended = () => {
      try {
        gain.disconnect()
      } catch {
        // Node already torn down.
      }
    }
  }

  private noise(o: NoiseOptions, out: AudioNode): void {
    const ctx = this.ctx
    const t0 = ctx.currentTime + (o.delay ?? 0)
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.loop = true

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(MIN_GAIN, t0)
    gain.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, o.gain), t0 + (o.attack ?? 0.006))
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + o.duration)

    const filter = this.filter(o.filter, 0.7, t0, o.duration)

    src.connect(filter)
    filter.connect(gain)
    gain.connect(out)
    src.start(t0)
    src.stop(t0 + o.duration + 0.02)
    src.onended = () => {
      try {
        gain.disconnect()
      } catch {
        // Node already torn down.
      }
    }
  }
}
