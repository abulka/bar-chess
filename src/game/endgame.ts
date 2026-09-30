import { Health, PieceType, Team } from '../ecs/components'
import type { Game } from './game'
import type { TeamId } from './types'

/**
 * Any living non-king piece on the team? False means the side is king-only.
 * Shared by the study batch's draw classification and the live game's
 * stalemate check.
 */
export function hasFieldPieces(game: Game, team: TeamId): boolean {
  for (const e of game.world.query(PieceType, Team, Health)) {
    if (game.world.require(e, Team) !== team) continue
    if (game.world.require(e, PieceType).kind === 'king') continue
    if (game.world.require(e, Health).cur <= 0) continue
    return true
  }
  return false
}

/** Is a living king of `team` on the board? */
export function hasLivingKing(game: Game, team: TeamId): boolean {
  for (const e of game.world.query(PieceType, Team, Health)) {
    if (game.world.require(e, Team) !== team) continue
    if (game.world.require(e, PieceType).kind !== 'king') continue
    if (game.world.require(e, Health).cur > 0) return true
  }
  return false
}

/**
 * True when neither side has a living non-king piece: no winning material is
 * left. The no-check rule keeps the two kings apart, so a lone king can never
 * force a kill — the position is dead.
 */
export function isKingOnlyDraw(game: Game): boolean {
  return !hasFieldPieces(game, 'red') && !hasFieldPieces(game, 'blue')
}
