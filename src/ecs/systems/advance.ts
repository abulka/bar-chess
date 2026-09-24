import { CAPTURE_ADVANCE_TRAVEL } from '../../game/constants'
import { containsCell, fireCells } from '../../game/geometry'
import { vecEquals } from '../../game/math'
import { buildOccupancy, makeOccupied } from '../../game/occupancy'
import { clearMotion } from '../../game/queue'
import { PIECES, WEAPONS } from '../../game/pieces'
import { Cell, Motion, Order, PieceType, Position, Stance, Team } from '../components'
import type { System } from '../pipeline'

/**
 * Chess-style capture advance: when a kill leaves the victim's square open, the
 * killer steps onto it along the firing ray it killed with. Runs after cleanup,
 * so the victim is already gone and its cell is free. The move is free (a
 * capture, not the piece's turn move), so it is only taken by an idle piece:
 * one with no active order, queue, planned path or hop in progress.
 *
 * The step is animated as a slow, eased glide rather than an instant teleport:
 * the killer's cell stays put until it arrives (exactly like a normal move), the
 * destination is reserved so nothing else can claim it, and the `movement`
 * system interpolates `Position` over `CAPTURE_ADVANCE_TRAVEL` seconds after a
 * short beat spent standing in the blast.
 */
const system: System = {
  name: 'advance',
  update(ctx) {
    const intents = ctx.cmds.advance
    if (intents.length === 0) return

    const board = ctx.board
    const occupancy = buildOccupancy(ctx.world, board)
    const used = new Set<number>()

    for (const intent of intents) {
      const killer = intent.killer
      if (used.has(killer)) continue
      if (!ctx.world.isAlive(killer)) continue
      if (
        !ctx.world.has(killer, Cell) ||
        !ctx.world.has(killer, Motion) ||
        !ctx.world.has(killer, Order) ||
        !ctx.world.has(killer, PieceType) ||
        !ctx.world.has(killer, Team)
      ) {
        continue
      }

      const cell = ctx.world.require(killer, Cell)
      const order = ctx.world.require(killer, Order)
      const motion = ctx.world.require(killer, Motion)
      if (order.queue.length > 0) continue
      if (motion.moving || motion.path.length > 0 || motion.reserved !== null || motion.goal !== null) continue
      // A standing order blocks the advance, except the attack order that just
      // killed this victim: it is about to complete, so the capture still lands.
      const attackOrderOnVictim = order.kind === 'attack' && order.target === intent.victim
      if (order.kind !== 'none' && !attackOrderOnVictim) continue

      // Capture advance is an Attack-mode behaviour only: a passive (none/move)
      // piece is never pulled off a safe or healing square by a kill.
      const team = ctx.world.require(killer, Team)
      const stance = ctx.world.get(killer, Stance)
      if (ctx.teams[team].controller !== 'ai' && stance?.mode !== 'attack' && order.kind !== 'attack') continue

      const dest = intent.cell
      if (vecEquals(dest, cell)) continue
      if (!board.passable(dest.x, dest.y)) continue
      const destIdx = board.cellIndex(dest.x, dest.y)
      const occupant = occupancy.get(destIdx)
      if (occupant !== undefined && occupant !== killer) continue

      const def = PIECES[ctx.world.require(killer, PieceType).kind]
      if (!def) continue
      // The victim stood on a firing ray; re-check the line is still clear so
      // the killer steps along a legal capture line, not over another piece.
      const occupied = makeOccupied(board, occupancy)
      if (!containsCell(fireCells(board, cell, WEAPONS[def.weapon].geometry, team, occupied), dest.x, dest.y)) {
        continue
      }

      occupancy.set(destIdx, killer)
      const center = board.cellCenter(dest.x, dest.y)
      const pos = ctx.world.get(killer, Position)
      const fromX = pos ? pos.x : center.x
      const fromY = pos ? pos.y : center.y
      clearMotion(motion)
      motion.path = []
      motion.reserved = { x: dest.x, y: dest.y }
      motion.blocked = false
      motion.arrived = false
      motion.moving = true
      motion.ease = true
      motion.freeAdvance = true
      motion.fromX = fromX
      motion.fromY = fromY
      motion.toX = center.x
      motion.toY = center.y
      motion.travel = CAPTURE_ADVANCE_TRAVEL
      // Start moving immediately, in step with the blast: no settling beat.
      motion.elapsed = 0
      used.add(killer)

      ctx.bus.emit('advance', `#${killer} advanced to ${dest.x},${dest.y}`, {
        entity: killer,
        team,
        data: { cell: dest },
      })
    }

    intents.length = 0
  },
}

export default system
