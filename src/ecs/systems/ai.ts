import { containsCell, fireCells } from '../../game/geometry'
import { makeOccupied } from '../../game/occupancy'
import { PIECES, WEAPONS } from '../../game/pieces'
import { Cell, Intent, Motion, PieceType, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

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

const system: System = {
  name: 'ai',
  update(ctx) {
    for (const e of ctx.world.query(Intent, Motion, Cell)) {
      const intent = ctx.world.require(e, Intent)
      const motion = ctx.world.require(e, Motion)
      const target = ctx.world.require(e, Target)

      if (intent.mode === 'hold') {
        motion.goal = null
        continue
      }

      if (intent.mode === 'move') {
        motion.goal = intent.dest
        continue
      }

      // fight: close on the target until it enters the firing geometry, then hold
      if (target.entity === null || !ctx.world.isAlive(target.entity)) {
        if (intent.dest) {
          motion.goal = intent.dest
        } else {
          const enemy = ctx.world.require(e, Team) === 'red' ? 'blue' : 'red'
          const lanes = ctx.board.data.lanes[enemy]
          motion.goal = lanes.length > 0 ? lanes[Math.floor(lanes.length / 2)] : null
        }
        continue
      }
      const team = ctx.world.require(e, Team)
      if (inFiringGeometry(ctx, e, target.entity, team)) {
        motion.goal = null
      } else {
        const tcell = ctx.world.require(target.entity, Cell)
        motion.goal = { x: tcell.x, y: tcell.y }
      }
    }
  },
}

export default system
