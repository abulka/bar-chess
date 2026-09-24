import { beforeEach, describe, expect, it } from 'vitest'
import { Game } from '../../src/game/game'
import { exportMap } from '../../src/game/map'
import type { TeamId } from '../../src/game/types'
import { clearComponents } from '../helpers'

function alive(game: Game, team: TeamId, key: string): number {
  return game.teams[team].alive[key] ?? 0
}

describe('map editor game api', () => {
  beforeEach(() => clearComponents())

  it('places and removes pieces, updating team counts', () => {
    const game = new Game(8, 'human-vs-ai', 1)
    const before = alive(game, 'red', 'queen')

    expect(game.placePiece('red', 'queen', 4, 4)).toBe(true)
    expect(game.pieceAt(4, 4)).not.toBeNull()
    expect(alive(game, 'red', 'queen')).toBe(before + 1)

    expect(game.placePiece('red', 'queen', 4, 4)).toBe(false)
    expect(game.removePieceAt(4, 4)).toBe(true)
    expect(alive(game, 'red', 'queen')).toBe(before)
  })

  it('refuses placement on walls or out of bounds', () => {
    const game = new Game(8, 'human-vs-ai', 1)
    game.paint(2, 2, 4)
    expect(game.placePiece('blue', 'pawn', 2, 2)).toBe(false)
    expect(game.placePiece('blue', 'pawn', 99, 0)).toBe(false)
    expect(game.canPlaceAt(3, 3)).toBe(true)
  })

  it('blocks edits while a turn is running', () => {
    const game = new Game(8, 'human-vs-ai', 1)
    game.beginTurn()
    expect(game.canEdit).toBe(false)
    expect(game.placePiece('red', 'queen', 4, 4)).toBe(false)
    expect(game.removePieceAt(0, 0)).toBe(false)
  })

  it('cancel restores the exact battle and history', () => {
    const game = new Game(8, 'human-vs-ai', 5)
    const before = exportMap(game, 'before').placements
    game.setEditor(true)
    expect(game.editorMode).toBe(true)
    game.placePiece('red', 'queen', 4, 4)
    game.removePieceAt(0, 0)
    expect(exportMap(game, 'edited').placements).not.toEqual(before)

    game.cancelEditor()
    expect(game.editorMode).toBe(false)
    expect(exportMap(game, 'after').placements).toEqual(before)
    expect(game.snapshot().canUndo).toBe(false)
  })

  it('keeps edits on close and records an undo boundary', () => {
    const game = new Game(8, 'human-vs-ai', 5)
    const before = alive(game, 'red', 'queen')
    game.setEditor(true)
    game.placePiece('red', 'queen', 4, 4)
    game.setEditor(false)

    expect(game.editorMode).toBe(false)
    expect(alive(game, 'red', 'queen')).toBe(before + 1)
    expect(game.snapshot().canUndo).toBe(true)

    game.undoTurn()
    expect(alive(game, 'red', 'queen')).toBe(before)
  })

  it('newMap starts a blank board in the editor', () => {
    const game = new Game(8, 'human-vs-ai', 1)
    game.newMap(16, 'blank')
    expect(game.editorMode).toBe(true)
    expect(game.board.width).toBe(16)
    expect(game.board.data.name).toBe('blank')
    expect(alive(game, 'red', 'pawn')).toBe(0)
  })
})
