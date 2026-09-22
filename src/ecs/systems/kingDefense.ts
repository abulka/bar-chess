import { chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import { makeOccupied, occupiedExcept } from '../../game/occupancy'
import { PIECES, WEAPONS } from '../../game/pieces'
import type { TeamId, Vec2 } from '../../game/types'
import { Cell, PieceType, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'

/** How close an enemy must get before the AI king reacts even without a shot. */
export const KING_THREAT_RADIUS = 3
/** How far from the king a friendly AI piece still counts as a bodyguard. */
export const KING_GUARD_RADIUS = 4
/** The king backs off while a threat is inside this ring, then holds its ground. */
const KING_STANDOFF = 5

/** A ranked enemy threat to the king, rebuilt once per team per tick. */
export interface Threat {
  entity: Entity
  team: TeamId
  cell: Vec2
  damage: number
  /** The enemy's weapon currently covers the king's square (line of sight). */
  canHitNow: boolean
  /** The enemy was the last piece to damage the king. */
  lastAttacker: boolean
  /** The enemy is adjacent to the king. */
  adjacent: boolean
  distance: number
  score: number
}

export type ThreatMemo = Map<TeamId, Threat[]>

/** The team's living king, or null for a king-less (already lost) side. */
export function kingOf(ctx: SimContext, team: TeamId): Entity | null {
  for (const e of ctx.world.query(PieceType, Cell, Team)) {
    if (ctx.world.require(e, Team) !== team) continue
    if (ctx.world.require(e, PieceType).kind === 'king') return e
  }
  return null
}

/**
 * Rank every enemy that can hurt the AI king this moment: anyone whose weapon
 * covers the king now (any distance, line of sight respected), whoever last hit
 * it, and anyone loitering within `KING_THREAT_RADIUS`. Sorted most dangerous
 * first — can-hit-now, then adjacency, then weapon damage, then closeness.
 */
export function kingThreats(ctx: SimContext, king: Entity, team: TeamId, memo: ThreatMemo): Threat[] {
  const cached = memo.get(team)
  if (cached) return cached

  const kingCell = ctx.world.get(king, Cell)
  const kingTarget = ctx.world.get(king, Target)
  if (!kingCell) {
    memo.set(team, [])
    return []
  }
  // Only treat the last hit as a live threat while the king is still "under
  // fire" (same window targeting/retreat use); otherwise it would flee forever.
  const lastAttacker =
    kingTarget && ctx.tick < kingTarget.underFireUntil ? kingTarget.lastAttacker : null
  // Fire lines are judged with the king itself removed so vacating its square
  // opens the same shots an escapee would have to dodge.
  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, king)

  const threats: Threat[] = []
  for (const other of ctx.world.query(Cell, Team, PieceType)) {
    if (other === king) continue
    const otherTeam = ctx.world.require(other, Team)
    if (otherTeam === team) continue
    const kind = ctx.world.require(other, PieceType).kind
    const def = PIECES[kind]
    if (!def) continue
    const oc = ctx.world.require(other, Cell)
    const gap = chebyshev(oc.x, oc.y, kingCell.x, kingCell.y)
    const isLast = other === lastAttacker
    const sweep = fireCells(ctx.board, oc, WEAPONS[def.weapon].geometry, otherTeam, selfFree)
    const canHitNow = containsCell(sweep, kingCell.x, kingCell.y)
    // Only react to a distant enemy if it is actually covering the king (a
    // sniper) or just hit it; otherwise it is not a threat yet.
    if (!canHitNow && !isLast && gap > KING_THREAT_RADIUS) continue
    const adjacent = gap <= 1
    const distance = Math.hypot(oc.x - kingCell.x, oc.y - kingCell.y)
    const damage = WEAPONS[def.weapon].damage
    threats.push({
      entity: other,
      team: otherTeam,
      cell: { x: oc.x, y: oc.y },
      damage,
      canHitNow,
      lastAttacker: isLast,
      adjacent,
      distance,
      score: (canHitNow ? 100 : 0) + (isLast ? 15 : 0) + (adjacent ? 25 : 0) + damage - distance,
    })
  }
  threats.sort((a, b) => b.score - a.score)
  memo.set(team, threats)
  return threats
}

/** Middle of a team's own back rank, the AI king's safe post. */
function homeCell(ctx: SimContext, team: TeamId): Vec2 | null {
  const lanes = ctx.board.data.lanes[team]
  return lanes.length > 0 ? lanes[Math.floor(lanes.length / 2)] : null
}

/**
 * AI king policy: hold the back-rank post and never join the rally. When
 * threatened, step to the legal square that lowers exposure to enemy fire
 * (coverage is tested against the attackers' firing geometry, so the king steps
 * out of a line rather than merely farther along it). Moves only when the step
 * actually improves safety; otherwise holds. Returns the goal cell, or null to
 * stand fast.
 */
export function aiKingGoal(ctx: SimContext, king: Entity, team: TeamId, threats: Threat[]): Vec2 | null {
  const kind = ctx.world.get(king, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(king, Cell)
  if (!def || !cell) return null

  const home = homeCell(ctx, team)
  if (threats.length === 0) {
    return home && (cell.x !== home.x || cell.y !== home.y) ? home : null
  }

  // Threat weight = damage, for every enemy that can currently hit the king.
  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, king)
  const coverages = threats
    .filter((t) => t.canHitNow)
    .map((t) => {
      const od = PIECES[ctx.world.require(t.entity, PieceType).kind]
      const cells = od ? fireCells(ctx.board, t.cell, WEAPONS[od.weapon].geometry, t.team, selfFree) : []
      return { cells, weight: t.damage }
    })

  const dangerAt = (x: number, y: number): number => {
    let danger = 0
    for (const cov of coverages) {
      if (containsCell(cov.cells, x, y)) danger += cov.weight
    }
    // Step-in penalty: adjacent enemies can strike next turn, nearby ones apply
    // pressure even without a current line.
    for (const t of threats) {
      const d = chebyshev(x, y, t.cell.x, t.cell.y)
      if (d <= 1) danger += 30
      else if (d <= KING_THREAT_RADIUS) danger += (KING_THREAT_RADIUS - d + 1) * 3
    }
    return danger
  }
  const minThreatDist = (x: number, y: number): number => {
    let min = Infinity
    for (const t of threats) min = Math.min(min, Math.hypot(x - t.cell.x, y - t.cell.y))
    return min
  }

  const options = moveDestinations(ctx.board, cell, def.move, team, makeOccupied(ctx.board, ctx.occupancy))
  const currentDanger = dangerAt(cell.x, cell.y)
  const currentDist = minThreatDist(cell.x, cell.y)
  let best: Vec2 | null = null
  let bestDanger = Infinity
  let bestDist = -Infinity
  let bestHome = Infinity
  for (const c of options) {
    const danger = dangerAt(c.x, c.y)
    const dist = minThreatDist(c.x, c.y)
    const homeDist = home ? Math.hypot(c.x - home.x, c.y - home.y) : 0
    const better =
      danger < bestDanger ||
      (danger === bestDanger && dist > bestDist + 1e-9) ||
      (danger === bestDanger && dist > bestDist - 1e-9 && homeDist < bestHome)
    if (better) {
      best = c
      bestDanger = danger
      bestDist = dist
      bestHome = homeDist
    }
  }

  if (best === null) return null
  if (currentDanger > 0) {
    // Exposed: take the safest step, or a step that opens the gap at equal risk.
    if (bestDanger < currentDanger) return best
    if (bestDanger === currentDanger && bestDist > currentDist + 1e-9) return best
    return null
  }
  // Not exposed: keep a standoff from a threat that is still close, then hold
  // rather than drift into a corner.
  if (currentDist < KING_STANDOFF && bestDist > currentDist + 1e-9) return best
  return null
}
