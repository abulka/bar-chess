import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Motion, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { hasLivingKing } from '../../src/game/endgame'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { PIECES } from '../../src/game/pieces'
import { clearComponents } from '../helpers'

function shim(game: Game): SimContext {
  return { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
}

function stripArmy(game: Game): void {
  for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
}

/**
 * Red king a8 is mated by a blue rook on the a-file and a blue king on c7. The
 * blue king covers the two escape squares and defends nothing the red king can
 * reach, so the trap is genuine.
 */
function matePosition(game: Game): { redKing: number; blueRook: number } {
  stripArmy(game)
  const redKing = createPiece(shim(game), 'red', PIECES.king, { x: 0, y: 0 })
  const blueRook = createPiece(shim(game), 'blue', PIECES.rook, { x: 0, y: 7 })
  createPiece(shim(game), 'blue', PIECES.king, { x: 2, y: 1 })
  game.teams.red.alive = { king: 1 }
  game.teams.blue.alive = { king: 1, rook: 1 }
  return { redKing, blueRook }
}

describe('checkmate resolution', () => {
  beforeEach(() => clearComponents())

  it('ends the game at the mate in a study run (mateEndsGame)', () => {
    const game = new Game(8, 'ai-vs-ai')
    game.mateEndsGame = true
    matePosition(game)

    game.runTicks(1)

    expect(game.winner).toBe('blue')
    expect(game.over).toBe(true)
    // The result came from the mate, not a king death: the king still stands.
    expect(hasLivingKing(game, 'red')).toBe(true)
  })

  it('leaves a live game undecided so the player keeps shooting turn by turn', () => {
    const game = new Game(8, 'ai-vs-ai')
    const { redKing, blueRook } = matePosition(game)
    game.world.require(redKing, Health).cur = 10
    game.world.require(blueRook, Weapon).left = 0

    game.runTicks(1)

    // The mate is flagged and movement is frozen, but the game is not over: the
    // player chooses whether to take another turn.
    expect(game.checkmate.red).toBe(true)
    expect(game.winner).toBe(null)
    expect(game.over).toBe(false)

    let guard = 0
    while (hasLivingKing(game, 'red') && guard++ < 40) {
      game.beginTurn()
      let inner = 0
      while (game.turnActive && inner++ < 2000) game.runTicks(1)
    }

    expect(hasLivingKing(game, 'red')).toBe(false)
    expect(game.winner).toBe('blue')
  })

  it('is a draw when both kings are mated on the same tick', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    // Red king a8 mated by the blue file rook, its escapes covered by the second
    // blue rook on the b-file.
    createPiece(shim(game), 'red', PIECES.king, { x: 0, y: 0 })
    createPiece(shim(game), 'blue', PIECES.rook, { x: 0, y: 7 })
    createPiece(shim(game), 'blue', PIECES.rook, { x: 1, y: 7 })
    // Blue king h1 mated by a red file rook, a bishop check and a knight covering
    // the last escape.
    createPiece(shim(game), 'blue', PIECES.king, { x: 7, y: 7 })
    createPiece(shim(game), 'red', PIECES.rook, { x: 7, y: 0 })
    createPiece(shim(game), 'red', PIECES.bishop, { x: 5, y: 5 })
    createPiece(shim(game), 'red', PIECES.knight, { x: 4, y: 6 })
    game.teams.red.alive = { king: 1, rook: 1, bishop: 1, knight: 1 }
    game.teams.blue.alive = { king: 1, rook: 2 }

    game.runTicks(1)

    expect(game.drawn).toBe(true)
    expect(game.winner).toBe(null)
  })

  it('does not report a mate while a piece is mid-hop', () => {
    const game = new Game(8, 'ai-vs-ai')
    const { blueRook } = matePosition(game)
    const motion = game.world.require(blueRook, Motion)

    motion.moving = true
    expect(game.snapshot().checkmate.red).toBe(false)

    motion.moving = false
    expect(game.snapshot().checkmate.red).toBe(true)
  })
})
