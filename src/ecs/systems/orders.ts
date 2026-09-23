import { ATTACK_LEASH } from '../../game/constants'
import { chebyshev, containsCell, fireCells } from '../../game/geometry'
import { makeOccupied } from '../../game/occupancy'
import { HEAL_RADIUS } from '../../game/healing'
import { closestEmptyCell, previewFiringCell } from '../../game/approach'
import { coordName } from '../../game/coords'
import { PIECES, WEAPONS } from '../../game/pieces'
import { destReachable as canReach } from '../../game/pathfind'
import { noteOrder, promoteNext, rechainQueue } from '../../game/queue'
import { Cell, Health, Motion, Order, PieceType, Stance, Target, Team } from '../components'
import type { OrderData } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'
import { aiKingGoal, isScreening, KING_GUARD_RADIUS, kingOf, kingThreats, screenPlan } from './kingDefense'
import {
  COVER_RADIUS,
  coverageThreats,
  escapeGoal,
  inHealingAura,
  isValuable,
  nearestHealingCell,
  outgunned,
} from './preservation'
import type { ThreatMemo } from './preservation'

/** Flat HP fraction at or below which a piece is "badly wounded": it latches a
 * safe-hold and will not advance its order until fully healed. */
const CRITICAL_WOUND = 0.2

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
  return canReach(ctx.board, cell, def.move, team, dest)
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

      // 0. Self-preservation: a hurt or outgunned piece retreats on its own, even
      // while it is moving or pursuing an attack order. A badly wounded piece
      // (below CRITICAL_WOUND) latches a safe-hold and stays put until fully
      // healed; a medium wound only retreats while the danger is present, then
      // resumes its order. A new order clears the hold.
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
      // Release a latched safe-hold once the piece is back to full health.
      if (motion.holdUntilHp > 0 && hp && hp.cur >= motion.holdUntilHp) motion.holdUntilHp = 0
      const holding = motion.holdUntilHp > 0
      if (
        ctx.autoPreserve &&
        kind &&
        !(ctx.teams[team].controller === 'ai' && kind === 'king') &&
        (valuable || underFire || hpRatio < preserve || holding)
      ) {
        // Judge the escape against every enemy currently covering this piece, not
        // just the last one to shoot. Valuable pieces also bail when outgunned or
        // focused by two or more shooters, before their HP drops.
        // Wide scan: even enemies not yet shooting count as cover pressure, so a
        // hurt piece backs away from the danger instead of standing in it.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        const shooters = threats.reduce((n, t) => n + (t.canHitNow ? 1 : 0), 0)
        const pressured = outgunned(ctx, e, threats) || (valuable && shooters >= 2)
        const wounded = hpRatio < preserve
        // The king's healing aura is a sanctuary: inside it a piece holds rather
        // than repositioning unless the volley it faces would kill it (outgunned).
        // Outside it dodges whenever an enemy covers the square now or it is under
        // fire.
        const king = kings[team]
        const kc = king !== null ? ctx.world.get(king, Cell) : null
        const inAura = !!kc && chebyshev(cell.x, cell.y, kc.x, kc.y) <= HEAL_RADIUS
        const shouldDodge = inAura ? outgunned(ctx, e, threats) : shooters > 0 || underFire
        // Act (dodge or hold) while latched, or while wounded/pressured and either
        // in danger or sitting in the healing aura. Otherwise fall through and let
        // the order resume — that is what lets a medium wound continue once safe.
        const act = holding || ((wounded || pressured) && (shouldDodge || inAura))
        if (act) {
          // A badly wounded piece holds until fully healed.
          if (hp && (wounded || pressured) && hpRatio < CRITICAL_WOUND) motion.holdUntilHp = hp.max
          const lethal = outgunned(ctx, e, threats)
          const prevIntent = motion.intent
          const prevGoal = motion.goal
          // Record the autonomous retreat in the order history (the same log the
          // panel and transcript surface) so a self-preservation move is not
          // invisible once it completes. Log only on a real transition, so a held
          // goal does not spam the bounded log every tick.
          const setPreserveGoal = (goal: { x: number; y: number } | null, text: string): void => {
            motion.goal = goal
            motion.intent = goal === null ? 'none' : 'preserve'
            const moved =
              goal !== null && (prevGoal === null || prevGoal.x !== goal.x || prevGoal.y !== goal.y)
            if (prevIntent !== motion.intent || moved) noteOrder(order, ctx.tick, text)
          }
          // Healing-aware hold: a latched, badly wounded piece outside the aura
          // walks to the nearest healing square so it can regenerate and release
          // the hold, instead of parking where it can never heal. An explicit move
          // order that already ends inside the aura is left to run, and only a
          // volley that would kill it this tick breaks it off to dodge.
          const auraBound =
            order.kind === 'goto' && order.dest !== null && !!kc && inHealingAura(order.dest, kc)
          if (holding && !inAura && kc && kind !== 'pawn' && !(auraBound && !lethal)) {
            const heal = nearestHealingCell(ctx, e, team, kc)
            if (heal) {
              const goal = lethal && shouldDodge ? escapeGoal(ctx, e, team, threats, null) ?? heal : heal
              setPreserveGoal(goal, `self-preservation retreat → ${coordName(goal.x, goal.y, ctx.board.height)}`)
              continue
            }
          }
          if (auraBound && !lethal) {
            // Fall through: honour the player's move order into the healing aura.
          } else if (shouldDodge) {
            // Seek cover: step to the least-exposed nearby square, keeping a shot
            // when free; hold when every step is no safer (or nobody is near).
            // Pawns cannot retreat, so an "escape" only marches them into the
            // enemy and gives up the shot — they hold and fire instead.
            // Keep the shot while backing off: an attack order (or Attack stance)
            // holds its target in range as a tie-break.
            const keepShot =
              targetValid && (order.kind === 'attack' || stance.mode === 'attack')
                ? (target.entity as number)
                : null
            let goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, keepShot)
            // No local step is safer (e.g. boxed in by ranged fire while the
            // current square is only "safe" by adjacency): a wounded piece should
            // not stand and die — head home to the king's aura to heal instead.
            if (goal === null && wounded && !inAura && kc && kind !== 'pawn') {
              goal = nearestHealingCell(ctx, e, team, kc)
            }
            setPreserveGoal(
              goal,
              goal === null
                ? 'self-preservation: no safer step — holding'
                : `self-preservation retreat → ${coordName(goal.x, goal.y, ctx.board.height)}`,
            )
            continue
          } else {
            // Safe or healing: hold rather than drift, and let the aura work.
            setPreserveGoal(
              null,
              order.kind === 'none'
                ? 'self-preservation: safe — holding'
                : 'self-preservation: safe — resuming order',
            )
            continue
          }
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
          motion.intent = motion.goal === null ? 'none' : 'order'
          continue
        }
        // The order is done; the next queued step takes over, else clear. The
        // stance is kept so the piece stays in Attack either way.
        if (promoteNext(order, motion)) {
          noteOrder(order, ctx.tick, 'attack target lost — executing queued step')
          rechain(ctx, e, order)
          continue
        }
        noteOrder(order, ctx.tick, 'attack target lost — order complete')
        order.kind = 'none'
        order.target = null
        order.resumeTarget = null
        order.resumeTurn = -1
      }

      // 2. Goto order: advance toward the objective (best effort if unreachable).
      // A move fully replaces any earlier attack; there is no parked target to
      // resume and no kiting away from the ordered square.
      if (order.kind === 'goto') {
        const arrived =
          order.dest !== null && order.dest.x === cell.x && order.dest.y === cell.y && !motion.moving
        // A fulfilled waypoint yields to the queue. A waypoint this piece's
        // geometry can never reach is skipped too (best-effort would idle
        // forever); a waypoint merely blocked by pieces keeps waiting.
        const unreachable = order.dest !== null && !destReachable(ctx, e, order.dest)
        if (arrived || (unreachable && order.queue.length > 0)) {
          if (promoteNext(order, motion)) {
            noteOrder(
              order,
              ctx.tick,
              unreachable && !arrived ? 'waypoint unreachable — skipped' : 'move complete — executing queued step',
            )
            rechain(ctx, e, order)
            if (unreachable && !arrived) ctx.bus.emit('warn', `#${e} skipping unreachable waypoint`)
            continue
          }
        }
        // Not there yet: keep advancing (a blocked, pathless piece simply waits).
        if (!arrived) {
          motion.goal = order.dest
          motion.intent = 'order'
          continue
        }

        // Arrived: the move is complete; the next queued step takes over, else clear.
        if (promoteNext(order, motion)) {
          noteOrder(order, ctx.tick, 'move complete — executing queued step')
          rechain(ctx, e, order)
          continue
        }
        noteOrder(order, ctx.tick, 'move complete')
        order.kind = 'none'
        order.dest = null
        order.resumeTarget = null
        order.resumeTurn = -1
        motion.goal = null
        motion.intent = 'none'
        continue
      }

      // 3. Autonomous stance.
      const controller = ctx.teams[team].controller
      const mode = controller === 'ai' ? 'attack' : stance.mode

      if (mode !== 'attack') {
        motion.goal = null
        motion.intent = 'none'
        continue
      }

      // The AI king defends its post instead of charging with the army.
      if (controller === 'ai' && ctx.world.get(e, PieceType)?.kind === 'king') {
        motion.goal = aiKingGoal(ctx, e, team, kingThreats(ctx, e, team, kingThreatMemo))
        motion.intent = motion.goal === null ? 'none' : 'defense'
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
            motion.intent = 'none'
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
            motion.intent = motion.goal === null ? 'none' : 'defense'
            continue
          }
        }
      }

      if (targetValid && hpRatio < preserveThreshold(kind ?? '')) {
        // Low HP (auto-preserve off): seek nearby cover, keeping the shot if free.
        // Pawns cannot retreat, so they hold and fire instead.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        motion.goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, target.entity as number)
        motion.intent = motion.goal === null ? 'none' : 'preserve'
        continue
      }
      if (!targetValid) {
        // AI armies advance; a player's Attack stance skirmishes locally.
        motion.goal = controller === 'ai' ? rally(ctx, team) : null
        motion.intent = motion.goal === null ? 'none' : 'rally'
        continue
      }
      // Leash: don't chase an auto-acquired target clear across the board.
      const tcell = ctx.world.get(target.entity as number, Cell)
      const beyondLeash =
        tcell !== undefined &&
        chebyshev(cell.x, cell.y, tcell.x, tcell.y) > ATTACK_LEASH &&
        !inFiringGeometry(ctx, e, target.entity as number, team)
      motion.goal = beyondLeash ? null : pursue(ctx, e, target.entity as number, team)
      motion.intent = motion.goal === null ? 'none' : 'engage'
    }
  },
}

export default system
