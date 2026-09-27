import { cellsBetween, chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import type { OccupiedFn } from '../../game/geometry'
import { kingOf } from '../../game/healing'
import { dist, dist2, vecEquals } from '../../game/math'
import { makeOccupied, occupiedExcept } from '../../game/occupancy'
import { PIECES, WEAPONS } from '../../game/pieces'
import type { TeamId, Vec2 } from '../../game/types'
import { Cell, PieceType, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import { coverageThreats, ditherPenalty, homeCell } from './preservation'
import type { EscapeOptions, Threat, ThreatMemo } from './preservation'
import { buildCoverage, dangerAt, evaluateSafeStep } from './threatField'

/** How close an enemy must get before the AI king reacts even without a shot. */
const KING_THREAT_RADIUS = 3
/** How far from the king a friendly AI piece still counts as a bodyguard. */
export const KING_GUARD_RADIUS = 4
/** The king backs off while a threat is inside this ring, then holds its ground. */
const KING_STANDOFF = 5
/** Radius within which a guard blocking an enemy's shot counts as screening. */
const KING_SCREEN_RADIUS = 6

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
  const key = (c: Vec2) => ctx.board.cellIndex(c.x, c.y)
  const seg = cellsBetween(ctx.board, threat.cell, kingCell).filter((c) => ctx.board.passable(c.x, c.y))
  if (seg.length === 0) return { onSegment: false, cell: null }
  if (seg.some((c) => vecEquals(c, gcell))) return { onSegment: true, cell: null }

  let best: Vec2 | null = null
  let bestDist = Infinity
  for (const c of moveDestinations(ctx.board, gcell, def.move, team, occupied)) {
    if (claimed.has(key(c))) continue
    if (!seg.some((s) => vecEquals(s, c))) continue
    const d = dist2(c.x, c.y, gcell.x, gcell.y)
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

/**
 * AI king policy: hold the back-rank post and never join the rally. When
 * threatened, step to the legal square that lowers exposure to enemy fire
 * (coverage is tested against the attackers' firing geometry, so the king steps
 * out of a line rather than merely farther along it). Moves only when the step
 * actually improves safety; otherwise holds. Returns the goal cell, or null to
 * stand fast.
 */
export function aiKingGoal(
  ctx: SimContext,
  king: Entity,
  team: TeamId,
  threats: Threat[],
  options: EscapeOptions = {},
): Vec2 | null {
  const kind = ctx.world.get(king, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(king, Cell)
  if (!def || !cell) return null

  const home = homeCell(ctx, team)
  if (threats.length === 0) {
    return home && !vecEquals(cell, home) ? home : null
  }

  // Threat weight = damage, for every threat's firing geometry — including a
  // nearby enemy that cannot hit the king yet but can hit its escape square.
  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, king)
  const coverages = buildCoverage(ctx, threats, selfFree)
  // Step-in penalty: adjacent enemies can strike next turn, nearby ones apply
  // pressure even without a current line.
  const proximityPenalty = (d: number): number => {
    if (d <= 1) return 30
    if (d <= KING_THREAT_RADIUS) return (KING_THREAT_RADIUS - d + 1) * 3
    return 0
  }

  const step = evaluateSafeStep(
    ctx,
    cell,
    def.move,
    team,
    coverages,
    threats,
    proximityPenalty,
    (field, c) =>
      field.metrics(c.x, c.y, {
        secondary: home ? dist(c.x, c.y, home.x, home.y) : 0,
        penalty: ditherPenalty(c, options),
      }),
  )
  if (step === null) return null

  const { current, best, bestMetrics } = step
  if (current.danger > 0) {
    // Exposed: take the safest step, or a step that opens the gap at equal risk.
    if (bestMetrics.danger < current.danger) return best
    if (bestMetrics.danger === current.danger && bestMetrics.primary > current.primary + 1e-9) return best
    return null
  }
  // Not exposed: keep a standoff from a threat that is still close, then hold
  // rather than drift into a corner.
  if (current.primary < KING_STANDOFF && bestMetrics.primary > current.primary + 1e-9) return best
  return null
}

/** How close a threat must be before a king-only side stops holding and advances. */
const LAST_STAND_RADIUS = 3

export interface LoneKingOptions {
  /** Both sides are king-only: seek the enemy king instead of holding post. */
  enemyKingOnly?: boolean
}

/**
 * Lone-king policy: a king with no field pieces left never runs, because it is
 * faster than its attackers and dodging forever turned material wins into
 * turn-cap draws. Instead, when a threat is inside `LAST_STAND_RADIUS` it walks
 * straight at it, so the range-1 king guard (80% of max HP) becomes a real
 * threat and the finish resolves either way. Otherwise it returns to its post —
 * unless both sides are king-only, when it seeks the enemy king so an A-vs-A
 * king duel cannot idle out to the turn cap.
 */
export function loneKingGoal(
  ctx: SimContext,
  king: Entity,
  team: TeamId,
  threats: Threat[],
  options: LoneKingOptions = {},
): Vec2 | null {
  const kind = ctx.world.get(king, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(king, Cell)
  if (!def || !cell) return null

  const home = homeCell(ctx, team)
  const goHome = (): Vec2 | null => (home && !vecEquals(cell, home) ? home : null)

  let target: Vec2 | null = null
  if (threats.length > 0) {
    let nearest = threats[0]
    let nearestGap = chebyshev(cell.x, cell.y, nearest.cell.x, nearest.cell.y)
    for (const t of threats) {
      const gap = chebyshev(cell.x, cell.y, t.cell.x, t.cell.y)
      if (gap < nearestGap) {
        nearest = t
        nearestGap = gap
      }
    }
    if (nearestGap <= 1) return null
    if (nearestGap <= LAST_STAND_RADIUS) target = { x: nearest.cell.x, y: nearest.cell.y }
  }
  if (!target && options.enemyKingOnly) {
    const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
    const enemyKing = kingOf(ctx.world, enemyTeam)
    const ec = enemyKing !== null ? ctx.world.get(enemyKing, Cell) : null
    if (ec) target = { x: ec.x, y: ec.y }
  }
  if (!target) return goHome()

  const targetGap = chebyshev(cell.x, cell.y, target.x, target.y)
  if (targetGap <= 1) return null

  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, king)
  const coverages = buildCoverage(ctx, threats, selfFree)
  const moves = moveDestinations(ctx.board, cell, def.move, team, makeOccupied(ctx.board, ctx.occupancy))
  let best: Vec2 | null = null
  let bestGap = targetGap
  let bestDanger = Infinity
  for (const c of moves) {
    const gap = chebyshev(c.x, c.y, target.x, target.y)
    if (gap >= targetGap) continue
    const danger = dangerAt(coverages, threats, c.x, c.y)
    if (best === null || gap < bestGap || (gap === bestGap && danger < bestDanger)) {
      best = c
      bestGap = gap
      bestDanger = danger
    }
  }
  return best
}
