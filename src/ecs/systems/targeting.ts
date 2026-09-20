import { PIECES, WEAPONS, weaponVision } from '../../game/pieces'
import { Cell, PieceType, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

const RETARGET_TICKS = 12

function findTarget(ctx: SimContext, e: Entity, team: 'red' | 'blue'): Entity | null {
  const cell = ctx.world.require(e, Cell)
  const kind = ctx.world.require(e, PieceType).kind
  const def = PIECES[kind]
  if (!def) return null
  const vision = weaponVision(WEAPONS[def.weapon].geometry)
  const maxDist2 = vision * vision

  let best: Entity | null = null
  let bestDist = Infinity
  for (const other of ctx.world.query(Cell, Team)) {
    if (other === e) continue
    if (ctx.world.require(other, Team) === team) continue
    const oc = ctx.world.require(other, Cell)
    const d = (oc.x - cell.x) ** 2 + (oc.y - cell.y) ** 2
    if (d <= maxDist2 && d < bestDist) {
      bestDist = d
      best = other
    }
  }
  return best
}

const system: System = {
  name: 'targeting',
  update(ctx) {
    ctx.occupancy.clear()
    for (const e of ctx.world.query(Cell)) {
      const c = ctx.world.require(e, Cell)
      ctx.occupancy.set(c.y * ctx.board.width + c.x, e)
    }

    for (const e of ctx.world.query(Target, Cell, Team)) {
      const target = ctx.world.require(e, Target)
      const team = ctx.world.require(e, Team)
      const valid =
        target.entity !== null && ctx.world.isAlive(target.entity) && ctx.world.has(target.entity, Cell)

      if (!valid) {
        if (target.entity !== null) {
          target.entity = null
          target.retargetAt = Math.min(target.retargetAt, ctx.tick + 3)
        }
        if (ctx.tick >= target.retargetAt) {
          const found = findTarget(ctx, e, team)
          target.entity = found
          target.retargetAt = ctx.tick + RETARGET_TICKS
          if (found !== null) {
            ctx.bus.emit('target', `#${e} acquired #${found}`, { entity: e, team, data: { target: found } })
          }
        }
      } else if (ctx.tick >= target.retargetAt) {
        target.retargetAt = ctx.tick + RETARGET_TICKS
        const found = findTarget(ctx, e, team)
        if (found !== null && found !== target.entity) {
          const previous = target.entity
          target.entity = found
          ctx.bus.emit('target', `#${e} switched target #${previous} -> #${found}`, {
            entity: e,
            team,
            data: { target: found },
          })
        }
      }
    }
  },
}

export default system
