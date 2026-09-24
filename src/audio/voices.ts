/**
 * Voice specs: pure, serializable descriptions of the sounds the synth plays.
 * Keeping them as data (rather than code inside the synth) lets the config panel
 * show, edit, copy and paste each cue's exact parameters. No Web Audio here.
 *
 * A `VoiceSpec` is an ordered list of one-shot events. An event is a tone when it
 * has a `from` (oscillator frequency); otherwise it is filtered noise.
 */

export interface FilterOptions {
  type?: BiquadFilterType
  from: number
  to?: number
  q?: number
}

export interface ToneOptions {
  type: OscillatorType
  from: number
  to?: number
  duration: number
  gain: number
  /** seconds to reach full gain; kept tiny to avoid clicks */
  attack?: number
  delay?: number
  filter?: FilterOptions
}

export interface NoiseOptions {
  duration: number
  gain: number
  attack?: number
  delay?: number
  filter: FilterOptions
}

export type VoiceEvent = ToneOptions | NoiseOptions
export type VoiceSpec = VoiceEvent[]

export function isTone(event: VoiceEvent): event is ToneOptions {
  return 'from' in event
}

/**
 * Committed per-cue parameter overrides, keyed by sound id.
 *
 * Edit these through the in-app synth editor (HUD `h` → **Sound** tab → `∿`),
 * then use **Copy all** (whole block) or **Copy entry** (one line) to paste here.
 * Values are always an **array** of tone/noise events and keys are **quoted cue
 * ids** — pasting a bare array is invalid. See ARCHITECTURE.md §11,
 * "Voice override workflow".
 *
 * Shape:
 *   export const VOICE_OVERRIDES: Record<string, VoiceSpec> = {
 *     "shot.bishopLance": [
 *       { type: "sawtooth", from: 1900, to: 280, duration: 0.18, gain: 0.12 },
 *     ],
 *     "hit.pawn.rookShell": [ … ],
 *   }
 *
 * A runtime layer (`overrides.ts`, persisted in localStorage) takes precedence
 * over these, so editor edits are audible before you commit them here.
 */
export const VOICE_OVERRIDES: Record<string, VoiceSpec> = {}

/** Per-piece-type base pitch (Hz); heavier pieces sound lower. */
const KIND_FREQ: Record<string, number> = {
  pawn: 760,
  knight: 320,
  bishop: 520,
  rook: 240,
  queen: 200,
  king: 140,
}

/** Weapon report, keyed by `WeaponDef.key`. */
export function fireVoice(weapon: string): VoiceSpec {
  switch (weapon) {
    case 'pawnShot':
      return [{ type: 'triangle', from: 900, to: 480, duration: 0.09, gain: 0.16 }]
    case 'knightBomb':
      return [
        { type: 'sine', from: 190, to: 60, duration: 0.26, gain: 0.3 },
        { duration: 0.2, gain: 0.14, filter: { from: 700, to: 180 } },
      ]
    case 'bishopLance':
      return [
        {
          type: 'sawtooth',
          from: 1900,
          to: 280,
          duration: 0.18,
          gain: 0.12,
          filter: { type: 'highpass', from: 600, to: 300, q: 0.8 },
        },
      ]
    case 'rookShell':
      return [
        { type: 'sine', from: 150, to: 42, duration: 0.36, gain: 0.36 },
        { duration: 0.3, gain: 0.2, filter: { from: 900, to: 140 } },
      ]
    case 'queenNova':
      return [
        {
          type: 'sawtooth',
          from: 720,
          to: 110,
          duration: 0.4,
          gain: 0.2,
          filter: { type: 'lowpass', from: 2400, to: 500 },
        },
        { type: 'sine', from: 360, to: 70, duration: 0.4, gain: 0.18, delay: 0.01 },
      ]
    case 'kingGuard':
      return [{ type: 'square', from: 1250, to: 700, duration: 0.07, gain: 0.16 }]
    default:
      return [{ type: 'triangle', from: 880, to: 520, duration: 0.09, gain: 0.15 }]
  }
}

/** Impact on a piece, scaled by target type, projectile shape and damage. */
export function hitVoice(kind: string, shape: string, damage: number): VoiceSpec {
  const base = KIND_FREQ[kind] ?? 500
  const weight = Math.min(1, damage / 24)
  const gain = 0.1 + weight * 0.16
  const duration = 0.07 + weight * 0.08

  if (shape === 'bomb' || shape === 'shell') {
    return [
      { duration: duration + 0.05, gain, filter: { from: 1200, to: 220 } },
      { type: 'sine', from: base, to: base * 0.4, duration, gain: gain * 0.8 },
    ]
  }
  return [
    { type: 'square', from: base * 1.4, to: base * 0.6, duration, gain },
    { duration: 0.05, gain: gain * 0.7, filter: { type: 'highpass', from: 1400 } },
  ]
}

/** Destruction blast; heavier pieces get a longer, lower roar. */
export function explosionVoice(kind: string, radiusTiles: number): VoiceSpec {
  const base = KIND_FREQ[kind] ?? 220
  const scale = Math.max(0.4, Math.min(1.4, radiusTiles / 1.6))
  const duration = 0.4 + scale * 0.5
  return [
    { duration, gain: 0.28 * scale, filter: { from: 1600, to: 90 } },
    { type: 'sine', from: base, to: base * 0.25, duration: duration * 0.8, gain: 0.26 * scale },
  ]
}

/** Capture-advance crunch: two quick, quiet low thumps under the sliding piece. */
export function captureVoice(kind: string): VoiceSpec {
  const base = KIND_FREQ[kind] ?? 500
  return [
    { type: 'sine', from: base * 0.9, to: base * 0.3, duration: 0.1, gain: 0.12 },
    { duration: 0.07, gain: 0.07, filter: { from: 800, to: 160 } },
    { type: 'sine', from: base * 0.7, to: base * 0.25, duration: 0.12, gain: 0.09, delay: 0.11 },
    { duration: 0.06, gain: 0.05, filter: { from: 600, to: 140 }, delay: 0.11 },
  ]
}

/** A shot that hit nothing: fizzle on the ground, clack on a wall, airy fade. */
export function missVoice(cause: string): VoiceSpec {
  switch (cause) {
    case 'wall':
      return [{ duration: 0.05, gain: 0.14, filter: { type: 'highpass', from: 1800 } }]
    case 'expired':
      return [{ duration: 0.12, gain: 0.05, filter: { from: 900, to: 300 } }]
    case 'target-lost':
      return [{ type: 'triangle', from: 420, to: 180, duration: 0.1, gain: 0.08 }]
    default:
      return [
        { type: 'sine', from: 180, to: 90, duration: 0.09, gain: 0.1 },
        { duration: 0.07, gain: 0.06, filter: { from: 700, to: 250 } },
      ]
  }
}
