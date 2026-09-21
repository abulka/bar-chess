import { containsCell, fireCells } from '../../game/geometry'
import { makeOccupied } from '../../game/occupancy'
import { PIECES, WEAPONS } from '../../game/pieces'
import { Cell, Intent, Motion, PieceType, Target, Team } from '../components'
import type { IntentData, MotionData, TargetData } from '../components'
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

function rally(ctx: SimContext, team: 'red' | 'blue', intent: IntentData): { x: number; y: number } | null {
  if (intent.dest) return intent.dest
  const enemy = team === 'red' ? 'blue' : 'red'
  const lanes = ctx.board.data.lanes[enemy]
  return lanes.length > 0 ? lanes[Math.floor(lanes.length / 2)] : null
}

/** Advance on the current target until it enters the firing geometry, then hold. */
function engage(
  ctx: SimContext,
  e: Entity,
  motion: MotionData,
  target: TargetData,
  intent: IntentData,
  team: 'red' | 'blue',
): void {
  const valid = target.entity !== null && ctx.world.isAlive(target.entity) && ctx.world.has(target.entity, Cell)
  if (!valid) {
    motion.goal = rally(ctx, team, intent)
    return
  }
  if (inFiringGeometry(ctx, e, target.entity as number, team)) {
    motion.goal = null
  } else {
    const tcell = ctx.world.require(target.entity as number, Cell)
    motion.goal = { x: tcell.x, y: tcell.y }
  }
}

const system: System = {
  name: 'ai',
  update(ctx) {
    for (const e of ctx.world.query(Intent, Motion, Cell, Team, Target)) {
      const intent = ctx.world.require(e, Intent)
      const motion = ctx.world.require(e, Motion)
      const target = ctx.world.require(e, Target)
      const team = ctx.world.require(e, Team)

      if (ctx.teams[team].controller === 'ai') {
        engage(ctx, e, motion, target, intent, team)
        continue
      }

      if (intent.mode === 'hold') {
        motion.goal = null
      } else if (intent.mode === 'move') {
        motion.goal = intent.dest
      } else {
        engage(ctx, e, motion, target, intent, team)
      }
    }
  },
}

export default system
