import { afterEach, describe, expect, it } from 'vitest'
import { AudioEngine } from '../../src/audio/audio'
import type { EventRecord } from '../../src/ecs/events'

/** Minimal Web Audio stand-ins, enough for `Synth` to build a voice graph. */
class FakeParam {
  value = 0
  setValueAtTime(): this {
    return this
  }
  exponentialRampToValueAtTime(): this {
    return this
  }
}

class FakeNode {
  connect(): this {
    return this
  }
  disconnect(): void {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam()
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine'
  frequency = new FakeParam()
  onended: (() => void) | null = null
  start(): void {}
  stop(): void {}
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass'
  Q = new FakeParam()
  frequency = new FakeParam()
}

class FakeBufferSource extends FakeNode {
  buffer: AudioBuffer | null = null
  loop = false
  onended: (() => void) | null = null
  start(): void {}
  stop(): void {}
}

let lastContext: FakeAudioContext | null = null

class FakeAudioContext {
  currentTime = 0
  sampleRate = 44100
  state: AudioContextState = 'running'
  destination = new FakeNode()
  oscillators = 0
  buffers = 0

  constructor() {
    lastContext = this
  }

  createGain(): FakeGain {
    return new FakeGain()
  }
  createOscillator(): FakeOscillator {
    this.oscillators++
    return new FakeOscillator()
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter()
  }
  createBufferSource(): FakeBufferSource {
    this.buffers++
    return new FakeBufferSource()
  }
  createBuffer(_channels: number, length: number): AudioBuffer {
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

function installAudio(): void {
  ;(globalThis as unknown as { window: unknown }).window = { AudioContext: FakeAudioContext }
}

function event(type: EventRecord['type'], data?: Record<string, unknown>): EventRecord {
  return { seq: 1, tick: 0, phase: 'tick', type, msg: type, data }
}

function voiceCount(): number {
  return (lastContext?.oscillators ?? 0) + (lastContext?.buffers ?? 0)
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  lastContext = null
})

describe('AudioEngine', () => {
  it('stays silent and creates no context until enabled', () => {
    installAudio()
    const engine = new AudioEngine()
    engine.handle(event('shot', { weapon: 'rookShell' }))
    expect(engine.isReady).toBe(false)
    expect(voiceCount()).toBe(0)
  })

  it('unlocks on enable and plays a voice per weapon', () => {
    installAudio()
    const engine = new AudioEngine()
    engine.setEnabled(true)
    expect(engine.isReady).toBe(true)

    const before = voiceCount()
    engine.handle(event('shot', { weapon: 'bishopLance' }))
    expect(voiceCount()).toBeGreaterThan(before)
  })

  it('plays hit, explosion and miss voices', () => {
    installAudio()
    const engine = new AudioEngine({ enabled: true })
    void engine.unlock()

    const before = voiceCount()
    engine.handle(event('hit', { kind: 'rook', shape: 'shell', damage: 20 }))
    engine.handle(event('explosion', { kind: 'king', radius: 1.6 }))
    engine.handle(event('miss', { cause: 'wall' }))
    expect(voiceCount()).toBeGreaterThanOrEqual(before + 3)
  })

  it('throttles rapid repeats of the same sound', () => {
    installAudio()
    const engine = new AudioEngine({ enabled: true })
    void engine.unlock()

    engine.handle(event('shot', { weapon: 'pawnShot' }))
    const afterFirst = voiceCount()
    engine.handle(event('shot', { weapon: 'pawnShot' }))
    expect(voiceCount()).toBe(afterFirst)
  })

  it('goes silent again when disabled', () => {
    installAudio()
    const engine = new AudioEngine({ enabled: true })
    void engine.unlock()
    engine.setEnabled(false)
    const before = voiceCount()
    engine.handle(event('shot', { weapon: 'rookShell' }))
    expect(voiceCount()).toBe(before)
  })

  it('auditions a cue even while disabled', () => {
    installAudio()
    const engine = new AudioEngine()
    expect(engine.isReady).toBe(false)
    engine.audition('death.king')
    expect(engine.isReady).toBe(true)
    expect(voiceCount()).toBeGreaterThan(0)
  })

  it('ignores an unknown audition id without throwing', () => {
    installAudio()
    const engine = new AudioEngine()
    expect(() => engine.audition('nope.nothing')).not.toThrow()
  })

  it('uses a weapon-specific hit cue when the attacker is known', () => {
    installAudio()
    const engine = new AudioEngine({ enabled: true })
    void engine.unlock()
    const before = voiceCount()
    engine.handle(event('hit', { kind: 'rook', weapon: 'rookShell', shape: 'shell', damage: 20 }))
    expect(voiceCount()).toBeGreaterThan(before)
  })

  it('previews an edited voice spec', () => {
    installAudio()
    const engine = new AudioEngine()
    engine.preview([{ type: 'sine', from: 440, duration: 0.1, gain: 0.2 }])
    expect(engine.isReady).toBe(true)
    expect(voiceCount()).toBeGreaterThan(0)
  })

  it('is a safe no-op without Web Audio', () => {
    const engine = new AudioEngine({ enabled: true })
    expect(() => engine.handle(event('shot', { weapon: 'rookShell' }))).not.toThrow()
    expect(engine.isReady).toBe(false)
  })
})
