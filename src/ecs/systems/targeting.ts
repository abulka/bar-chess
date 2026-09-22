import { firingPositionExists } from '../../game/approach'
import { ATTACK_LEASH } from '../../game/constants'
import { fireCells } from '../../game/geometry'
import { buildOccupancy, makeOccupied } from '../../game/occupancy'
import { PIECES, WEAPONS, weaponVision } from '../../game/pieces'
import { Cell, Health, Order, PieceType, Stance, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

const RETARGET_TICKS = 12

function nearestInFireGeometry(
  ctx: SimContext,
  e: Entity,
  team: 'red' | 'blue',
  weaponKey: string,
): Entity | null {
  const cell = ctx.world.require(e, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const cells = fireCells(ctx.board, cell, WEAPONS[weaponKey].geometry, team, occupied)
  let best: Entity | null = null
  let bestDist = Infinity
  for (const c of cells) {
    const other = ctx.occupancy.get(c.y * ctx.board.width + c.x)
    if (other === undefined || other === e) continue
    if (ctx.world.get(other, Team) === team) continue
    const d = (c.x - cell.x) ** 2 + (c.y - cell.y) ** 2
    if (d < bestDist) {
      bestDist = d
      best = other
    }
  }
  return best
}

/**
 * Attack acquisition: nearest enemy within vision, biased toward damaged ones.
 * Sliders have board-wide vision, so the leash keeps Attack from chasing a
 * target clear across the map; the piece fights locally instead.
 */
function acquireAttack(ctx: SimContext, e: Entity, team: 'red' | 'blue', weaponKey: string): Entity | null {
  const cell = ctx.world.require(e, Cell)
  const vision = Math.min(weaponVision(WEAPONS[weaponKey].geometry), ATTACK_LEASH)
  const maxDist2 = vision * vision
  let best: Entity | null = null
  let bestScore = Infinity
  for (const other of ctx.world.query(Cell, Team, Health)) {
    if (other === e) continue
    if (ctx.world.require(other, Team) === team) continue
    const oc = ctx.world.require(other, Cell)
    const d2 = (oc.x - cell.x) ** 2 + (oc.y - cell.y) ** 2
    if (d2 > maxDist2) continue
    const hp = ctx.world.get(other, Health)
    const ratio = hp && hp.max > 0 ? hp.cur / hp.max : 1
    const score = Math.sqrt(d2) - (1 - ratio) * vision * 0.75
    if (score < bestScore) {
      bestScore = score
      best = other
    }
  }
  return best
}

function acquire(
  ctx: SimContext,
  e: Entity,
  team: 'red' | 'blue',
  weaponKey: string,
  aggressive: boolean,
): Entity | null {
  return aggressive
    ? acquireAttack(ctx, e, team, weaponKey)
    : nearestInFireGeometry(ctx, e, team, weaponKey)
}

const system: System = {
  name: 'targeting',
  update(ctx) {
    const built = buildOccupancy(ctx.world, ctx.board)
    ctx.occupancy.clear()
    for (const [key, value] of built) ctx.occupancy.set(key, value)

    for (const e of ctx.world.query(Target, Cell, Team, PieceType, Stance, Order)) {
      const target = ctx.world.require(e, Target)
      const order = ctx.world.require(e, Order)
      const stance = ctx.world.require(e, Stance)
      const team = ctx.world.require(e, Team)
      const kind = ctx.world.require(e, PieceType).kind
      const def = PIECES[kind]
      if (!def) continue
      const mode = ctx.teams[team].controller === 'ai' ? 'attack' : stance.mode

      // A specific attack order is sticky: keep the exact enemy until it dies.
      if (order.kind === 'attack') {
        const t = order.target
        if (t !== null && ctx.world.isAlive(t) && ctx.world.has(t, Cell)) {
          target.entity = t
          target.retargetAt = ctx.tick + RETARGET_TICKS
          // Keep the reachability flag current as the target moves.
          const cell = ctx.world.require(e, Cell)
          const tcell = ctx.world.get(t, Cell)
          if (tcell) {
            order.reachable = firingPositionExists(ctx.board, cell, tcell, def.move, WEAPONS[def.weapon].geometry, team)
          }
          continue
        }
        order.kind = 'none'
        order.target = null
        order.resumeTarget = null
        order.resumeTurn = -1
        target.entity = null
        // The order is done, but the stance is kept (the player can change it).
        continue
      }

      // Move never initiates an attack: only return fire while under fire.
      if (mode === 'move') {
        const attacker = target.lastAttacker
        target.entity =
          ctx.tick < target.underFireUntil && attacker !== null && ctx.world.isAlive(attacker)
            ? attacker
            : null
        continue
      }

      const valid =
        target.entity !== null && ctx.world.isAlive(target.entity) && ctx.world.has(target.entity, Cell)
      if (!valid) {
        if (target.entity !== null) {
          target.entity = null
          target.retargetAt = Math.min(target.retargetAt, ctx.tick + 3)
        }
        if (ctx.tick >= target.retargetAt) {
          const found = acquire(ctx, e, team, def.weapon, mode === 'attack')
          target.entity = found
          target.retargetAt = ctx.tick + RETARGET_TICKS
          if (found !== null) {
            ctx.bus.emit('target', `#${e} acquired #${found}`, { entity: e, team, data: { target: found } })
          }
        }
      } else if (ctx.tick >= target.retargetAt) {
        target.retargetAt = ctx.tick + RETARGET_TICKS
        const found = acquire(ctx, e, team, def.weapon, mode === 'attack')
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
