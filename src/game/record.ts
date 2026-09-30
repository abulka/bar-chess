import { Cell, clearAllComponents } from '../ecs/components'
import type { EventRecord } from '../ecs/events'
import type { BoardSize } from './boards'
import { SIM_VERSION } from './constants'
import { Game } from './game'
import type { GameMode } from './game'
import { validatePosition } from './position'
import type { SavedPosition } from './position'
import type { SimSettings } from './settings'
import type { TeamId, Vec2 } from './types'

/** Bump when the record shape changes incompatibly. */
const RECORD_VERSION = 3

/**
 * A player command, normalized to board cells so it survives replay. Piece
 * identity is expressed as the cell the piece stood on when the order was
 * issued — the chess-notation equivalent of naming the square.
 */
export type GameCommandIntent =
  | { t: 'order'; from: Vec2; to: Vec2; command?: 'move' | 'attack'; force?: boolean; queue?: boolean }
  | { t: 'no-preserve'; from: Vec2 }
  | { t: 'clear'; from: Vec2 }
  | { t: 'deploy'; team: TeamId; key: string }
  | { t: 'place'; team: TeamId; key: string; to: Vec2 }
  | { t: 'remove'; at: Vec2 }
  | { t: 'mode'; mode: GameMode }

export interface TurnRecord {
  /** The turn these intents precede (turn 1 = the opening turn). */
  turn: number
  intents: GameCommandIntent[]
  /** Sim rules in force when this turn's orders were issued; falls back to the header. */
  settings?: SimSettings
  /** How the beat ran: serialized turn (default) or a continuous "mega" play burst. */
  mode?: 'turn' | 'mega'
  /** Ticks the beat ran for, so a mega burst can be re-run exactly. */
  ticks?: number
}

export interface GameRecordResult {
  winner: TeamId | null
  turns: number
  ticks: number
  timedOut: boolean
  /** True when copied mid-battle: the outcome is not final. */
  partial?: boolean
  /** A stopped game with no winning material left (e.g. king versus king). */
  drawn?: boolean
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
  settings: SimSettings
  /** Simulation/rules version the game was recorded under. */
  simVersion?: number
  /**
   * The exact battle state the recorded inputs start from (position-only, no
   * history). Restored before the turns are re-applied, so games started from a
   * template, a loaded position or a sandbox edit replay bit-for-bit. Absent on
   * pre-v2 records, which fall back to the default layout.
   */
  baseline?: SavedPosition
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
  /**
   * Highest turn currently valid for export. Undo/redo move it without dropping
   * the beats, so a redo can export them again; beats beyond it are hidden and
   * are only discarded when a genuinely new branch is played or forked.
   */
  private cursor = Number.POSITIVE_INFINITY
  private unsubscribe: () => void

  constructor(game: Game) {
    this.game = game
    this.data = headerFor(game)
    game.onCommand = (intent) => this.push(intent)
    // Beat boundaries carry the mode and tick length; recording them here means
    // a full record exists even for command-free (AI-only) turns and play bursts,
    // and `replayRecord` can reproduce a mixed game.
    this.unsubscribe = game.bus.subscribe((event) => this.observe(event))
  }

  dispose(): void {
    this.unsubscribe()
  }

  /** Record each beat's mode/length as it ends (see `finishTurn`/`endMegaTurn`). */
  private observe(event: EventRecord): void {
    if (event.type !== 'phase' || event.msg !== 'turn end') return
    if (this.game.replaying) return
    const data = event.data as { turn?: number; ticks?: number; mode?: 'turn' | 'mega' } | undefined
    const turn = typeof data?.turn === 'number' ? data.turn : this.game.turn
    // A beat completing at the tip abandons anything recorded beyond it.
    for (const t of [...this.byTurn.keys()]) if (t > turn) this.byTurn.delete(t)
    this.cursor = Number.POSITIVE_INFINITY
    const existing = this.byTurn.get(turn)
    if (existing) {
      existing.mode = data?.mode
      existing.ticks = data?.ticks
      return
    }
    this.byTurn.set(turn, {
      turn,
      intents: [],
      settings: this.game.simSettings(),
      mode: data?.mode,
      ticks: data?.ticks,
    })
  }

  private push(intent: GameCommandIntent): void {
    // Orders are given while paused, before `beginTurn` increments `game.turn`,
    // so they belong to the upcoming turn.
    const turn = this.game.turn + 1
    // An order for a turn past the export cursor starts a new branch: drop the
    // abandoned future (including any stale same-turn entry) before recording.
    if (turn > this.cursor) {
      for (const t of [...this.byTurn.keys()]) if (t >= turn) this.byTurn.delete(t)
      this.cursor = Number.POSITIVE_INFINITY
    }
    let entry = this.byTurn.get(turn)
    if (!entry) {
      entry = { turn, intents: [], settings: this.game.simSettings() }
      this.byTurn.set(turn, entry)
    }
    entry.intents.push(intent)
  }

  /** Recapture the header and drop every recorded turn (new game / reset). */
  reset(): void {
    this.data = headerFor(this.game)
    this.byTurn.clear()
    this.cursor = Number.POSITIVE_INFINITY
  }

  /**
   * Follow the history cursor on undo/redo/jump/replay without dropping the
   * beats, so a later redo can export them again. Beats beyond the cursor are
   * hidden from `record`; they are discarded only by `forkTo` or when a new
   * branch is played.
   */
  rewindTo(turn: number): void {
    this.cursor = turn
    this.data.result = null
  }

  /**
   * Drop recorded beats after `turn` when the timeline is forked — an order
   * branch or an editor edit replaces the old future — so the exported record
   * never mixes branches. Unlike `rewindTo`, the dropped beats cannot be redone.
   */
  forkTo(turn: number): void {
    for (const t of [...this.byTurn.keys()]) {
      if (t > turn) this.byTurn.delete(t)
    }
    this.cursor = Number.POSITIVE_INFINITY
    this.data.result = null
  }

  /** Replace the recorded state, e.g. to roll back an editor session. */
  restore(record: GameRecord): void {
    this.data = structuredClone(record)
    this.byTurn = new Map()
    for (const turn of record.turns) this.byTurn.set(turn.turn, structuredClone(turn))
    this.cursor = Number.POSITIVE_INFINITY
  }

  /** Fill a result, defaulting each field to the live game's current value. */
  private buildResult(result: Partial<GameRecordResult>): GameRecordResult {
    return {
      winner: result.winner ?? this.game.winner,
      turns: result.turns ?? this.game.turn,
      ticks: result.ticks ?? this.game.tick,
      timedOut: result.timedOut ?? false,
      partial: result.partial ?? (this.game.winner === null && !this.game.drawn),
      drawn: result.drawn ?? this.game.drawn,
    }
  }

  /** Freeze the current outcome into the record and return it. */
  finish(result: Partial<GameRecordResult> = {}): GameRecord {
    this.data.result = this.buildResult(result)
    return this.record
  }

  /**
   * A detached copy with the current outcome, without mutating the live
   * recorder — safe to call mid-battle (e.g. the "Copy history for LLM" button).
   */
  snapshot(result: Partial<GameRecordResult> = {}): GameRecord {
    const data = structuredClone(this.record)
    data.result = this.buildResult(result)
    return data
  }

  get record(): GameRecord {
    this.data.turns = [...this.byTurn.values()]
      .filter((turn) => turn.turn <= this.cursor)
      .sort((a, b) => a.turn - b.turn)
    // Refresh the header from the live game so an export reflects settings
    // toggled after the recorder was constructed.
    this.data.settings = this.game.simSettings()
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
    settings: game.simSettings(),
    simVersion: SIM_VERSION,
    baseline: game.exportPosition(),
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
  if (record.simVersion !== SIM_VERSION) {
    console.warn(
      `[bar-chess] replaying a record from simulation v${String(record.simVersion)} under v${SIM_VERSION}; outcomes may differ`,
    )
  }
  clearAllComponents()
  const game = new Game(record.size as BoardSize, record.mode, record.seed)
  if (record.baseline) {
    const imported = game.importPosition(record.baseline)
    if (!imported.ok) throw new Error(`could not restore record baseline: ${imported.error}`)
  }
  game.playerTeam = record.playerTeam
  game.autoPreserve = record.settings.autoPreserve
  game.captureAdvance = record.settings.captureAdvance
  game.chessKills = record.settings.chessKills ?? false
  game.promotion = record.settings.promotion ?? true

  const events: EventRecord[] = []
  if (options.collectEvents) game.bus.subscribe((event) => events.push(event))

  const maxTicks = options.maxTicksPerTurn ?? 4000
  const totalTurns =
    record.result?.turns ?? record.turns.reduce((max, turn) => Math.max(max, turn.turn), 0)
  const byTurn = new Map(record.turns.map((turn) => [turn.turn, turn]))

  for (let turn = game.turn + 1; turn <= totalTurns; turn++) {
    if (game.winner !== null) break
    const entry = byTurn.get(turn)
    // Rules in force for this turn (recorded per turn when available); the
    // header is the fallback for older records and order-free turns.
    const rules = entry?.settings ?? record.settings
    game.autoPreserve = rules.autoPreserve
    game.captureAdvance = rules.captureAdvance
    game.chessKills = rules.chessKills ?? false
    game.promotion = rules.promotion ?? true
    if (entry) applyIntents(game, entry.intents)
    if (entry?.mode === 'mega') {
      // A play burst replays continuously for exactly the ticks it ran.
      const ticks = entry.ticks ?? 0
      game.beginMegaTurn()
      for (let i = 0; i < ticks && game.playing; i++) game.runTicks(1)
      if (game.playing) game.togglePause()
    } else {
      game.beginTurn()
      let guard = 0
      while (game.turnActive && guard++ < maxTicks) game.runTicks(1)
    }
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
      case 'place':
        game.placePiece(intent.team, intent.key, intent.to.x, intent.to.y)
        break
      case 'remove':
        game.removePieceAt(intent.at.x, intent.at.y)
        break
      case 'mode':
        game.setGameMode(intent.mode)
        break
      case 'order': {
        const e = at(intent.from)
        if (e === null) break
        game.selected = [e]
        game.orderAt(intent.to, intent.command, { force: intent.force, queue: intent.queue })
        break
      }
      case 'no-preserve': {
        const e = at(intent.from)
        if (e !== null) game.insistOn(e)
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
  // v3 records carry an explicit `queue` flag on order intents; older records
  // relied on the retired automatic-queue logic and cannot be replayed exactly.
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
  if (record.baseline !== undefined) {
    const valid = validatePosition(record.baseline)
    if (!valid.ok) return { ok: false, error: `record baseline: ${valid.error}` }
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
