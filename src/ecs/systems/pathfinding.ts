import { occupiedExcept } from '../../game/occupancy'
import { findPath } from '../../game/pathfind'
import { PIECES } from '../../game/pieces'
import { Cell, Motion, PieceType, Team } from '../components'
import type { System } from '../pipeline'

const system: System = {
  name: 'pathfinding',
  update(ctx) {
    let budget = ctx.pathBudget
    for (const e of ctx.world.query(Cell, Motion, PieceType)) {
      if (budget <= 0) break
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const kind = ctx.world.require(e, PieceType).kind
      const def = PIECES[kind]
      if (!def) continue

      const goal = motion.goal
      if (!goal) {
        if (motion.path.length > 0) {
          motion.path = []
          motion.blocked = false
        }
        continue
      }
      if (goal.x === cell.x && goal.y === cell.y) {
        motion.path = []
        continue
      }

      const last = motion.path.length > 0 ? motion.path[motion.path.length - 1] : null
      const goalChanged = !last || last.x !== goal.x || last.y !== goal.y
      const needsPlan = goalChanged || motion.path.length === 0
      if (!needsPlan || ctx.tick < motion.replanAt) continue

      budget--
      const team = ctx.world.require(e, Team)
      const occupied = occupiedExcept(ctx.board, ctx.occupancy, e)
      const result = findPath(ctx.board, cell, goal, def.move, team, occupied)
      motion.path = result.cells
      motion.replanAt = ctx.tick + (result.found ? 15 : 10)
      motion.blocked = !result.found
    }
  },
}

export default system
