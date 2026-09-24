import { Cell, clearAllComponents } from '../ecs/components'
import type { EventRecord } from '../ecs/events'
import type { BoardSize } from './boards'
import { Game } from './game'
import type { GameMode } from './game'
import type { StanceMode, TeamId, Vec2 } from './types'

/** Bump when the record shape changes incompatibly. */
const RECORD_VERSION = 1

/**
 * A player command, normalized to board cells so it survives replay. Piece
 * identity is expressed as the cell the piece stood on when the order was
 * issued — the chess-notation equivalent of naming the square.
 */
export type GameCommandIntent =
  | { t: 'order'; from: Vec2; to: Vec2; command?: 'move' | 'attack' }
  | { t: 'stance'; from: Vec2; mode: StanceMode }
  | { t: 'clear'; from: Vec2 }
  | { t: 'deploy'; team: TeamId; key: string }
  | { t: 'mode'; mode: GameMode }

export interface TurnRecord {
  /** The turn these intents precede (turn 1 = the opening turn). */
  turn: number
  intents: GameCommandIntent[]
}

export interface GameRecordResult {
  winner: TeamId | null
  turns: number
  ticks: number
  timedOut: boolean
  /** True when copied mid-battle: the outcome is not final. */
  partial?: boolean
}

/**
 * A compact, replayable record of a battle: the deterministic seed plus the
 * ordered player inputs. Re-running it through `replayRecord` reproduces the
 * game exactly, so it is the efficient stand-in for dozens of full snapshots.
 */
export interface GameRecord {
  v: number
  boardId: string
  size: number
  mode: GameMode
  playerTeam: TeamId
  seed: number
  settings: { autoPreserve: boolean; captureAdvance: boolean }
  turns: TurnRecord[]
  result: GameRecordResult | null
}

/**
 * Captures player commands off `Game.onCommand`, grouped by the turn they
 * precede. AI-vs-AI games record no intents: the seed alone reproduces them.
 */
export class Recorder {
  private game: Game
  private data: GameRecord
  private byTurn = new Map<number, TurnRecord>()

  constructor(game: Game) {
    this.game = game
    this.data = headerFor(game)
    game.onCommand = (intent) => this.push(intent)
  }

  private push(intent: GameCommandIntent): void {
    // Orders are given while paused, before `beginTurn` increments `game.turn`,
    // so they belong to the upcoming turn.
    const turn = this.game.turn + 1
    let entry = this.byTurn.get(turn)
    if (!entry) {
      entry = { turn, intents: [] }
      this.byTurn.set(turn, entry)
    }
    entry.intents.push(intent)
  }

  /** Recapture the header and drop every recorded turn (new game / reset). */
  reset(): void {
    this.data = headerFor(this.game)
    this.byTurn.clear()
  }

  /** Freeze the current outcome into the record and return it. */
  finish(result: Partial<GameRecordResult> = {}): GameRecord {
    this.data.result = {
      winner: result.winner ?? this.game.winner,
      turns: result.turns ?? this.game.turn,
      ticks: result.ticks ?? this.game.tick,
      timedOut: result.timedOut ?? false,
      partial: result.partial ?? this.game.winner === null,
    }
    return this.record
  }

  /**
   * A detached copy with the current outcome, without mutating the live
   * recorder — safe to call mid-battle (e.g. the "Copy history for LLM" button).
   */
  snapshot(result: Partial<GameRecordResult> = {}): GameRecord {
    const data = structuredClone(this.record)
    data.result = {
      winner: result.winner ?? this.game.winner,
      turns: result.turns ?? this.game.turn,
      ticks: result.ticks ?? this.game.tick,
      timedOut: result.timedOut ?? false,
      partial: result.partial ?? this.game.winner === null,
    }
    return data
  }

  get record(): GameRecord {
    this.data.turns = [...this.byTurn.values()].sort((a, b) => a.turn - b.turn)
    return this.data
  }
}

function headerFor(game: Game): GameRecord {
  return {
    v: RECORD_VERSION,
    boardId: game.board.data.id,
    size: game.board.width,
    mode: game.gameMode,
    playerTeam: game.playerTeam,
    seed: game.seed,
    settings: { autoPreserve: game.autoPreserve, captureAdvance: game.captureAdvance },
    turns: [],
    result: null,
  }
}

export interface ReplayOptions {
  /** Collect the full event stream while replaying (for study / diffs). */
  collectEvents?: boolean
  /** Safety cap on ticks per turn; mirrors `Game.TURN_MAX_TICKS` with slack. */
  maxTicksPerTurn?: number
}

export interface ReplayResult {
  game: Game
  events: EventRecord[]
}

/**
 * Rebuild and re-simulate a recorded battle. Component stores are singletons, so
 * this clears them first — it is a tooling operation and will not preserve a
 * concurrently running `Game`.
 */
export function replayRecord(record: GameRecord, options: ReplayOptions = {}): ReplayResult {
  clearAllComponents()
  const game = new Game(record.size as BoardSize, record.mode, record.seed)
  game.playerTeam = record.playerTeam
  game.autoPreserve = record.settings.autoPreserve
  game.captureAdvance = record.settings.captureAdvance

  const events: EventRecord[] = []
  if (options.collectEvents) game.bus.subscribe((event) => events.push(event))

  const maxTicks = options.maxTicksPerTurn ?? 4000
  const totalTurns =
    record.result?.turns ?? record.turns.reduce((max, turn) => Math.max(max, turn.turn), 0)
  const byTurn = new Map(record.turns.map((turn) => [turn.turn, turn.intents]))

  for (let turn = 1; turn <= totalTurns; turn++) {
    if (game.winner !== null) break
    const intents = byTurn.get(turn)
    if (intents) applyIntents(game, intents)
    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < maxTicks) game.runTicks(1)
  }

  return { game, events }
}

function applyIntents(game: Game, intents: GameCommandIntent[]): void {
  const cells = new Map<number, number>()
  for (const e of game.world.query(Cell)) {
    const cell = game.world.get(e, Cell)
    if (cell) cells.set(game.board.cellIndex(cell.x, cell.y), e)
  }
  const at = (cell: Vec2): number | null => cells.get(game.board.cellIndex(cell.x, cell.y)) ?? null

  for (const intent of intents) {
    switch (intent.t) {
      case 'deploy':
        game.deploy(intent.team, intent.key)
        break
      case 'mode':
        game.setGameMode(intent.mode)
        break
      case 'order': {
        const e = at(intent.from)
        if (e === null) break
        game.selected = [e]
        game.orderAt(intent.to, intent.command)
        break
      }
      case 'stance': {
        const e = at(intent.from)
        if (e === null) break
        game.selected = [e]
        game.setPieceStance(intent.mode)
        break
      }
      case 'clear': {
        const e = at(intent.from)
        if (e === null) break
        game.selected = [e]
        game.clearOrders()
        break
      }
    }
  }
  game.selected = []
}

export function serializeRecord(record: GameRecord): string {
  return JSON.stringify(record)
}

export function validateRecord(data: unknown): { ok: true } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'not an object' }
  const record = data as Partial<GameRecord>
  if (record.v !== RECORD_VERSION) {
    return { ok: false, error: `unsupported record version ${String(record.v)}` }
  }
  if (typeof record.size !== 'number' || typeof record.seed !== 'number') {
    return { ok: false, error: 'missing size/seed' }
  }
  if (!Array.isArray(record.turns)) return { ok: false, error: 'missing turns' }
  if (!record.settings || typeof record.settings !== 'object') {
    return { ok: false, error: 'missing settings' }
  }
  return { ok: true }
}

/** Parse a record, throwing on malformed data (see `validateRecord`). */
export function parseRecord(json: string): GameRecord {
  const data: unknown = JSON.parse(json)
  const valid = validateRecord(data)
  if (!valid.ok) throw new Error(valid.error)
  return data as GameRecord
}
