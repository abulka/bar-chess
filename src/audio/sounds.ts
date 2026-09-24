import type { EventRecord } from '../ecs/events'
import { PIECE_LIST, PROJECTILES, WEAPONS } from '../game/pieces'
import { resolveSpec } from './overrides'
import type { Synth } from './synth'
import { captureVoice, explosionVoice, fireVoice, hitVoice, missVoice, type VoiceSpec } from './voices'

/**
 * Canonical sound-cue ids. Both the live `AudioEngine` and the sound config
 * panel resolve through this table, so what you audition is exactly what plays.
 *
 *   shot.<weapon>                  what a piece fires
 *   hit.<targetKind>.<weapon>      a piece taking a hit from an attacker's weapon
 *   death.<kind>                   a piece dying
 *   miss.<cause>                   a shot hitting nothing
 */

export type CueKind = 'shot' | 'hit' | 'death' | 'miss'

export const MISS_CAUSES = ['ground', 'wall', 'expired', 'target-lost'] as const

export interface SoundCue {
  id: string
  kind: CueKind
  label: string
  /** The built-in voice (no overrides). Use `cueSpec(id)` for the effective one. */
  builtin: VoiceSpec
  play(synth: Synth): void
}

export function shotId(weapon: string): string {
  return `shot.${weapon}`
}

export function hitId(targetKind: string, attackerWeapon: string): string {
  return `hit.${targetKind}.${attackerWeapon}`
}

export function deathId(kind: string): string {
  return `death.${kind}`
}

/** Capture-advance kill: a small, quiet crunch rather than a full blast. */
export function captureDeathId(kind: string): string {
  return `death.capture.${kind}`
}

export function missId(cause: string): string {
  return `miss.${cause}`
}

/** Rendered projectile shape for a weapon, used by both the panel and the synth. */
function projectileShape(weapon: string): string {
  const def = WEAPONS[weapon]
  if (!def) return 'dot'
  return PROJECTILES[def.projectile]?.shape ?? 'dot'
}

const cues = new Map<string, SoundCue>()

function add(id: string, kind: CueKind, label: string, builtin: VoiceSpec): void {
  cues.set(id, { id, kind, label, builtin, play: (synth) => synth.play(resolveSpec(id, builtin)) })
}

for (const target of PIECE_LIST) {
  add(shotId(target.weapon), 'shot', `fire ${target.weapon}`, fireVoice(target.weapon))
  add(deathId(target.key), 'death', `${target.name} dies`, explosionVoice(target.key, 1.6))
  add(
    captureDeathId(target.key),
    'death',
    `${target.name} dies (capture advance)`,
    captureVoice(target.key),
  )
  for (const attacker of PIECE_LIST) {
    const weapon = WEAPONS[attacker.weapon]
    const damage = weapon?.damage ?? 10
    add(
      hitId(target.key, attacker.weapon),
      'hit',
      `${attacker.name} hits ${target.name}`,
      hitVoice(target.key, projectileShape(attacker.weapon), damage),
    )
  }
}

for (const cause of MISS_CAUSES) {
  add(missId(cause), 'miss', `miss ${cause}`, missVoice(cause))
}

export const SOUND_CUES: ReadonlyMap<string, SoundCue> = cues

export function soundCue(id: string): SoundCue | undefined {
  return cues.get(id)
}

/** The effective spec for a cue (overrides applied), for the config UI. */
export function cueSpec(id: string): VoiceSpec | undefined {
  const cue = cues.get(id)
  return cue ? resolveSpec(cue.id, cue.builtin) : undefined
}

/**
 * Map a simulation event to a cue id, or null when it produces no sound. A `hit`
 * with no known attacker weapon returns null so the engine can fall back to its
 * shape/damage data.
 */
export function cueIdForEvent(event: EventRecord): string | null {
  const data = event.data ?? {}
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback

  switch (event.type) {
    case 'shot':
      return shotId(str(data.weapon, 'bolt'))
    case 'hit':
      return typeof data.weapon === 'string' ? hitId(str(data.kind, 'pawn'), data.weapon) : null
    case 'explosion':
      return data.capture === true ? captureDeathId(str(data.kind, 'pawn')) : deathId(str(data.kind, 'pawn'))
    case 'miss':
      return missId(str(data.cause, 'ground'))
    default:
      return null
  }
}
