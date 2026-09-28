import { cellsBetween, chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import type { OccupiedFn } from '../../game/geometry'
import { kingOf } from '../../game/healing'
import { enemyCoverage } from '../../game/kingSafety'
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

  const covered = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, team)
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
    (c) => !covered.has(ctx.board.cellIndex(c.x, c.y)),
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
  /** The last cell the king vacated, penalised so an escape cannot shuffle A→B→A. */
  prevCell?: Vec2 | null
}

/**
 * Lone-king policy: a king with no field pieces left never runs, because it is
 * faster than its attackers and dodging forever turned material wins into
 * turn-cap draws. Instead, when a threat is inside `LAST_STAND_RADIUS` it walks
 * toward it, so the range-1 king guard (80% of max HP) becomes a real threat
 * and the finish resolves either way. Otherwise it returns to its post.
 *
 * The one exception is being *in check*: holding on a covered square is a
 * passive death, so the king steps to the safest legal square — including one
 * farther from the shooter, since a bishop or rook can cover every sideways and
 * forward escape. Among safe squares it still prefers one that keeps closing on
 * the shooter, so it last-stands rather than kites when both are available.
 *
 * Kings obey the no-check rule, so candidates covered by an enemy weapon are
 * never chosen: against the enemy king (both sides king-only) this naturally
 * settles into chess opposition at distance 2 — neither king may close, and the
 * game is a draw unless field pieces remain. Against a field threat the king
 * takes any legal adjacent square it can reach, or holds when there is none.
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

  // Nearest threat, for ranking escape squares.
  let nearest: Threat | null = null
  let nearestGap = Infinity
  for (const t of threats) {
    const gap = chebyshev(cell.x, cell.y, t.cell.x, t.cell.y)
    if (gap < nearestGap) {
      nearest = t
      nearestGap = gap
    }
  }

  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, king)
  const coverages = buildCoverage(ctx, threats, selfFree)
  const covered = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, team)
  const moves = moveDestinations(ctx.board, cell, def.move, team, makeOccupied(ctx.board, ctx.occupancy)).filter(
    (c) => !covered.has(ctx.board.cellIndex(c.x, c.y)),
  )

  // In check: step off the covered square. *Any* legal square counts, even one
  // farther from the shooter — holding in a firing line is a passive death, and
  // the side/forward escapes can all be covered (e.g. a bishop on the diagonal
  // covers both). Among safe squares, prefer one that keeps closing on the
  // shooter so the king still last-stands rather than kites, and penalise the
  // square it just vacated so it cannot shuffle A→B→A.
  if (covered.has(ctx.board.cellIndex(cell.x, cell.y)) && nearest !== null) {
    let escape: Vec2 | null = null
    let escapeDanger = Infinity
    let escapeRetreat = 1
    let escapeGap = Infinity
    for (const c of moves) {
      const danger = dangerAt(coverages, threats, c.x, c.y) + ditherPenalty(c, { prevCell: options.prevCell })
      const gap = chebyshev(c.x, c.y, nearest.cell.x, nearest.cell.y)
      const retreat = gap > nearestGap ? 1 : 0
      if (
        escape === null ||
        danger < escapeDanger ||
        (danger === escapeDanger &&
          (retreat < escapeRetreat || (retreat === escapeRetreat && gap < escapeGap)))
      ) {
        escape = c
        escapeDanger = danger
        escapeRetreat = retreat
        escapeGap = gap
      }
    }
    return escape
  }

  // Not in check: last-stand toward a nearby threat, else return to post.
  if (nearestGap <= 1) return null
  let target: Vec2 | null =
    nearest !== null && nearestGap <= LAST_STAND_RADIUS ? { x: nearest.cell.x, y: nearest.cell.y } : null
  if (!target && options.enemyKingOnly) {
    const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
    const enemyKing = kingOf(ctx.world, enemyTeam)
    const ec = enemyKing !== null ? ctx.world.get(enemyKing, Cell) : null
    if (ec) target = { x: ec.x, y: ec.y }
  }
  if (!target) return goHome()

  const targetGap = chebyshev(cell.x, cell.y, target.x, target.y)
  if (targetGap <= 1) return null
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
