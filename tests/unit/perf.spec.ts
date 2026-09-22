import { beforeEach, describe, expect, it } from 'vitest'
import { previewFiringCell } from '../../src/game/approach'
import { Board } from '../../src/game/board'
import { createBoardData } from '../../src/game/boards'
import { Game } from '../../src/game/game'
import { PIECES, WEAPONS } from '../../src/game/pieces'
import { clearComponents } from '../helpers'

/**
 * Generous wall-clock guards. They are not micro-benchmarks: the thresholds sit
 * far above normal cost but far below the old per-candidate-A* behaviour, so a
 * regression of this magnitude fails loudly without punishing slow CI machines.
 */
describe('performance guards', () => {
  beforeEach(() => clearComponents())

  it('plans an unreachable long-range attack in a single pass', () => {
    const board = new Board(createBoardData(64))
    const from = { x: 4, y: 4 }
    // Opposite colour to the bishop, so no approach cell is ever reachable.
    const target = { x: 5, y: 4 }
    const never = () => false
    const iterations = 50

    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) {
      const cell = previewFiringCell(board, from, target, PIECES.bishop.move, WEAPONS.bishopLance.geometry, 'blue', never)
      expect(cell).toBeNull()
    }
    const perCall = (performance.now() - t0) / iterations

    // Was ~50ms per call (one A* per approach cell); now well under 1ms.
    expect(perCall).toBeLessThan(5)
  })

  it(
    'runs 64x64 AI-vs-AI turns within a generous time budget',
    () => {
      const game = new Game(64, 'ai-vs-ai')

      const t0 = performance.now()
      for (let k = 0; k < 3; k++) {
        game.beginTurn()
        let guard = 0
        while (game.turnActive && guard++ < 3000) game.runTicks(1)
        expect(guard, 'turn did not settle').toBeLessThan(3000)
      }
      const elapsed = performance.now() - t0

      // Was ~80ms/tick (tens of seconds for three turns); now a few ms/tick.
      expect(elapsed).toBeLessThan(10_000)
    },
    15_000,
  )
})
