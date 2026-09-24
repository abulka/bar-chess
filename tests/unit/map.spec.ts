import { beforeEach, describe, expect, it } from 'vitest'
import { Game } from '../../src/game/game'
import { buildMapBoard, emptyMap, exportMap, mapPieceCounts, validateMap } from '../../src/game/map'
import { clearComponents } from '../helpers'

describe('saved maps', () => {
  beforeEach(() => clearComponents())

  it('exports the live board and pieces, then reloads them exactly', () => {
    const game = new Game(8, 'human-vs-ai', 7)
    const map = exportMap(game, 'test map')

    expect(map.placements).toHaveLength(32)
    expect(mapPieceCounts(map)).toEqual({ red: 16, blue: 16 })
    expect(validateMap(map).ok).toBe(true)

    const reloaded = new Game(8)
    reloaded.loadMap(map, 7)
    expect(reloaded.board.data.name).toBe('test map')
    expect(reloaded.board.width).toBe(8)
    expect(exportMap(reloaded, 'again').placements).toEqual(map.placements)
  })

  it('rejects malformed maps', () => {
    const map = emptyMap(8)
    expect(validateMap(map).ok).toBe(true)
    expect(validateMap(null).ok).toBe(false)
    expect(validateMap({ ...map, version: 99 }).ok).toBe(false)
    expect(validateMap({ ...map, board: { ...map.board, terrain: [0] } }).ok).toBe(false)
    expect(validateMap({ ...map, placements: [{ team: 'red', key: 'dragon', x: 0, y: 0 }] }).ok).toBe(false)
    expect(validateMap({ ...map, placements: [{ team: 'red', key: 'pawn', x: 99, y: 0 }] }).ok).toBe(false)
    const overlap = {
      ...map,
      placements: [
        { team: 'red', key: 'pawn', x: 0, y: 0 },
        { team: 'blue', key: 'pawn', x: 0, y: 0 },
      ],
    }
    expect(validateMap(overlap).ok).toBe(false)
  })

  it('builds a board from map data', () => {
    const board = buildMapBoard(emptyMap(8))
    expect(board.width).toBe(8)
    expect(board.terrainAt(0, 0)).toBe(0)
  })
})
