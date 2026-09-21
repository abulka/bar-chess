import * as components from '../ecs/components'
import type { ComponentStore, Entity, WorldSnapshot } from '../ecs/world'
import { Board } from './board'
import type { MapData } from './board'
import type { GameMode, OverlayFlags } from './game'
import type { TeamRuntime } from '../ecs/types'
import type { TeamId } from './types'

/** Bump when the saved shape changes incompatibly. */
export const POSITION_VERSION = 2

export interface SerializedStore {
  name: string
  entries: Array<[Entity, unknown]>
}

export interface SerializedWorld {
  next: number
  entities: Entity[]
  stores: SerializedStore[]
}

/**
 * A complete, plain-JSON snapshot of a battle: terrain, every component store
 * (so entity ids and references survive), RNG state and team bookkeeping. This
 * is what export/import and copy-position operate on.
 */
export interface SavedPosition {
  version: number
  board: MapData & { terrain: number[] }
  world: SerializedWorld
  rng: number
  tick: number
  turn: number
  winner: TeamId | null
  teams: Record<TeamId, TeamRuntime>
  gameMode: GameMode
  playerTeam: TeamId
  orderMode: 'move' | 'attack'
  overlays: OverlayFlags
}

/** Component stores keyed by name, so serialized entries can be resolved back. */
const STORE_REGISTRY: Record<string, ComponentStore<unknown>> = {}
for (const value of Object.values(components)) {
  const store = value as unknown as ComponentStore<unknown>
  if (store && typeof store === 'object' && 'name' in store && store.map instanceof Map) {
    STORE_REGISTRY[store.name] = store
  }
}

export type ValidationResult = { ok: true } | { ok: false; error: string }

export function validatePosition(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') return { ok: false, error: 'not an object' }
  const d = data as Partial<SavedPosition>
  if (d.version !== POSITION_VERSION) {
    return { ok: false, error: `unsupported position version ${String(d.version)} (expected ${POSITION_VERSION})` }
  }
  const board = d.board
  if (!board || typeof board !== 'object' || !Array.isArray(board.terrain)) {
    return { ok: false, error: 'missing board terrain' }
  }
  if (board.width * board.height !== board.terrain.length) {
    return { ok: false, error: 'terrain does not match board size' }
  }
  const world = d.world
  if (!world || !Array.isArray(world.entities) || !Array.isArray(world.stores)) {
    return { ok: false, error: 'missing world data' }
  }
  for (const store of world.stores) {
    if (!store || typeof store.name !== 'string' || !Array.isArray(store.entries)) {
      return { ok: false, error: 'malformed component store' }
    }
    if (!STORE_REGISTRY[store.name]) {
      return { ok: false, error: `unknown component store "${store.name}"` }
    }
  }
  if (typeof d.rng !== 'number' || typeof d.tick !== 'number' || typeof d.turn !== 'number') {
    return { ok: false, error: 'missing rng/tick/turn' }
  }
  if (!d.teams || typeof d.teams !== 'object') return { ok: false, error: 'missing teams' }
  return { ok: true }
}

/** Snapshot a live game into a plain, JSON-serializable object. */
export function serializePosition(game: {
  world: { capture(): WorldSnapshot }
  board: Board
  rng: { getState(): number }
  tick: number
  turn: number
  winner: TeamId | null
  teams: Record<TeamId, TeamRuntime>
  gameMode: GameMode
  playerTeam: TeamId
  orderMode: 'move' | 'attack'
  overlays: OverlayFlags
}): SavedPosition {
  const captured = game.world.capture()
  return {
    version: POSITION_VERSION,
    board: { ...game.board.data, terrain: Array.from(game.board.terrain) },
    world: {
      next: captured.next,
      entities: captured.entities.slice(),
      stores: captured.stores.map((s) => ({ name: s.store.name, entries: s.entries })),
    },
    rng: game.rng.getState(),
    tick: game.tick,
    turn: game.turn,
    winner: game.winner,
    teams: structuredClone(game.teams),
    gameMode: game.gameMode,
    playerTeam: game.playerTeam,
    orderMode: game.orderMode,
    overlays: { ...game.overlays },
  }
}

/** Rebuild a `World.restore` snapshot from serialized store names. */
export function buildWorldSnapshot(saved: SavedPosition): WorldSnapshot {
  return {
    next: saved.world.next,
    entities: saved.world.entities.slice(),
    stores: saved.world.stores.map((s) => ({
      store: STORE_REGISTRY[s.name],
      entries: s.entries as Array<[Entity, unknown]>,
    })),
  }
}

/** Rebuild a `Board` (with its edited terrain) from a saved position. */
export function buildBoard(saved: SavedPosition): Board {
  return new Board({ ...saved.board, terrain: saved.board.terrain.slice() })
}
