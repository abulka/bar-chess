import { containsCell, fireCells } from '../../game/geometry'
import { makeOccupied } from '../../game/occupancy'
import { PIECES, WEAPONS, projectileDef } from '../../game/pieces'
import type { Vec2 } from '../../game/types'
import { Cell, PieceType, Position, Projectile, Target, Team, Weapon } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

function spawnProjectile(
  ctx: SimContext,
  owner: Entity,
  team: 'red' | 'blue',
  weaponKey: string,
  target: Entity,
  targetCell: Vec2,
): Entity {
  const weapon = WEAPONS[weaponKey]
  const def = projectileDef(weapon.projectile)
  const pos = ctx.world.require(owner, Position)
  const fromCell = ctx.world.require(owner, Cell)
  const targetCenter = ctx.board.cellCenter(targetCell.x, targetCell.y)

  let waypoints: Vec2[]
  if (def.trajectory === 'jump') {
    const dx = targetCell.x - fromCell.x
    const dy = targetCell.y - fromCell.y
    const corner =
      Math.abs(dx) >= Math.abs(dy)
        ? ctx.board.cellCenter(fromCell.x + dx, fromCell.y)
        : ctx.board.cellCenter(fromCell.x, fromCell.y + dy)
    waypoints = [corner, targetCenter]
  } else if (def.trajectory === 'homing') {
    waypoints = []
  } else {
    waypoints = [targetCenter]
  }

  const p = ctx.world.create()
  ctx.world.add(p, Position, { x: pos.x, y: pos.y })
  ctx.world.add(p, Projectile, {
    team,
    damage: weapon.damage,
    ttl: def.ttl,
    maxTtl: def.ttl,
    speed: def.speed * ctx.board.tile,
    trajectory: def.trajectory,
    splash: def.splash,
    radius: def.radius,
    color: def.color,
    target,
    owner,
    waypoints,
    waypointIndex: 0,
  })
  return p
}

const system: System = {
  name: 'combat',
  update(ctx) {
    const occupied = makeOccupied(ctx.board, ctx.occupancy)

    for (const e of ctx.world.query(Weapon, Target, Cell, Position, Team, PieceType)) {
      const weapon = ctx.world.require(e, Weapon)
      if (weapon.left > 0) {
        weapon.left = Math.max(0, weapon.left - ctx.dt)
        continue
      }

      const target = ctx.world.require(e, Target).entity
      if (target === null || !ctx.world.isAlive(target) || !ctx.world.has(target, Cell)) continue

      const kind = ctx.world.require(e, PieceType).kind
      const def = PIECES[kind]
      if (!def) continue
      const wdef = WEAPONS[def.weapon]
      const team = ctx.world.require(e, Team)
      const cell = ctx.world.require(e, Cell)
      const tcell = ctx.world.require(target, Cell)

      const cells = fireCells(ctx.board, cell, wdef.geometry, team, occupied)
      if (!containsCell(cells, tcell.x, tcell.y)) continue

      const projectile = spawnProjectile(ctx, e, team, def.weapon, target, tcell)
      weapon.left = wdef.cooldown
      ctx.bus.emit('shot', `#${e} fired ${wdef.key} at #${target}`, {
        entity: e,
        team,
        data: { projectile, target, weapon: wdef.key },
      })
    }
  },
}

export default system
