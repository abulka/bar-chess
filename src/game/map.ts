import { Cell, PieceType, Position, Team } from '../ecs/components'
import { Board } from './board'
import type { MapData } from './board'
import type { BoardSize, Placement } from './boards'
import { createBoardData } from './boards'
import type { Game } from './game'
import { PIECES } from './pieces'
import type { ValidationResult } from './position'
import type { TeamId, Vec2 } from './types'

/** Bump when the saved map shape changes incompatibly. */
export const MAP_VERSION = 1

/**
 * A reusable starting position: the board (terrain, spawns, lanes) plus the
 * pieces to place on it. This is deliberately leaner than a `SavedPosition`:
 * pieces are stored as placements at full health and with no orders, so a map
 * is a scenario, not a savegame.
 */
export interface SavedMap {
  version: number
  id: string
  name: string
  savedAt: number
  board: MapData & { terrain: number[] }
  placements: Placement[]
}

export interface MapExportOptions {
  id?: string
  savedAt?: number
}

function newMapId(): string {
  return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Snapshot the live board and every piece on it into a reusable map. */
export function exportMap(game: Game, name: string, options: MapExportOptions = {}): SavedMap {
  const entities = game.world.query(Position, Cell, Team, PieceType).slice().sort((a, b) => a - b)
  const placements: Placement[] = []
  for (const e of entities) {
    const cell = game.world.get(e, Cell)
    const team = game.world.get(e, Team)
    const kind = game.world.get(e, PieceType)?.kind
    if (!cell || !team || !kind) continue
    placements.push({ team, key: kind, x: cell.x, y: cell.y })
  }
  const board = structuredClone(game.board.data)
  board.terrain = Array.from(game.board.terrain)
  return {
    version: MAP_VERSION,
    id: options.id ?? newMapId(),
    name,
    savedAt: options.savedAt ?? Date.now(),
    board,
    placements,
  }
}

/** A blank map: the generated board for `size` with no pieces on it. */
export function emptyMap(size: BoardSize, name = `${size}\u00d7${size} map`): SavedMap {
  const board = structuredClone(createBoardData(size, name))
  return {
    version: MAP_VERSION,
    id: newMapId(),
    name,
    savedAt: Date.now(),
    board,
    placements: [],
  }
}

/** Rebuild a `Board` (with its terrain) from a saved map. */
export function buildMapBoard(map: SavedMap): Board {
  return new Board({
    ...map.board,
    id: map.id,
    name: map.name,
    terrain: map.board.terrain.slice(),
  })
}

/** Living piece counts per team, for map-list cards and previews. */
export function mapPieceCounts(map: SavedMap): Record<TeamId, number> {
  const counts: Record<TeamId, number> = { red: 0, blue: 0 }
  for (const p of map.placements) counts[p.team]++
  return counts
}

function isVec2(value: unknown): value is Vec2 {
  const v = value as Vec2 | undefined
  return !!v && Number.isInteger(v.x) && Number.isInteger(v.y)
}

export function validateMap(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') return { ok: false, error: 'not an object' }
  const m = data as Partial<SavedMap>
  if (m.version !== MAP_VERSION) {
    return { ok: false, error: `unsupported map version ${String(m.version)} (expected ${MAP_VERSION})` }
  }
  if (typeof m.id !== 'string' || typeof m.name !== 'string') return { ok: false, error: 'missing map id/name' }
  const board = m.board
  if (!board || typeof board !== 'object' || !Array.isArray(board.terrain)) {
    return { ok: false, error: 'missing map terrain' }
  }
  if (typeof board.width !== 'number' || typeof board.height !== 'number') {
    return { ok: false, error: 'missing map size' }
  }
  if (board.width * board.height !== board.terrain.length) {
    return { ok: false, error: 'terrain does not match map size' }
  }
  if (!board.spawns || !board.lanes || !board.legend) return { ok: false, error: 'malformed map board' }
  if (!Array.isArray(m.placements)) return { ok: false, error: 'missing placements' }
  const seen = new Set<number>()
  for (const p of m.placements) {
    if (!p || (p.team !== 'red' && p.team !== 'blue')) return { ok: false, error: 'bad placement team' }
    if (typeof p.key !== 'string' || !PIECES[p.key]) return { ok: false, error: `unknown piece "${String(p.key)}"` }
    if (!isVec2(p) || p.x < 0 || p.y < 0 || p.x >= board.width || p.y >= board.height) {
      return { ok: false, error: 'placement out of bounds' }
    }
    const index = p.y * board.width + p.x
    if (seen.has(index)) return { ok: false, error: 'two pieces share a cell' }
    seen.add(index)
  }
  return { ok: true }
}
