import { cellsBetween, chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import type { OccupiedFn } from '../../game/geometry'
import { makeOccupied, occupiedExcept } from '../../game/occupancy'
import { PIECES, WEAPONS } from '../../game/pieces'
import type { TeamId, Vec2 } from '../../game/types'
import { Cell, PieceType, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import { coverageThreats } from './preservation'
import type { Threat, ThreatMemo } from './preservation'

/** How close an enemy must get before the AI king reacts even without a shot. */
export const KING_THREAT_RADIUS = 3
/** How far from the king a friendly AI piece still counts as a bodyguard. */
export const KING_GUARD_RADIUS = 4
/** The king backs off while a threat is inside this ring, then holds its ground. */
const KING_STANDOFF = 5
/** Radius within which a guard blocking an enemy's shot counts as screening. */
const KING_SCREEN_RADIUS = 6

/** The team's living king, or null for a king-less (already lost) side. */
export function kingOf(ctx: SimContext, team: TeamId): Entity | null {
  for (const e of ctx.world.query(PieceType, Cell, Team)) {
    if (ctx.world.require(e, Team) !== team) continue
    if (ctx.world.require(e, PieceType).kind === 'king') return e
  }
  return null
}

/**
 * The king's threats: the shared coverage scan, widened by `KING_THREAT_RADIUS`
 * so it also reacts to pieces that have closed in without a shot yet.
 */
export function kingThreats(ctx: SimContext, king: Entity, team: TeamId, memo: ThreatMemo): Threat[] {
  return coverageThreats(ctx, king, team, memo, { proximityRadius: KING_THREAT_RADIUS })
}

/** Outcome of trying to screen the king from one attacker. */
export interface ScreenPlan {
  /** The guard already stands on the firing line — hold the post. */
  onSegment: boolean
  /** A reachable square on the line to step onto, or null if none is. */
  cell: Vec2 | null
}

/**
 * Try to body-block `threat`'s shot at the king: find the passable cells on the
 * line between attacker and king, and return the nearest one this guard can step
 * onto. `onSegment` reports a guard that is already blocking, so it holds rather
 * than wandering off. Cells go into `claimed` so several guards spread out.
 */
export function screenPlan(
  ctx: SimContext,
  guard: Entity,
  team: TeamId,
  threat: Threat,
  kingCell: Vec2,
  occupied: OccupiedFn,
  claimed: Set<number>,
): ScreenPlan {
  const def = PIECES[ctx.world.get(guard, PieceType)?.kind ?? '']
  const gcell = ctx.world.get(guard, Cell)
  if (!def || !gcell) return { onSegment: false, cell: null }
  const width = ctx.board.width
  const key = (c: Vec2) => c.y * width + c.x
  const seg = cellsBetween(ctx.board, threat.cell, kingCell).filter((c) => ctx.board.passable(c.x, c.y))
  if (seg.length === 0) return { onSegment: false, cell: null }
  if (seg.some((c) => c.x === gcell.x && c.y === gcell.y)) return { onSegment: true, cell: null }

  let best: Vec2 | null = null
  let bestDist = Infinity
  for (const c of moveDestinations(ctx.board, gcell, def.move, team, occupied)) {
    if (claimed.has(key(c))) continue
    if (!seg.some((s) => s.x === c.x && s.y === c.y)) continue
    const d = (c.x - gcell.x) ** 2 + (c.y - gcell.y) ** 2
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  if (best) claimed.add(key(best))
  return { onSegment: false, cell: best }
}

/**
 * Whether `guard` is the reason a nearby enemy cannot currently shoot the king
 * — i.e. it is standing on that firing line and removing it would open the shot.
 * Used to keep a bodyguard planted on the line instead of wandering off once the
 * attacker is blocked (which also drops it out of the threat list).
 */
export function isScreening(ctx: SimContext, guard: Entity, team: TeamId, kingCell: Vec2): boolean {
  const gcell = ctx.world.get(guard, Cell)
  if (!gcell) return false
  const withGuard = makeOccupied(ctx.board, ctx.occupancy)
  const without = occupiedExcept(ctx.board, ctx.occupancy, guard)
  for (const enemy of ctx.world.query(Cell, Team, PieceType)) {
    if (enemy === guard) continue
    const enemyTeam = ctx.world.require(enemy, Team)
    if (enemyTeam === team) continue
    const ec = ctx.world.require(enemy, Cell)
    if (chebyshev(ec.x, ec.y, kingCell.x, kingCell.y) > KING_SCREEN_RADIUS) continue
    const def = PIECES[ctx.world.require(enemy, PieceType).kind]
    if (!def) continue
    const geom = WEAPONS[def.weapon].geometry
    if (containsCell(fireCells(ctx.board, ec, geom, enemyTeam, withGuard), kingCell.x, kingCell.y)) continue
    if (containsCell(fireCells(ctx.board, ec, geom, enemyTeam, without), kingCell.x, kingCell.y)) return true
  }
  return false
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
