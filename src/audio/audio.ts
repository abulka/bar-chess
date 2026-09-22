import type { EventRecord } from '../ecs/events'
import { cueIdForEvent, soundCue, type CueKind, type SoundCue } from './sounds'
import { Synth } from './synth'
import { hitVoice, type VoiceSpec } from './voices'

/**
 * Presentation-only audio engine. It listens to simulation events and synthesizes
 * combat sounds; it never reads or mutates the ECS world, so determinism is
 * unaffected.
 *
 * The `AudioContext` is created lazily on the first user gesture (`unlock`) to
 * satisfy browser autoplay policies, and every method is safe to call when Web
 * Audio is unavailable (SSR, tests, old browsers).
 */

/** Minimum seconds between two plays of the same cue id. */
const MIN_GAP: Record<CueKind, number> = {
  shot: 0.035,
  hit: 0.025,
  death: 0.09,
  miss: 0.06,
}

/** Any 0.3s window may start at most this many voices, to tame AI-vs-AI spam. */
const DENSITY_WINDOW = 0.3
const MAX_VOICES = 16

function getAudioContextCtor(): (typeof AudioContext) | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export interface AudioEngineOptions {
  enabled?: boolean
  volume?: number
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private synth: Synth | null = null
  private enabled: boolean
  private volume: number
  private lastPlayed = new Map<string, number>()
  private recent: number[] = []
  /** Dedicated bus for editor previews so they can be stopped cleanly. */
  private previewBus: GainNode | null = null

  constructor(options: AudioEngineOptions = {}) {
    this.enabled = options.enabled ?? false
    this.volume = clamp01(options.volume ?? 0.6)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get isReady(): boolean {
    return this.ctx !== null
  }

  /**
   * Create/resume the audio context. Must be called from a user gesture; calling
   * it without Web Audio support is a harmless no-op.
   */
  async unlock(): Promise<void> {
    if (!this.createContext()) return
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch {
        // Autoplay still blocked; a later gesture retries.
      }
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) void this.unlock()
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume)
    if (this.master) this.master.gain.value = this.volume
  }

  /** React to one simulation event. Unknown types are ignored. */
  handle(event: EventRecord): void {
    if (!this.enabled || !this.synth) return
    const cue = this.cueForEvent(event)
    if (!cue) return
    if (!this.allow(cue.id, MIN_GAP[cue.kind])) return
    cue.play(this.synth)
  }

  /**
   * Play a cue by id for the config panel. Auditioning is explicit and
   * single-shot, so it ignores the enabled gate and the density throttle, and
   * creates/resumes the context from the click that triggered it.
   */
  audition(id: string): void {
    if (!this.createContext()) return
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    const cue = soundCue(id)
    if (cue && this.synth) cue.play(this.synth)
  }

  /** Play an edited voice spec (the synth editor's live preview). */
  preview(spec: VoiceSpec): void {
    if (!this.createContext()) return
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    if (!this.ctx || !this.master || !this.synth) return
    // Replace the previous preview so loop restarts never pile up tails.
    this.stopPreview()
    const bus = this.ctx.createGain()
    bus.connect(this.master)
    this.previewBus = bus
    this.synth.play(spec, bus)
  }

  /** Stop any in-flight preview (used when the loop stops or the editor closes). */
  stopPreview(): void {
    if (this.previewBus) {
      try {
        this.previewBus.disconnect()
      } catch {
        // Already disconnected.
      }
      this.previewBus = null
    }
  }

  /** Resolve an event to a cue, falling back to raw hit data when the attacker is unknown. */
  private cueForEvent(event: EventRecord): SoundCue | null {
    const id = cueIdForEvent(event)
    if (id) return soundCue(id) ?? null
    if (event.type !== 'hit') return null

    const data = event.data ?? {}
    const kind = typeof data.kind === 'string' ? data.kind : 'pawn'
    const shape = typeof data.shape === 'string' ? data.shape : 'dot'
    const damage = typeof data.damage === 'number' ? data.damage : 10
    const builtin = hitVoice(kind, shape, damage)
    return {
      id: `hit.${kind}.shape.${shape}`,
      kind: 'hit',
      label: 'hit',
      builtin,
      play: (synth) => synth.play(builtin),
    }
  }

  dispose(): void {
    this.stopPreview()
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
    }
    this.ctx = null
    this.master = null
    this.synth = null
    this.lastPlayed.clear()
    this.recent = []
  }

  private createContext(): boolean {
    if (this.ctx) return true
    const Ctor = getAudioContextCtor()
    if (!Ctor) return false
    try {
      this.ctx = new Ctor()
    } catch {
      return false
    }
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.ctx.destination)
    this.synth = new Synth(this.ctx, this.master)
    return true
  }

  /** Voice/density gate: keeps a dense battle from turning into noise. */
  private allow(key: string, minGap: number): boolean {
    if (!this.ctx) return false
    const now = this.ctx.currentTime
    const last = this.lastPlayed.get(key)
    if (last !== undefined && now - last < minGap) return false
    this.recent = this.recent.filter((t) => now - t < DENSITY_WINDOW)
    if (this.recent.length >= MAX_VOICES) return false
    this.lastPlayed.set(key, now)
    this.recent.push(now)
    return true
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
