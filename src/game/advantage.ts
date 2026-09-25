import { Cell, Health, PieceType, Team, Weapon } from '../ecs/components'
import { TEAM_NAMES } from './constants'
import { containsCell, fireCells } from './geometry'
import type { Game } from './game'
import { buildOccupancy, makeOccupied } from './occupancy'
import { PIECES, WEAPONS, weaponDamage } from './pieces'
import type { TeamId, Vec2 } from './types'

/**
 * Static position evaluation, in "pawn points", positive when red is ahead.
 * No lookahead: it only reads the current world, so it is cheap, deterministic
 * and identical on undo/replay.
 *
 * Three terms:
 *  - HP-weighted material, so a half-dead rook is worth about half a rook;
 *  - king survivability, since the battle is lost when a king falls;
 *  - immediate king danger: who can hit the enemy king right now, weighted by
 *    the damage it would deal and how ready the weapon is.
 */
const VALUE: Record<string, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 0,
}

/** Kind order used when comparing piece counts. */
const KIND_ORDER = ['pawn', 'knight', 'bishop', 'rook', 'queen'] as const

/** Weight on king HP fraction (a king is the whole game, but not a piece value). */
const KING_WEIGHT = 6

/** Weight on a single hit's share of the enemy king's health. */
const THREAT_WEIGHT = 4

/** Pawn points at which the position reads as clearly lopsided for the bar. */
const BAR_SCALE = 6

interface ScoredPiece {
  team: TeamId
  kind: string
  cell: Vec2
  weaponLeft: number
}

export interface AdvantageDetail {
  /** Signed total, positive means red is ahead. */
  score: number
  /** HP-weighted material points per side (kings excluded). */
  material: Record<TeamId, number>
  /** King HP fraction per side. */
  king: Record<TeamId, number>
  /** Threat that side currently exerts on the enemy king, in king-HP fractions. */
  pressure: Record<TeamId, number>  /** Living non-king piece count per kind per side. */
  counts: Record<TeamId, Record<string, number>>
}

const enemyOf = (team: TeamId): TeamId => (team === 'red' ? 'blue' : 'red')

/** Full static breakdown of the live position. */
export function advantageDetail(game: Game): AdvantageDetail {
  const world = game.world
  const board = game.board
  const occupied = makeOccupied(board, buildOccupancy(world, board))
  const material: Record<TeamId, number> = { red: 0, blue: 0 }
  const king: Record<TeamId, number> = { red: 0, blue: 0 }
  const pressure: Record<TeamId, number> = { red: 0, blue: 0 }
  const counts: Record<TeamId, Record<string, number>> = { red: {}, blue: {} }
  const kingCell: Record<TeamId, Vec2 | null> = { red: null, blue: null }
  const kingMax: Record<TeamId, number> = { red: 0, blue: 0 }
  const pieces: ScoredPiece[] = []

  for (const e of world.query(Cell, Team, Health, PieceType)) {
    const hp = world.require(e, Health)
    if (hp.cur <= 0) continue
    const team = world.require(e, Team)
    const kind = world.require(e, PieceType).kind
    const cell = world.require(e, Cell)
    const ratio = hp.max > 0 ? hp.cur / hp.max : 0
    if (kind === 'king') {
      kingCell[team] = cell
      kingMax[team] = hp.max
      king[team] = ratio
      continue
    }
    counts[team][kind] = (counts[team][kind] ?? 0) + 1
    material[team] += (VALUE[kind] ?? 0) * ratio
    pieces.push({ team, kind, cell, weaponLeft: world.get(e, Weapon)?.left ?? 0 })
  }

  for (const p of pieces) {
    const def = PIECES[p.kind]
    if (!def) continue
    const foe = enemyOf(p.team)
    const target = kingCell[foe]
    if (!target) continue
    const maxHp = kingMax[foe] || 1
    const wdef = WEAPONS[def.weapon]
    if (!containsCell(fireCells(board, p.cell, wdef.geometry, p.team, occupied), target.x, target.y)) {
      continue
    }
    const share = weaponDamage(wdef, maxHp) / maxHp
    // A ready weapon is a live threat; a reloading one counts for less. The
    // threat credits the attacker, so it adds to that side's score.
    const readiness =
      p.weaponLeft <= 0 ? 1 : Math.max(0.3, 1 - p.weaponLeft / Math.max(0.001, wdef.cooldown))
    pressure[p.team] += THREAT_WEIGHT * share * readiness
  }

  const scoreOf = (team: TeamId): number => material[team] + KING_WEIGHT * king[team] + pressure[team]
  return { score: scoreOf('red') - scoreOf('blue'), material, king, pressure, counts }
}

/** Signed evaluation of the live position: positive means red is ahead. */
export function evaluatePosition(game: Game): number {
  return advantageDetail(game).score
}

/**
 * Map a signed evaluation to a bar fraction in [-1, 1]: negative fills toward
 * blue, positive toward red. A logistic keeps small edges visible while a
 * lopsided position saturates near the ends.
 */
export function advantageFraction(score: number): number {
  return Math.tanh(score / BAR_SCALE)
}

/** Human readout for the bar, e.g. `Orange +3.2` or `even`. */
export function advantageLabel(score: number): string {
  if (Math.abs(score) < 0.05) return 'even'
  const leader = score > 0 ? TEAM_NAMES.red : TEAM_NAMES.blue
  return `${leader} +${Math.abs(score).toFixed(1)}`
}

function plural(kind: string, n: number): string {
  return n === 1 ? kind : `${kind}s`
}

/**
 * A specific, readable tooltip: who leads by how much, the HP-weighted material
 * totals, which pieces each side has more of, the kings' health and whether a
 * king is currently under fire.
 */
export function describeAdvantage(detail: AdvantageDetail): string {
  const red = TEAM_NAMES.red
  const blue = TEAM_NAMES.blue
  const pct = (r: number): string => `${Math.round(r * 100)}%`
  const margin = Math.abs(detail.score)
  const leader = detail.score > 0 ? red : blue

  const lines: string[] = [
    margin < 0.05 ? 'Dead even' : `${leader} leads by ${margin.toFixed(1)}`,
    `Material ${red} ${detail.material.red.toFixed(1)} vs ${blue} ${detail.material.blue.toFixed(1)}`,
  ]

  const redMore: string[] = []
  const blueMore: string[] = []
  for (const kind of KIND_ORDER) {
    const d = (detail.counts.red[kind] ?? 0) - (detail.counts.blue[kind] ?? 0)
    if (d > 0) redMore.push(`${d} ${plural(kind, d)}`)
    else if (d < 0) blueMore.push(`${-d} ${plural(kind, -d)}`)
  }
  const parts: string[] = []
  if (redMore.length > 0) parts.push(`${red} +${redMore.join(', +')}`)
  if (blueMore.length > 0) parts.push(`${blue} +${blueMore.join(', +')}`)
  lines.push(parts.length > 0 ? parts.join(' · ') : 'Piece counts level')

  lines.push(`Kings ${red} ${pct(detail.king.red)} · ${blue} ${pct(detail.king.blue)}`)
  if (detail.pressure.blue >= 0.2) lines.push(`${red}'s king is under fire`)
  if (detail.pressure.red >= 0.2) lines.push(`${blue}'s king is under fire`)
  return lines.join('\n')
}
