import * as components from '../ecs/components'
import type { ComponentStore, Entity, WorldSnapshot } from '../ecs/world'
import { Board } from './board'
import type { MapData } from './board'
import type { GameMode, OverlayFlags } from './game'
import type { Commands, TeamRuntime } from '../ecs/types'
import type { SimSettings } from './settings'
import type { TeamId } from './types'

/** Bump when the saved shape changes incompatibly. */
const POSITION_VERSION = 2

export interface SerializedStore {
  name: string
  entries: Array<[Entity, unknown]>
}

export interface SerializedWorld {
  next: number
  entities: Entity[]
  stores: SerializedStore[]
}

/** A serialized turn-boundary state (see `TurnState` in game.ts). */
export interface SerializedTurnState {
  world: SerializedWorld
  rng: number
  tick: number
  turn: number
  teams: Record<TeamId, TeamRuntime>
  winner: TeamId | null
  settings: SimSettings
}

/** A serialized undo/redo boundary plus the turn that produced it. */
export interface SavedHistoryEntry {
  state: SerializedTurnState
  /** Exact turn-start snapshot (post-setup, orders included); required for turns. */
  start?: SerializedTurnState | null
  /** Ticks the producing turn ran for; 0 for a non-turn boundary. */
  ticks: number
  /** Commands pending at turn start. */
  pending?: Commands | null
}

/**
 * A complete, plain-JSON snapshot of a battle: terrain, every component store
 * (so entity ids and references survive), RNG state and team bookkeeping. This
 * is what export/import and copy-position operate on. When saved as a full game
 * it also carries the undo/redo history and cursor.
 */
export interface SavedPosition {
  version: number
  board: MapData & { terrain: number[] }
  world: SerializedWorld
  rng: number
  /** Origin seed of the battle; absent on pre-seed saves (defaults on load). */
  seed?: number
  tick: number
  turn: number
  winner: TeamId | null
  teams: Record<TeamId, TeamRuntime>
  gameMode: GameMode
  playerTeam: TeamId
  overlays: OverlayFlags
  /** Sim rules in force; absent on position-only or older saves. */
  settings?: SimSettings
  /** Full undo/redo history, when the save is a whole game. */
  history?: SavedHistoryEntry[]
  /** Index into `history` the save is showing. */
  cursor?: number
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

function validateWorld(world: unknown): string | null {
  const w = world as SerializedWorld | undefined
  if (!w || !Array.isArray(w.entities) || !Array.isArray(w.stores)) return 'missing world data'
  for (const store of w.stores) {
    if (!store || typeof store.name !== 'string' || !Array.isArray(store.entries)) {
      return 'malformed component store'
    }
    if (!STORE_REGISTRY[store.name]) return `unknown component store "${store.name}"`
  }
  return null
}

function isSimSettings(value: unknown): value is SimSettings {
  const s = value as Partial<SimSettings> | undefined
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.autoPreserve === 'boolean' &&
    typeof s.captureAdvance === 'boolean' &&
    typeof s.chessKills === 'boolean'
  )
}

function validateTurnState(state: unknown): string | null {
  const s = state as Partial<SerializedTurnState> | undefined
  if (!s || typeof s !== 'object') return 'malformed turn state'
  const worldError = validateWorld(s.world)
  if (worldError) return worldError
  if (typeof s.rng !== 'number' || typeof s.tick !== 'number' || typeof s.turn !== 'number') {
    return 'turn state missing rng/tick/turn'
  }
  if (!s.teams || typeof s.teams !== 'object') return 'turn state missing teams'
  if (!isSimSettings(s.settings)) return 'turn state missing settings'
  return null
}

function validateHistoryEntry(entry: unknown): string | null {
  const e = entry as Partial<SavedHistoryEntry> | undefined
  if (!e || typeof e !== 'object') return 'malformed history entry'
  const stateError = validateTurnState(e.state)
  if (stateError) return stateError
  if (typeof e.ticks !== 'number') return 'history entry missing ticks'
  // A recorded turn must carry its exact start so it can be replayed; a
  // non-turn boundary (ticks 0) has no start.
  if (e.ticks > 0 && e.start == null) return 'history entry missing turn start'
  if (e.start != null) {
    const startError = validateTurnState(e.start)
    if (startError) return `history start: ${startError}`
  }
  return null
}

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
  const worldError = validateWorld(d.world)
  if (worldError) return { ok: false, error: worldError }
  if (typeof d.rng !== 'number' || typeof d.tick !== 'number' || typeof d.turn !== 'number') {
    return { ok: false, error: 'missing rng/tick/turn' }
  }
  if (!d.teams || typeof d.teams !== 'object') return { ok: false, error: 'missing teams' }
  if (d.settings !== undefined && !isSimSettings(d.settings)) {
    return { ok: false, error: 'malformed settings' }
  }
  if (d.history !== undefined) {
    if (!Array.isArray(d.history) || d.history.length === 0) {
      return { ok: false, error: 'malformed history' }
    }
    for (const entry of d.history) {
      const entryError = validateHistoryEntry(entry)
      if (entryError) return { ok: false, error: entryError }
    }
    if (d.cursor !== undefined && (typeof d.cursor !== 'number' || d.cursor < 0 || d.cursor >= d.history.length)) {
      return { ok: false, error: 'history cursor out of range' }
    }
  }
  return { ok: true }
}

/** Snapshot a live game into a plain, JSON-serializable object. */
export function serializePosition(game: {
  world: { capture(): WorldSnapshot }
  board: Board
  rng: { getState(): number }
  seed: number
  tick: number
  turn: number
  winner: TeamId | null
  teams: Record<TeamId, TeamRuntime>
  gameMode: GameMode
  playerTeam: TeamId
  overlays: OverlayFlags
}): SavedPosition {
  const captured = game.world.capture()
  return {
    version: POSITION_VERSION,
    board: { ...game.board.data, terrain: Array.from(game.board.terrain) },
    world: serializeWorldSnapshot(captured),
    rng: game.rng.getState(),
    seed: game.seed,
    tick: game.tick,
    turn: game.turn,
    winner: game.winner,
    teams: structuredClone(game.teams),
    gameMode: game.gameMode,
    playerTeam: game.playerTeam,
    overlays: { ...game.overlays },
  }
}

/** Serialize a live `WorldSnapshot` (component stores resolved by name). */
export function serializeWorldSnapshot(captured: WorldSnapshot): SerializedWorld {
  return {
    next: captured.next,
    entities: captured.entities.slice(),
    stores: captured.stores.map((s) => ({ name: s.store.name, entries: s.entries })),
  }
}

/** Rebuild a `World.restore` snapshot from serialized store names. */
export function buildWorldSnapshot(saved: { world: SerializedWorld }): WorldSnapshot {
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
