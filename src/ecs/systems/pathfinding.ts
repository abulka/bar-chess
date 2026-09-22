import { occupiedExcept } from '../../game/occupancy'
import { findPath } from '../../game/pathfind'
import { PIECES } from '../../game/pieces'
import { Cell, Motion, Order, PieceType, Team } from '../components'
import type { System } from '../pipeline'

// Ordered-attack re-plan cadence in ticks: longer once a real route is found,
// shorter while the piece is boxed in so it reacts quickly as the board opens.
const ATTACK_REPLAN = 15
const ATTACK_REPLAN_BLOCKED = 8

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

      const order = ctx.world.get(e, Order)
      const isAttack = order?.kind === 'attack'
      // Live occupancy: other pieces block for real. An ordered attack prefers a
      // route it can walk right now and only falls back to a theoretical route
      // (other pieces assumed to move) when the live route makes no progress.
      const liveOccupied = occupiedExcept(ctx.board, ctx.occupancy, e)
      const next = motion.path.length > 0 ? motion.path[0] : null
      const nextOccupied = next !== null && liveOccupied(next.x, next.y)

      const last = motion.path.length > 0 ? motion.path[motion.path.length - 1] : null
      const goalChanged = !last || last.x !== goal.x || last.y !== goal.y
      // An attack route is re-derived continuously: pieces move every turn, so a
      // stored route is stale. Re-plan on a goal change, an empty or blocked
      // route, or simply when the cadence elapses — never keep the old route.
      const needsPlan = isAttack
        ? goalChanged ||
          motion.path.length === 0 ||
          nextOccupied ||
          motion.blocked ||
          ctx.tick >= motion.replanAt
        : goalChanged || motion.path.length === 0
      if (!needsPlan || ctx.tick < motion.replanAt) continue

      budget--
      const team = ctx.world.require(e, Team)

      if (isAttack) {
        const targetEnt = order.target
        const targetCell =
          targetEnt !== null && targetEnt !== undefined ? ctx.world.get(targetEnt, Cell) : undefined
        const live = findPath(ctx.board, cell, goal, def.move, team, liveOccupied)
        // Live route if it reaches the goal; otherwise a best-effort partial so
        // the piece still creeps toward it; otherwise a fresh theoretical route
        // (only the target's own square avoided) so the intended line stays
        // visible while fully boxed in. Always recomputed from the current cell.
        const result =
          live.found || live.cells.length > 0
            ? live
            : findPath(
                ctx.board,
                cell,
                goal,
                def.move,
                team,
                targetCell !== undefined
                  ? (x: number, y: number) => x === targetCell.x && y === targetCell.y
                  : liveOccupied,
              )
        motion.path = result.cells
        motion.blocked = !live.found
        motion.replanAt = ctx.tick + (live.found ? ATTACK_REPLAN : ATTACK_REPLAN_BLOCKED)
        continue
      }

      const result = findPath(ctx.board, cell, goal, def.move, team, liveOccupied)
      motion.path = result.cells
      motion.replanAt = ctx.tick + (result.found ? 15 : 10)
      motion.blocked = !result.found
    }
  },
}

export default system
