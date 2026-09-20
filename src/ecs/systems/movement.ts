import { MOVE_TRAVEL } from '../../game/constants'
import { lerp } from '../../game/math'
import { makeOccupied } from '../../game/occupancy'
import { PIECES } from '../../game/pieces'
import { Cell, Motion, PieceType, Position } from '../components'
import type { System } from '../pipeline'

const system: System = {
  name: 'movement',
  update(ctx) {
    const board = ctx.board
    const occupied = makeOccupied(board, ctx.occupancy)

    for (const e of ctx.world.query(Motion, Cell, Position, PieceType)) {
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const pos = ctx.world.require(e, Position)
      const kind = ctx.world.require(e, PieceType).kind
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
          const arrivedCell = board.worldToCell(motion.toX, motion.toY)
          cell.x = arrivedCell.x
          cell.y = arrivedCell.y
          motion.cooldown = def.moveCooldown
          motion.arrived = motion.path.length === 0
        }
        continue
      }

      if (motion.cooldown > 0) continue
      if (motion.path.length === 0) {
        motion.arrived = true
        continue
      }

      const next = motion.path[0]
      if (occupied(next.x, next.y) && (next.x !== cell.x || next.y !== cell.y)) {
        motion.blocked = true
        motion.replanAt = Math.min(motion.replanAt, ctx.tick + 4)
        motion.path = []
        continue
      }

      motion.path.shift()
      const center = board.cellCenter(next.x, next.y)
      motion.fromX = pos.x
      motion.fromY = pos.y
      motion.toX = center.x
      motion.toY = center.y
      motion.travel = Math.min(MOVE_TRAVEL, def.moveCooldown)
      motion.elapsed = 0
      motion.moving = true
      motion.arrived = false
      cell.x = next.x
      cell.y = next.y
    }
  },
}

export default system
