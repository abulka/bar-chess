import { TEAM_COLORS, TEAM_IDS } from '../../game/constants'
import { PIECES } from '../../game/pieces'
import { clearOrder } from '../../game/queue'
import { Cell, Health, Motion, Order, PieceType, Render, Target, Team, Weapon } from '../components'
import type { System } from '../pipeline'

/**
 * Chess promotion: a pawn that reaches the enemy back rank becomes a queen.
 * Runs after movement and capture advance, so a pawn that arrives on its own
 * move or by capturing promotes on the same tick it lands. The new queen keeps
 * the pawn's current HP (a wounded pawn promotes to a wounded queen), gets the
 * queen's full maximum, a ready weapon, and cleared orders so it replans as a
 * queen. The team's living counts are updated so the HUD and stats stay right.
 */
const system: System = {
  name: 'promotion',
  update(ctx) {
    if (!ctx.promotion) return
    for (const team of TEAM_IDS) {
      const promoteRank = team === 'blue' ? 0 : ctx.board.height - 1
      for (const e of ctx.world.query(Cell, Team, PieceType, Health)) {
        if (ctx.world.require(e, Team) !== team) continue
        if (ctx.world.require(e, PieceType).kind !== 'pawn') continue
        if (!ctx.world.isAlive(e)) continue
        const cell = ctx.world.require(e, Cell)
        if (cell.y !== promoteRank) continue

        const def = PIECES.queen
        const pieceType = ctx.world.require(e, PieceType)
        pieceType.kind = def.key
        const render = ctx.world.get(e, Render)
        if (render) {
          render.glyph = def.glyph
          render.tint = TEAM_COLORS[team]
          render.size = def.size
        }
        const health = ctx.world.require(e, Health)
        health.max = def.hp
        if (health.cur > health.max) health.cur = health.max
        const weapon = ctx.world.get(e, Weapon)
        if (weapon) {
          weapon.left = 0
          weapon.fired = false
        }
        const order = ctx.world.get(e, Order)
        if (order) clearOrder(order, { queue: true })
        const motion = ctx.world.get(e, Motion)
        if (motion) {
          motion.goal = null
          motion.intent = 'none'
          motion.holdUntilHp = 0
          motion.reserved = null
          motion.path = []
          motion.moving = false
          motion.blocked = false
          motion.arrived = true
          motion.cooldown = 0
        }
        const target = ctx.world.get(e, Target)
        if (target) {
          target.entity = null
          target.retargetAt = 0
        }
        const alive = ctx.teams[team].alive
        alive.pawn = Math.max(0, (alive.pawn ?? 0) - 1)
        alive.queen = (alive.queen ?? 0) + 1

        ctx.bus.emit('promote', `#${e} pawn promoted to queen`, {
          entity: e,
          team,
          data: { cell: { x: cell.x, y: cell.y } },
        })
      }
    }
  },
}

export default system
