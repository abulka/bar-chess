import { containsCell, fireCells, moveDestinations } from '../../game/geometry'
import { makeOccupied } from '../../game/occupancy'
import { bestFiringCell } from '../../game/approach'
import { PIECES, WEAPONS } from '../../game/pieces'
import { Cell, Health, Motion, Order, PieceType, Stance, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

const FLEE_HP = 0.3

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

/**
 * Stop and shoot when in geometry; otherwise move to a cell from which the
 * target can be hit (not onto the occupied target itself, which would deadlock).
 */
function pursue(ctx: SimContext, e: Entity, target: Entity, team: 'red' | 'blue'): { x: number; y: number } | null {
  if (inFiringGeometry(ctx, e, target, team)) return null
  const def = PIECES[ctx.world.require(e, PieceType).kind]
  if (!def) return null
  const cell = ctx.world.require(e, Cell)
  const tcell = ctx.world.require(target, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const best = bestFiringCell(ctx.board, cell, tcell, def.move, WEAPONS[def.weapon].geometry, team, occupied)
  return best ?? { x: tcell.x, y: tcell.y }
}

/** Best one-move cell that increases distance from the threat. */
function fleeCell(ctx: SimContext, e: Entity, team: 'red' | 'blue', threat: Entity): { x: number; y: number } | null {
  const kind = ctx.world.require(e, PieceType).kind
  const def = PIECES[kind]
  if (!def) return null
  const cell = ctx.world.require(e, Cell)
  const tc = ctx.world.get(threat, Cell)
  if (!tc) return null
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const options = moveDestinations(ctx.board, cell, def.move, team, occupied)
  let best: { x: number; y: number } | null = null
  let bestDist = -Infinity
  for (const c of options) {
    const d = Math.hypot(c.x - tc.x, c.y - tc.y)
    if (d > bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function rally(ctx: SimContext, team: 'red' | 'blue'): { x: number; y: number } | null {
  const enemy = team === 'red' ? 'blue' : 'red'
  const lanes = ctx.board.data.lanes[enemy]
  return lanes.length > 0 ? lanes[Math.floor(lanes.length / 2)] : null
}

const system: System = {
  name: 'ai',
  update(ctx) {
    for (const e of ctx.world.query(Stance, Order, Motion, Cell, Team, Target)) {
      const stance = ctx.world.require(e, Stance)
      const order = ctx.world.require(e, Order)
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const team = ctx.world.require(e, Team)
      const target = ctx.world.require(e, Target)

      // 1. Explicit attack order: glue to the target until it dies.
      if (order.kind === 'attack') {
        const t = order.target
        if (t !== null && ctx.world.isAlive(t) && ctx.world.has(t, Cell)) {
          motion.goal = pursue(ctx, e, t, team)
          continue
        }
        order.kind = 'none'
        order.target = null
        // The order is done; the stance is kept so the piece stays in Attack.
      }

      // 2. Goto order: advance toward the objective (best effort if unreachable).
      if (order.kind === 'goto') {
        if (order.dest && order.dest.x === cell.x && order.dest.y === cell.y && !motion.moving) {
          order.kind = 'none'
          order.dest = null
          motion.goal = null
        } else {
          motion.goal = order.dest
        }
        continue
      }

      // 3. Autonomous stance.
      const controller = ctx.teams[team].controller
      const mode = controller === 'ai' ? 'attack' : stance.mode

      if (mode !== 'attack') {
        motion.goal = null
        continue
      }

      const hp = ctx.world.get(e, Health)
      const hpRatio = hp && hp.max > 0 ? hp.cur / hp.max : 1
      const targetValid =
        target.entity !== null && ctx.world.isAlive(target.entity) && ctx.world.has(target.entity, Cell)

      if (targetValid && hpRatio < FLEE_HP) {
        motion.goal = fleeCell(ctx, e, team, target.entity as number)
        continue
      }
      if (!targetValid) {
        // AI armies advance; a player's Attack stance skirmishes locally.
        motion.goal = controller === 'ai' ? rally(ctx, team) : null
        continue
      }
      motion.goal = pursue(ctx, e, target.entity as number, team)
    }
  },
}

export default system
