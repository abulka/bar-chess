import { Cell, Health, Motion, Order, PieceType, Position, Render, Stance, Target, Team, Weapon } from '../ecs/components'
import type { Entity } from '../ecs/world'
import type { SimContext } from '../ecs/types'
import { TEAM_COLORS } from './constants'
import type { PieceDef } from './pieces'
import type { Vec2 } from './types'

export function createPiece(ctx: SimContext, team: 'red' | 'blue', def: PieceDef, cell: Vec2): Entity {
  const world = ctx.world
  const e = world.create()
  const center = ctx.board.cellCenter(cell.x, cell.y)

  world.add(e, Position, { x: center.x, y: center.y })
  world.add(e, Cell, { x: cell.x, y: cell.y })
  world.add(e, Team, team)
  world.add(e, PieceType, { kind: def.key })
  world.add(e, Render, { glyph: def.glyph, tint: TEAM_COLORS[team], size: def.size })
  world.add(e, Health, { cur: def.hp, max: def.hp })
  world.add(e, Stance, { mode: 'none' })
  world.add(e, Order, { kind: 'none', dest: null, target: null })
  world.add(e, Target, { entity: null, retargetAt: 0, lastAttacker: null, underFireUntil: 0 })
  world.add(e, Weapon, { left: ctx.rng.range(0, 0.5) })
  world.add(e, Motion, {
    goal: null,
    reserved: null,
    path: [],
    fromX: center.x,
    fromY: center.y,
    toX: center.x,
    toY: center.y,
    travel: 0,
    elapsed: 0,
    moving: false,
    cooldown: ctx.rng.range(0, def.moveCooldown),
    arrived: true,
    replanAt: 0,
    blocked: false,
    steps: 0,
    movedThisTurn: false,
  })
  return e
}
