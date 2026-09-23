import { beforeEach, describe, expect, it } from 'vitest'
import { Weapon } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { LLM_PREAMBLE } from '../../src/game/shorthand'
import { clearComponents, placePiece } from '../helpers'

const pieceLine = /^[rb][PNBRQK] /

describe('position shorthand', () => {
  beforeEach(() => clearComponents())

  it('renders the 8x8 opening compactly with a grid and legend', () => {
    const text = new Game(8).shorthand()
    const lines = text.split('\n')

    expect(lines[0]).toContain('# board-8 8x8 tick=0 turn=0 human-vs-ai you=blue')
    expect(lines[1]).toContain('red alive=16')
    expect(text).toContain('# grid')
    expect(text).toContain('  a b c d e f g h')
    expect(text).toContain('8 R N B Q K B N R')
    expect(text).toContain('1 r n b q k b n r')
    expect(text).toContain('# fmt:')
    expect(lines.filter((l) => pieceLine.test(l))).toHaveLength(32)
    expect(Buffer.byteLength(text)).toBeLessThan(2000)
  })

  it('drops the grid on large boards and stays small', () => {
    const text = new Game(64).shorthand()
    expect(text).not.toContain('# grid')
    expect(Buffer.byteLength(text)).toBeLessThan(2000)
  })

  it('shows stances, orders, targets and routes', () => {
    const attack = new Game(8)
    const queen = placePiece(attack, 'queen', 'blue', { x: 4, y: 4 })
    placePiece(attack, 'king', 'red', { x: 4, y: 5 })
    attack.world.require(queen, Weapon).left = 0
    attack.selected = [queen]
    attack.setPieceStance('attack')
    attack.orderAt({ x: 4, y: 5 })
    attack.runTicks(1)

    const text = attack.shorthand()
    expect(text).toMatch(/bQ e4 @A atk=#\d+\(e3\)/)
    expect(text).toMatch(/tgt=#\d+\(e3\)/)
    expect(text).toMatch(/note="attack ordered/)
    expect(text).toContain('# proj:')
    expect(text).toMatch(/# selected #\d+/)

    const move = new Game(8)
    const rook = placePiece(move, 'rook', 'blue', { x: 0, y: 7 })
    move.selected = [rook]
    move.setPieceStance('move')
    move.orderAt({ x: 0, y: 4 })
    expect(move.shorthand()).toMatch(/bR a1 @M goto=a4 goal=a4 path=a4/)
    expect(move.shorthand()).toMatch(/note="move ordered/)
  })

  it('lists only non-floor terrain by name', () => {
    const game = new Game(8)
    game.paint(3, 3, 4)
    expect(game.shorthand()).toContain('# terrain d5=wall')
  })

  it('prefixes the preamble for the LLM variant', () => {
    const game = new Game(8)
    const text = game.llmShorthand()
    expect(text.startsWith(LLM_PREAMBLE)).toBe(true)
    expect(text).toContain(game.shorthand())
  })
})
