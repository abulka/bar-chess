import { ATTACK_LEASH } from '../../game/constants'
import { chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import { makeOccupied } from '../../game/occupancy'
import { closestEmptyCell, previewFiringCell } from '../../game/approach'
import { PIECES, WEAPONS } from '../../game/pieces'
import { reachableCells } from '../../game/pathfind'
import { promoteNext, rechainQueue } from '../../game/queue'
import { Cell, Health, Motion, Order, PieceType, Stance, Target, Team } from '../components'
import type { OrderData } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'
import { aiKingGoal, isScreening, KING_GUARD_RADIUS, kingOf, kingThreats, screenPlan } from './kingDefense'
import { COVER_RADIUS, coverageThreats, escapeGoal, isValuable, outgunned } from './preservation'
import type { ThreatMemo } from './preservation'

const REGROUP_TURNS = 2

/** HP ratio at which a piece starts saving itself, scaled by how costly it is. */
function preserveThreshold(kind: string): number {
  switch (kind) {
    case 'queen':
    case 'king':
      return 0.5
    case 'rook':
      return 0.45
    case 'bishop':
    case 'knight':
      return 0.4
    default:
      return 0.3
  }
}

/** Re-plan the remaining queue from the piece's current cell after a promotion. */
function rechain(ctx: SimContext, e: Entity, order: OrderData): void {
  const kind = ctx.world.get(e, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(e, Cell)
  const team = ctx.world.get(e, Team)
  if (!def || !cell || !team) return
  rechainQueue(ctx.board, cell, order.queue, def, team, (target) => ctx.world.get(target, Cell) ?? null)
}

/**
 * Whether this piece's movement geometry can ever reach `dest`, ignoring other
 * pieces (walls still block). A destination that fails this can never be
 * fulfilled, so a queued waypoint is skipped instead of stalling the queue. A
 * merely blocked waypoint is reachable here and therefore waits, exactly like a
 * single goto order.
 */
function destReachable(ctx: SimContext, e: Entity, dest: { x: number; y: number }): boolean {
  const kind = ctx.world.get(e, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(e, Cell)
  const team = ctx.world.get(e, Team)
  if (!def || !cell || !team) return true
  const reach = reachableCells(ctx.board, cell, def.move, team)
  const idx = dest.y * ctx.board.width + dest.x
  return idx >= 0 && idx < reach.length && reach[idx] === 1
}

function inFiringGeometry(ctx: SimContext, e: Entity, target: Entity, team: 'red' | 'blue'): boolean {
  const kind = ctx.world.require(e, PieceType).kind
  const def = PIECES[kind]
  if (!def) return false
  const cell = ctx.world.require(e, Cell)
  const tcell = ctx.world.require(target, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const cells = fireCells(ctx.board, cell, WEAPONS[def.weapon].geometry, team, occupied)
  return containsCell(cells, tcell.x, tcell.y)
}

/**
 * Stop and shoot when in geometry; otherwise move to a cell from which the
 * target can be hit (not onto the occupied target itself, which would deadlock).
 * The goal chain mirrors `Game.planAttack` exactly so the executed route never
 * diverges from the preview shown when the order was issued: a reachable firing
 * cell, else the closest reachable empty cell (for positionally unreachable
 * targets), else the target itself as a last resort.
 */
function pursue(ctx: SimContext, e: Entity, target: Entity, team: 'red' | 'blue'): { x: number; y: number } | null {
  if (inFiringGeometry(ctx, e, target, team)) return null
  const def = PIECES[ctx.world.require(e, PieceType).kind]
  if (!def) return null
  const cell = ctx.world.require(e, Cell)
  const tcell = ctx.world.require(target, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const weaponGeom = WEAPONS[def.weapon].geometry
  return (
    previewFiringCell(ctx.board, cell, tcell, def.move, weaponGeom, team, occupied) ??
    closestEmptyCell(ctx.board, cell, tcell, def.move, team, occupied) ??
    { x: tcell.x, y: tcell.y }
  )
}

/**
 * Best one-move cell that backs off from the threat while keeping it in firing
 * geometry. Prefers staying in range, then distance; falls back to pure flee
 * (farthest cell) when nothing can shoot. Returns null (hold) when no cell opens
 * the gap, so a cornered piece does not shuffle between equal-distance cells.
 */
function kiteCell(ctx: SimContext, e: Entity, team: 'red' | 'blue', threat: Entity): { x: number; y: number } | null {
  const kind = ctx.world.require(e, PieceType).kind
  const def = PIECES[kind]
  if (!def) return null
  const cell = ctx.world.require(e, Cell)
  const tc = ctx.world.get(threat, Cell)
  if (!tc) return null
  const board = ctx.board
  const blocked = (x: number, y: number) => {
    const other = ctx.occupancy.get(y * board.width + x)
    return other !== undefined && other !== e
  }
  const options = moveDestinations(board, cell, def.move, team, blocked)
  const weaponGeom = WEAPONS[def.weapon].geometry
  const currentDist = Math.hypot(cell.x - tc.x, cell.y - tc.y)
  let best: { x: number; y: number } | null = null
  let bestScore = -Infinity
  let bestDist = currentDist
  for (const c of options) {
    const dist = Math.hypot(c.x - tc.x, c.y - tc.y)
    const inRange = containsCell(fireCells(board, c, weaponGeom, team, blocked), tc.x, tc.y)
    const score = (inRange ? 1_000_000 : 0) + dist
    if (score > bestScore) {
      bestScore = score
      bestDist = dist
      best = c
    }
  }
  // No cell opens the gap (cornered): hold rather than shuffle in place, so a
  // kite cannot oscillate between two equally distant cells.
  if (best === null || bestDist <= currentDist) return null
  return best
}

function rally(ctx: SimContext, team: 'red' | 'blue'): { x: number; y: number } | null {
  const enemy = team === 'red' ? 'blue' : 'red'
  const lanes = ctx.board.data.lanes[enemy]
  return lanes.length > 0 ? lanes[Math.floor(lanes.length / 2)] : null
}

const system: System = {
  name: 'orders',
  update(ctx) {
    // Per-tick caches: the king's enemy threat list is shared by every AI piece
    // so bodyguards do not rescan the board. Rebuilt each update, so undo/redo
    // and replay never see a stale entry.
    const kingThreatMemo: ThreatMemo = new Map()
    const pieceThreatMemo: ThreatMemo = new Map()
    const kings = { red: kingOf(ctx, 'red'), blue: kingOf(ctx, 'blue') }
    // Squares already earmarked for screening this turn, so guards spread out.
    const claimed = new Set<number>()

    for (const e of ctx.world.query(Stance, Order, Motion, Cell, Team, Target)) {
      const stance = ctx.world.require(e, Stance)
      const order = ctx.world.require(e, Order)
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const team = ctx.world.require(e, Team)
      const target = ctx.world.require(e, Target)

      // 0. Self-preservation: a hurt or outgunned piece steps out of the fire on
      // its own, even with no order or an explicit one. Costly pieces bail
      // earlier. The active order stays queued and resumes once the piece is safe.
      const hp = ctx.world.get(e, Health)
      const hpRatio = hp && hp.max > 0 ? hp.cur / hp.max : 1
      const attacker = target.lastAttacker
      const underFire =
        attacker !== null &&
        ctx.tick < target.underFireUntil &&
        ctx.world.isAlive(attacker) &&
        ctx.world.has(attacker, Cell)
      const kind = ctx.world.get(e, PieceType)?.kind
      const targetValid =
        target.entity !== null && ctx.world.isAlive(target.entity) && ctx.world.has(target.entity, Cell)
      const preserve = kind ? preserveThreshold(kind) : 0
      // Valuable pieces scan every tick so they can bail *before* taking damage;
      // cheap pieces only bother once hurt or actually under fire.
      const valuable = kind !== undefined && isValuable(kind)
      if (
        ctx.autoPreserve &&
        kind &&
        !(ctx.teams[team].controller === 'ai' && kind === 'king') &&
        (valuable || underFire || hpRatio < preserve)
      ) {
        // Judge the escape against every enemy currently covering this piece, not
        // just the last one to shoot. Valuable pieces also bail when outgunned or
        // focused by two or more shooters, before their HP drops.
        // Wide scan: even enemies not yet shooting count as cover pressure, so a
        // hurt piece backs away from the danger instead of standing in it.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        const shooters = threats.reduce((n, t) => n + (t.canHitNow ? 1 : 0), 0)
        const pressured = outgunned(ctx, e, threats) || (valuable && shooters >= 2)
        if (hpRatio < preserve || pressured) {
          // Seek cover: step to the least-exposed nearby square, keeping a shot
          // when free; hold when every step is no safer (or nobody is near).
          // Pawns cannot retreat, so an "escape" only marches them into the enemy
          // and gives up the shot — they hold and fire instead.
          const keepShot =
            targetValid && (order.kind === 'attack' || stance.mode === 'attack') ? (target.entity as number) : null
          motion.goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, keepShot)
          continue
        }
      }

      // 1. Explicit attack order: glue to the target until it dies.
      if (order.kind === 'attack') {
        const t = order.target
        if (t !== null && ctx.world.isAlive(t) && ctx.world.has(t, Cell)) {
          // Best-effort approach: stop and fire when in geometry, else head to a
          // firing cell, else the closest reachable empty square. A positionally
          // unreachable target (e.g. a bishop on the wrong colour) is therefore
          // still approached as close as the piece can get, and the overlay draws
          // that route followed by a dashed "unreachable" firing line. Targeting
          // recomputes `reachable` every tick, so the route and overlay update as
          // the piece and target move.
          motion.goal = pursue(ctx, e, t, team)
          continue
        }
        // The order is done; the next queued step takes over, else clear. The
        // stance is kept so the piece stays in Attack either way.
        if (promoteNext(order, motion)) {
          rechain(ctx, e, order)
          continue
        }
        order.kind = 'none'
        order.target = null
        order.resumeTarget = null
        order.resumeTurn = -1
      }

      // 2. Goto order: advance toward the objective (best effort if unreachable).
      // A move issued mid-attack suspends the attack and resumes it after a
      // regroup window (or as soon as the piece is no longer under fire).
      if (order.kind === 'goto') {
        // Once armed, the piece is in the regroup phase regardless of where it
        // has kited to, so the arrival test below is skipped from then on.
        const armed = order.resumeTarget !== null && order.resumeTurn >= 0
        if (!armed) {
          const arrived =
            order.dest !== null && order.dest.x === cell.x && order.dest.y === cell.y && !motion.moving
          // Only treat a blocked, pathless piece as stuck once the pending replan
          // has had a chance to run, so a transient block does not end the move.
          const stuck =
            !motion.moving && motion.blocked && motion.path.length === 0 && ctx.tick >= motion.replanAt
          // A fulfilled waypoint yields to the queue. A waypoint this piece's
          // geometry can never reach is skipped too (best-effort would idle
          // forever); a waypoint merely blocked by pieces keeps waiting.
          const unreachable = order.dest !== null && !destReachable(ctx, e, order.dest)
          if (arrived || (unreachable && order.queue.length > 0)) {
            if (promoteNext(order, motion)) {
              rechain(ctx, e, order)
              if (unreachable && !arrived) ctx.bus.emit('warn', `#${e} skipping unreachable waypoint`)
              continue
            }
          }
          if (!arrived && !(stuck && order.resumeTarget !== null)) {
            motion.goal = order.dest
            continue
          }

          if (order.resumeTarget === null) {
            order.kind = 'none'
            order.dest = null
            motion.goal = null
            continue
          }

          order.resumeTurn = ctx.turn + REGROUP_TURNS
        }

        const parked = order.resumeTarget
        if (parked === null) {
          order.kind = 'none'
          order.dest = null
          motion.goal = null
          continue
        }
        const parkedValid = ctx.world.isAlive(parked) && ctx.world.has(parked, Cell)
        const attacker = target.lastAttacker
        const threat =
          attacker !== null && ctx.world.isAlive(attacker) && ctx.world.has(attacker, Cell)
            ? attacker
            : parkedValid
              ? parked
              : null
        const underFire = threat !== null && ctx.tick < target.underFireUntil

        if (parkedValid && (ctx.turn < order.resumeTurn || underFire)) {
          // Hold, but kite back a step while under fire so it never sits in the
          // danger zone; return fire still happens via targeting/combat.
          motion.goal = underFire && threat !== null ? kiteCell(ctx, e, team, threat) : null
          continue
        }

        if (parkedValid) {
          order.kind = 'attack'
          order.target = parked
          order.resumeTarget = null
          order.resumeTurn = -1
          motion.goal = pursue(ctx, e, parked, team)
          continue
        }

        order.kind = 'none'
        order.dest = null
        order.resumeTarget = null
        order.resumeTurn = -1
        motion.goal = null
        continue
      }

      // 3. Autonomous stance.
      const controller = ctx.teams[team].controller
      const mode = controller === 'ai' ? 'attack' : stance.mode

      if (mode !== 'attack') {
        motion.goal = null
        continue
      }

      // The AI king defends its post instead of charging with the army.
      if (controller === 'ai' && ctx.world.get(e, PieceType)?.kind === 'king') {
        motion.goal = aiKingGoal(ctx, e, team, kingThreats(ctx, e, team, kingThreatMemo))
        continue
      }

      // Nearby AI pieces break off to defend the king. Guards within
      // KING_GUARD_RADIUS first try to screen the line of fire, else engage the
      // most dangerous threat; the rest of the army keeps pressing the attack.
      if (controller === 'ai') {
        const king = kings[team]
        const kc = king !== null ? ctx.world.get(king, Cell) : null
        if (king !== null && king !== e && kc && chebyshev(cell.x, cell.y, kc.x, kc.y) <= KING_GUARD_RADIUS) {
          // Already blocking a shot: stay planted rather than chasing.
          if (isScreening(ctx, e, team, kc)) {
            motion.goal = null
            continue
          }
          const threats = kingThreats(ctx, king, team, kingThreatMemo)
          if (threats.length > 0) {
            const top = threats[0]
            target.entity = top.entity
            target.retargetAt = ctx.tick + 12
            const plan = top.canHitNow
              ? screenPlan(ctx, e, team, top, kc, makeOccupied(ctx.board, ctx.occupancy), claimed)
              : { onSegment: false, cell: null }
            if (plan.onSegment) motion.goal = null
            else motion.goal = plan.cell ?? pursue(ctx, e, top.entity, team)
            continue
          }
        }
      }

      if (targetValid && hpRatio < preserveThreshold(kind ?? '')) {
        // Low HP (auto-preserve off): seek nearby cover, keeping the shot if free.
        // Pawns cannot retreat, so they hold and fire instead.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        motion.goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, target.entity as number)
        continue
      }
      if (!targetValid) {
        // AI armies advance; a player's Attack stance skirmishes locally.
        motion.goal = controller === 'ai' ? rally(ctx, team) : null
        continue
      }
      // Leash: don't chase an auto-acquired target clear across the board.
      const tcell = ctx.world.get(target.entity as number, Cell)
      const beyondLeash =
        tcell !== undefined &&
        chebyshev(cell.x, cell.y, tcell.x, tcell.y) > ATTACK_LEASH &&
        !inFiringGeometry(ctx, e, target.entity as number, team)
      motion.goal = beyondLeash ? null : pursue(ctx, e, target.entity as number, team)
    }
  },
}

export default system
