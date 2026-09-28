import { Cell, Health, PieceType, Team } from '../components'
import { TEAM_IDS } from '../../game/constants'
import { DEFENDED_HEAL_RATE, friendlyCoverageCells } from '../../game/defended'
import { HEAL_RATE, HUMAN_HEAL_MULTIPLIER, healingTargets } from '../../game/healing'
import { buildOccupancy } from '../../game/occupancy'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

/** Add one tick of regeneration to a damaged piece, clamped at max and never reviving. */
function regen(ctx: SimContext, e: Entity, rate: number): void {
  const health = ctx.world.get(e, Health)
  if (!health || health.cur <= 0 || health.cur >= health.max) return
  health.cur = Math.min(health.max, health.cur + health.max * rate * ctx.dt)
}

/**
 * Regeneration. King aura: same-team pieces within two Chebyshev cells of their
 * living king (excluding the king, the aura source) regain 5% of max HP per
 * second. Defended healing (rule `defendedHeal`, default on): a piece whose
 * square is covered by a friendly weapon — chess-protected — regenerates 2.5% of
 * max HP per second, wherever it stands; the king is never a recipient. The two
 * stack. Human-controlled teams regenerate `HUMAN_HEAL_MULTIPLIER` times faster.
 * Runs on the settled living set (after cleanup), clamps at max, and never
 * revives a piece at zero HP. Deterministic — it only advances by `ctx.dt` — so
 * it is captured by turn snapshots and replays exactly.
 */
const system: System = {
  name: 'healing',
  update(ctx) {
    for (const team of TEAM_IDS) {
      const rate = ctx.teams[team].controller === 'human' ? HUMAN_HEAL_MULTIPLIER : 1
      const field = healingTargets(ctx.world, team)
      if (field) for (const e of field.targets) regen(ctx, e, HEAL_RATE * rate)
      if (!ctx.defendedHeal) continue
      // Movement has already run this tick, so `ctx.occupancy` (rebuilt at
      // targeting) no longer matches the pieces' current cells: rebuild it.
      const occupied = buildOccupancy(ctx.world, ctx.board)
      const covered = friendlyCoverageCells(ctx.board, ctx.world, occupied, team)
      for (const e of ctx.world.query(Cell, Team, Health, PieceType)) {
        if (ctx.world.require(e, Team) !== team) continue
        if (ctx.world.require(e, PieceType).kind === 'king') continue
        const cell = ctx.world.require(e, Cell)
        if (!covered.has(ctx.board.cellIndex(cell.x, cell.y))) continue
        regen(ctx, e, DEFENDED_HEAL_RATE * rate)
      }
    }
  },
}

export default system
