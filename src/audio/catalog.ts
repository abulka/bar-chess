import type { Geometry } from '../game/types'
import { PIECE_LIST, PROJECTILES, WEAPONS, weaponVision } from '../game/pieces'
import { deathId, hitId, shotId } from './sounds'

/**
 * Read-only view-model for the sound config panel: per piece, its combat stats
 * from code plus the cue ids it can produce. Pure data so it can be unit-tested
 * without a DOM.
 */

export interface HitVariant {
  attackerKey: string
  attackerName: string
  weapon: string
  shape: string
  damage: number
  id: string
}

export interface PieceAudioEntry {
  key: string
  name: string
  glyph: string
  hp: number
  move: { text: string; cooldown: number }
  weapon: {
    key: string
    damage: number
    /** Fraction of the target's max HP dealt per hit, if the weapon uses it. */
    damageFraction?: number
    cooldown: number
    /** shots per second */
    rate: number
    text: string
    vision: number
  }
  projectile: {
    key: string
    trajectory: string
    shape: string
    speed: number
    splash: number
    radius: number
    size: number
    color: string
  }
  fireId: string
  deathId: string
  hitsFrom: HitVariant[]
}

/** Human-readable summary of a movement/firing geometry. */
function describeGeometry(geom: Geometry): string {
  switch (geom.kind) {
    case 'slide':
      return `${geom.dirs.length} dirs · range ${geom.range}`
    case 'leap':
      return `${geom.offsets.length} offsets`
    case 'pawn':
      return `pawn · forward ${geom.forward}`
  }
}

export function pieceAudioCatalog(): PieceAudioEntry[] {
  return PIECE_LIST.map((piece) => {
    const weapon = WEAPONS[piece.weapon]
    const projectile = PROJECTILES[weapon.projectile]
    return {
      key: piece.key,
      name: piece.name,
      glyph: piece.glyph,
      hp: piece.hp,
      move: { text: describeGeometry(piece.move), cooldown: piece.moveCooldown },
      weapon: {
        key: weapon.key,
        damage: weapon.damage,
        damageFraction: weapon.damageFraction,
        cooldown: weapon.cooldown,
        rate: weapon.cooldown > 0 ? 1 / weapon.cooldown : 0,
        text: describeGeometry(weapon.geometry),
        vision: weaponVision(weapon.geometry),
      },
      projectile: {
        key: projectile.key,
        trajectory: projectile.trajectory,
        shape: projectile.shape,
        speed: projectile.speed,
        splash: projectile.splash,
        radius: projectile.radius,
        size: projectile.size,
        color: projectile.color,
      },
      fireId: shotId(weapon.key),
      deathId: deathId(piece.key),
      hitsFrom: PIECE_LIST.map((attacker) => {
        const atkWeapon = WEAPONS[attacker.weapon]
        const atkProjectile = PROJECTILES[atkWeapon.projectile]
        return {
          attackerKey: attacker.key,
          attackerName: attacker.name,
          weapon: atkWeapon.key,
          shape: atkProjectile?.shape ?? 'dot',
          damage: atkWeapon.damage,
          id: hitId(piece.key, atkWeapon.key),
        }
      }),
    }
  })
}
