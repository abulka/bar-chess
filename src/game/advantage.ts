import { Cell, Health, PieceType, Team } from '../ecs/components'
import { makeOccupied, buildOccupancy } from './occupancy'
import { TEAM_IDS, TEAM_NAMES } from './constants'
import { containsCell, fireCells, moveDestinations } from './geometry'
import type { Game } from './game'
import { enemyCoverage, isInCheck } from './kingSafety'
import { PIECES, WEAPONS, weaponDamage } from './pieces'
import type { TeamId, Vec2 } from './types'

/**
 * Static position evaluation, in "pawn points", positive when red is ahead.
 * No lookahead: it only reads the current world, so it is cheap, deterministic
 * and identical on undo/replay.
 *
 * Terms:
 *  - HP-weighted material, so a half-dead rook is worth about half a rook;
 *  - a convex king term: a king is the whole game, so its value does not just
 *    scale linearly with HP but collapses as it nears death;
 *  - immediate king danger: who can hit the enemy king right now, weighted by
 *    how much of the king's *remaining* life the hit would remove (a ready
 *    queen on a 22-HP king is lethal, not a tenth of a full-health hit);
 *  - a decisive trapped-king term: a king in check with no legal square has
 *    effectively already lost, whatever the material says.
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

/** Linear value of a healthy king (a king is the whole game, not a piece value). */
const KING_WEIGHT = 6

/** Extra penalty that grows quadratically as the king's HP approaches zero. */
const KING_CRISIS = 12

/** Weight on the fraction of the enemy king's remaining life a hit removes. */
const THREAT_WEIGHT = 4

/** Most a single attacker's lethality can count for (a one-shot attacker). */
const LETHAL_CAP = 2

/** Ceiling on a side's total king danger, so momentary crossfire cannot dominate. */
const PRESSURE_CAP = 6

/** Score magnitude that pins the bar to a side whose king is trapped. */
const LOST_SCORE = 100

/** Pawn points at which the position reads as clearly lopsided for the bar. */
const BAR_SCALE = 6

/** How far the displayed bar eases toward a fresh score each turn (0..1). */
const SMOOTHING = 0.35

interface ScoredPiece {
  team: TeamId
  kind: string
  cell: Vec2
}

export interface AdvantageDetail {
  /** Signed total, positive means red is ahead. */
  score: number
  /** HP-weighted material points per side (kings excluded). */
  material: Record<TeamId, number>
  /** King HP fraction per side. */
  king: Record<TeamId, number>
  /** Crisis-adjusted king points per side (`KING_WEIGHT·r − KING_CRISIS·(1−r)²`). */
  kingValue: Record<TeamId, number>
  /** Threat that side currently exerts on the enemy king, in remaining-life fractions. */
  pressure: Record<TeamId, number>
  /** True when some enemy can kill that side's king in a single hit right now. */
  kingInLethal: Record<TeamId, boolean>
  /** True when that side's king is in check with no legal square (checkmate). */
  lost: Record<TeamId, boolean>
  /** Living non-king piece count per kind per side. */
  counts: Record<TeamId, Record<string, number>>
}

const enemyOf = (team: TeamId): TeamId => (team === 'red' ? 'blue' : 'red')

/** Crisis-adjusted value of a king at HP fraction `r`. */
function kingValueAt(r: number): number {
  return KING_WEIGHT * r - KING_CRISIS * (1 - r) * (1 - r)
}

/** Full static breakdown of the live position. */
export function advantageDetail(game: Game): AdvantageDetail {
  const world = game.world
  const board = game.board
  const occupancy = buildOccupancy(world, board)
  const occupied = makeOccupied(board, occupancy)
  const material: Record<TeamId, number> = { red: 0, blue: 0 }
  const king: Record<TeamId, number> = { red: 0, blue: 0 }
  const kingValue: Record<TeamId, number> = { red: 0, blue: 0 }
  const pressure: Record<TeamId, number> = { red: 0, blue: 0 }
  const kingInLethal: Record<TeamId, boolean> = { red: false, blue: false }
  const lost: Record<TeamId, boolean> = { red: false, blue: false }
  const counts: Record<TeamId, Record<string, number>> = { red: {}, blue: {} }
  const kingCell: Record<TeamId, Vec2 | null> = { red: null, blue: null }
  const kingMax: Record<TeamId, number> = { red: 0, blue: 0 }
  const kingCur: Record<TeamId, number> = { red: 0, blue: 0 }
  const kingEntity: Record<TeamId, number | null> = { red: null, blue: null }
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
      kingCur[team] = hp.cur
      kingEntity[team] = e
      king[team] = ratio
      kingValue[team] = kingValueAt(ratio)
      continue
    }
    counts[team][kind] = (counts[team][kind] ?? 0) + 1
    material[team] += (VALUE[kind] ?? 0) * ratio
    pieces.push({ team, kind, cell })
  }

  for (const p of pieces) {
    const def = PIECES[p.kind]
    if (!def) continue
    const foe = enemyOf(p.team)
    const target = kingCell[foe]
    if (!target) continue
    const maxHp = kingMax[foe] || 1
    const curHp = kingCur[foe] || 1
    const wdef = WEAPONS[def.weapon]
    if (!containsCell(fireCells(board, p.cell, wdef.geometry, p.team, occupied), target.x, target.y)) {
      continue
    }
    const damage = weaponDamage(wdef, maxHp)
    // Threat is measured against the king's remaining life: a hit that would
    // kill it is worth far more than the same hit on a full-health king. The
    // reload phase is deliberately not counted: a piece covering the king will
    // fire within a cooldown, and scaling by it made the bar flip every turn.
    const lethal = Math.min(LETHAL_CAP, damage / curHp)
    if (damage >= curHp) kingInLethal[foe] = true
    pressure[p.team] += THREAT_WEIGHT * lethal
  }
  for (const id of TEAM_IDS) pressure[id] = Math.min(PRESSURE_CAP, pressure[id])

  // A king in check with no legal square is checkmate under the no-check rule:
  // no material can save it.
  for (const id of TEAM_IDS) {
    const e = kingEntity[id]
    if (e === null || kingCell[id] === null) continue
    if (!isInCheck(board, world, occupancy, e, id)) continue
    const covered = enemyCoverage(board, world, occupancy, e, id)
    const canMove = moveDestinations(board, kingCell[id]!, PIECES.king.move, id, occupied).some(
      (c) => !covered.has(board.cellIndex(c.x, c.y)),
    )
    if (!canMove) lost[id] = true
  }

  let score: number
  if (lost.red && !lost.blue) score = -LOST_SCORE
  else if (lost.blue && !lost.red) score = LOST_SCORE
  else {
    const scoreOf = (team: TeamId): number => material[team] + kingValue[team] + pressure[team]
    score = scoreOf('red') - scoreOf('blue')
  }

  return { score, material, king, kingValue, pressure, kingInLethal, lost, counts }
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

/**
 * Ease a displayed score toward a fresh evaluation across turns. A static
 * per-turn sample of a knife-edge position (both kings threatened, firing lines
 * opening and closing) can flip sign every turn; damping keeps the bar honest
 * and readable, while a large real change still lands within a turn or two.
 */
export function smoothScore(previous: number, next: number): number {
  return previous + (next - previous) * SMOOTHING
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
 * totals, which pieces each side has more of, and the kings' state (health,
 * imminent lethal danger and checkmate).
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
  if (detail.lost.red) lines.push(`${red}'s king is trapped — checkmate`)
  else if (detail.lost.blue) lines.push(`${blue}'s king is trapped — checkmate`)
  if (detail.kingInLethal.red) lines.push(`${red}'s king is one hit from death`)
  else if (detail.pressure.blue >= 0.2) lines.push(`${red}'s king is under fire`)
  if (detail.kingInLethal.blue) lines.push(`${blue}'s king is one hit from death`)
  else if (detail.pressure.red >= 0.2) lines.push(`${blue}'s king is under fire`)
  return lines.join('\n')
}
