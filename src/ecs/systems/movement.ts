import { moveDestinations } from '../../game/geometry'
import { lerp } from '../../game/math'
import { buildOccupancy, cellIndex, occupiedExcept } from '../../game/occupancy'
import { PIECES } from '../../game/pieces'
import { Cell, Motion, Order, PieceType, Position, Team } from '../components'
import type { System } from '../pipeline'

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

    for (const e of ctx.world.query(Motion, Cell, Position, PieceType, Team, Order)) {
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
        const t = motion.travel > 0 ? Math.min(1, motion.elapsed / motion.travel) : 1
        pos.x = lerp(motion.fromX, motion.toX, t)
        pos.y = lerp(motion.fromY, motion.toY, t)
        if (t >= 1) {
          motion.moving = false
          pos.x = motion.toX
          pos.y = motion.toY
          // Release the origin only now that the piece has actually arrived.
          occupancy.delete(cellIndex(board, cell.x, cell.y))
          const dest = board.worldToCell(motion.toX, motion.toY)
          cell.x = dest.x
          cell.y = dest.y
          motion.reserved = null
          occupancy.set(cellIndex(board, dest.x, dest.y), e)
          motion.cooldown = def.moveCooldown
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
      // enemy pieces directly.
      if (ctx.turnActive && ctx.teams[team].controller === 'ai' && order.kind === 'none') {
        const other = team === 'red' ? 'blue' : 'red'
        if (ctx.teams[other].controller === 'human') {
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
      const canStep = legal.some((c) => c.x === next.x && c.y === next.y)
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

      motion.path.shift()
      const center = board.cellCenter(next.x, next.y)
      motion.fromX = pos.x
      motion.fromY = pos.y
      motion.toX = center.x
      motion.toY = center.y
      const span = Math.max(Math.abs(next.x - cell.x), Math.abs(next.y - cell.y))
      motion.travel = Math.min(def.moveCooldown, 0.08 + 0.05 * span)
      motion.elapsed = 0
      motion.moving = true
      if (ctx.turnActive) anyMoving = true
      motion.arrived = false
      motion.blocked = false
      motion.movedThisTurn = true
      ctx.teams[team].movesThisTurn++
      ctx.teams[team].movesMade++
      motion.reserved = { x: next.x, y: next.y }
      motion.steps++
      occupancy.set(cellIndex(board, next.x, next.y), e)
    }
  },
}

export default system
