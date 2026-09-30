import { moveDestinations } from '../../game/geometry'
import { enemyCoverage } from '../../game/kingSafety'
import { lerp, vecEquals } from '../../game/math'
import { buildOccupancy, occupiedExcept } from '../../game/occupancy'
import { PIECES } from '../../game/pieces'
import { THREAT_TOLERANCE } from '../../game/constants'
import { orderInsists } from '../../game/noPreserve'
import { Cell, Motion, Order, PieceType, Position, Team } from '../components'
import type { Entity } from '../world'
import type { System } from '../pipeline'
import { pieceDanger, threatAvoid } from './preservation'

const system: System = {
  name: 'movement',
  update(ctx) {
    const board = ctx.board
    const occupancy = buildOccupancy(ctx.world, board)

    // Serialized turns: only one piece moves at a time so a turn (and its
    // replay) reads as a sequence of individual moves rather than a blur.
    let anyMoving = false
    if (ctx.turnActive) {
      for (const e of ctx.world.query(Motion)) {
        if (ctx.world.get(e, Motion)?.moving) {
          anyMoving = true
          break
        }
      }
    }

    const movers = ctx.world.query(Motion, Cell, Position, PieceType, Team, Order)
    // Self-preservation is a reaction to fire, not part of the AI's matching-moves
    // exchange. When the budget is in play, serve a retreating AI piece before
    // every other mover so an earlier autonomous advance cannot spend the turn's
    // only allowance and leave a piece that is being shot sitting in the line.
    // Scoped to an AI team facing a human so free and AI-vs-AI play are untouched;
    // entity id breaks ties, keeping the order deterministic across replays.
    const retreatFirst = (e: Entity): boolean => {
      if (ctx.world.get(e, Motion)?.intent !== 'preserve') return false
      const t = ctx.world.get(e, Team)
      if (!t || ctx.teams[t].controller !== 'ai') return false
      return ctx.teams[t === 'red' ? 'blue' : 'red'].controller === 'human'
    }
    movers.sort((a, b) => (retreatFirst(a) ? 0 : 1) - (retreatFirst(b) ? 0 : 1) || a - b)

    for (const e of movers) {
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const pos = ctx.world.require(e, Position)
      const kind = ctx.world.require(e, PieceType).kind
      const team = ctx.world.require(e, Team)
      const order = ctx.world.require(e, Order)
      const def = PIECES[kind]
      if (!def) continue

      motion.cooldown = Math.max(0, motion.cooldown - ctx.dt)

      if (motion.moving) {
        motion.elapsed += ctx.dt
        const raw = motion.travel > 0 ? Math.min(1, Math.max(0, motion.elapsed / motion.travel)) : 1
        // A capture-advance glide eases in and out; ordinary steps are linear.
        const t = motion.ease ? raw * raw * (3 - 2 * raw) : raw
        pos.x = lerp(motion.fromX, motion.toX, t)
        pos.y = lerp(motion.fromY, motion.toY, t)
        if (raw >= 1) {
          motion.moving = false
          pos.x = motion.toX
          pos.y = motion.toY
          // Release the origin only now that the piece has actually arrived.
          occupancy.delete(board.cellIndex(cell.x, cell.y))
          const dest = board.worldToCell(motion.toX, motion.toY)
          motion.prevCell = { x: cell.x, y: cell.y }
          cell.x = dest.x
          cell.y = dest.y
          motion.reserved = null
          occupancy.set(board.cellIndex(dest.x, dest.y), e)
          motion.cooldown = motion.freeAdvance ? 0 : def.moveCooldown
          motion.ease = false
          motion.freeAdvance = false
          motion.arrived = motion.path.length === 0
        }
        continue
      }

      if (ctx.turnActive && (motion.movedThisTurn || anyMoving)) continue
      // AI move budget: an AI team facing a human may not out-move them within a
      // turn. It may make at most as many moves this turn as the human has, and
      // always at least one, so a passive player cannot freeze the AI. Nothing
      // carries over, so a blocked AI never bursts later. In AI-vs-AI both sides
      // are free. Player-issued orders bypass the budget, so you can command
      // enemy pieces directly. The finishing phase is exempt: once either side is
      // down to its king, the AI must be free to press the kill — and its own
      // king free to last-stand — even when the player makes no moves. This runs
      // in serialized turns *and* continuous "mega" play (Play mode), where the
      // beat's counters are reset at `beginMegaTurn`, so free play cannot swarm.
      if (ctx.teams[team].controller === 'ai' && order.kind === 'none') {
        const other = team === 'red' ? 'blue' : 'red'
        const endgame = ctx.teams[team].kingOnlySince >= 0 || ctx.teams[other].kingOnlySince >= 0
        if (!endgame && ctx.teams[other].controller === 'human') {
          const allowance = Math.max(ctx.teams[other].movesThisTurn, 1)
          if (ctx.teams[team].movesThisTurn >= allowance) continue
        }
      }
      if (motion.cooldown > 0) continue
      if (motion.path.length === 0) {
        motion.arrived = true
        continue
      }

      // The next route cell must still be a legal one-move destination for this
      // piece's geometry given the live board (only knights may leap blockers).
      const blocked = occupiedExcept(board, occupancy, e)
      const next = motion.path[0]
      const legal = moveDestinations(board, cell, def.move, team, blocked)
      const canStep = legal.some((c) => vecEquals(c, next))
      if (!canStep || blocked(next.x, next.y)) {
        motion.blocked = true
        // An attack route is re-planned by the pathfinding system (against live
        // occupancy, then best-effort, then theoretical), so keep it for this
        // tick rather than blanking it; non-attack routes clear and re-plan here.
        if (order.kind !== 'attack') {
          motion.replanAt = Math.min(motion.replanAt, ctx.tick + 4)
          motion.path = []
        }
        continue
      }
      // A king may never walk into check: refuse a hop onto a covered square and
      // let pathfinding re-route next tick.
      if (kind === 'king' && enemyCoverage(board, ctx.world, occupancy, e, team).has(board.cellIndex(next.x, next.y))) {
        motion.blocked = true
        motion.replanAt = Math.min(motion.replanAt, ctx.tick + 4)
        motion.path = []
        continue
      }
      // Every piece refuses a hop into enemy fire above the small threat
      // tolerance, then re-plans. This is the backstop for a route saved before
      // a firing line opened (a forked/resumed game, or an enemy that moved in
      // during the turn), and it now covers explicit orders too, so a click is
      // not carried into a kill zone. The player can Alt-click to insist, a
      // deliberate screen or a necessary lone-king finish (`threatExempt`) is
      // exempt, and a preserve retreat keeps the narrower lethal guard so it can
      // still escape through heavy-but-survivable fire. Within the tolerance a
      // scratch is still allowed.
      if (!motion.threatExempt && !orderInsists(order, ctx.turn)) {
        const danger = pieceDanger(ctx, e, team)
        const refusing =
          motion.intent === 'preserve'
            ? danger.lethal(next.x, next.y)
            : threatAvoid(ctx, danger, THREAT_TOLERANCE, cell)(next.x, next.y)
        if (refusing) {
          motion.blocked = true
          motion.replanAt = Math.min(motion.replanAt, ctx.tick + 4)
          motion.path = []
          continue
        }
      }

      motion.path.shift()
      const center = board.cellCenter(next.x, next.y)
      // A real step breaks the hit streak: damage-aware retreats only apply to a
      // piece that has stayed put through them.
      motion.hitStreak = 0
      motion.fromX = pos.x
      motion.fromY = pos.y
      motion.toX = center.x
      motion.toY = center.y
      const span = Math.max(Math.abs(next.x - cell.x), Math.abs(next.y - cell.y))
      motion.travel = Math.min(def.moveCooldown, 0.08 + 0.05 * span)
      motion.elapsed = 0
      motion.moving = true
      motion.ease = false
      motion.freeAdvance = false
      if (ctx.turnActive) anyMoving = true
      motion.arrived = false
      motion.blocked = false
      motion.movedThisTurn = true
      ctx.teams[team].movesThisTurn++
      ctx.teams[team].movesMade++
      motion.reserved = { x: next.x, y: next.y }
      motion.steps++
      occupancy.set(board.cellIndex(next.x, next.y), e)
    }
  },
}

export default system
