import { Cell, Health, Motion, Order, PieceType, Target, Team } from '../ecs/components'
import type { EventRecord } from '../ecs/events'
import { analyzeGame } from './analysis'
import type { GameAnalysis } from './analysis'
import type { Game } from './game'
import type { GameRecord } from './record'
import { formatTranscript } from './transcript'
import type { PieceTrace, TurnTrace } from './trace'

export interface GameLogFinish {
  transcript: string
  analysis: GameAnalysis
}

export interface GameLogOptions {
  /** Include a compact board after each turn in the transcript. */
  boards?: boolean
}

/**
 * Observes one running `Game`: buffers its event stream and samples a per-turn
 * piece trace, then renders a readable transcript/analysis on demand.
 *
 * Sampling is driven by the game's `phase`/`turn end` event, so back-to-back
 * queued turns are never missed. Undo/redo only move a `cursorTurn` — the full
 * log is retained, so both directions stay complete and accurate. A new turn
 * played after an undo truncates the abandoned future.
 */
export class GameLog {
  private static readonly MAX_EVENTS = 20000

  private game: Game
  private events: EventRecord[] = []
  private trace: TurnTrace[] = []
  private opening = ''
  /** Highest turn currently valid for display (moves with undo/redo). */
  private cursorTurn = -1
  private unsubscribe: () => void

  constructor(game: Game) {
    this.game = game
    this.unsubscribe = game.bus.subscribe((event) => {
      if (this.events.length < GameLog.MAX_EVENTS) this.events.push(event)
      if (event.type === 'phase' && event.msg === 'turn end') this.capture()
      else if (event.type === 'info' && event.msg === 'turn started') this.truncateToCursor()
    })
  }

  dispose(): void {
    this.unsubscribe()
  }

  /** Start a fresh log: drop history and sample the current board as turn 0. */
  begin(): void {
    this.events = []
    this.trace = []
    this.cursorTurn = -1
    this.opening = this.game.shorthand()
    this.capture()
  }

  /** Polling fallback (e.g. single-stepping outside a turn). */
  tick(): void {
    if (this.game.turnActive) return
    if (this.game.turn <= this.cursorTurn) return
    this.capture()
  }

  /**
   * Move the display cursor after an undo/redo. Data is retained, so redo shows
   * the same turns again; a later new turn drops the abandoned future.
   */
  rewind(turn: number): void {
    this.cursorTurn = turn
  }

  get eventStream(): EventRecord[] {
    const cutoff = this.lastTick()
    return cutoff < 0 ? [] : this.events.filter((e) => e.tick <= cutoff)
  }

  get turnTrace(): TurnTrace[] {
    return this.trace.filter((t) => t.turn <= this.cursorTurn)
  }

  /** Render the readable transcript + analysis for a finished/copied record. */
  finish(record: GameRecord, options: GameLogOptions = {}): GameLogFinish {
    this.tick()
    const trace = this.turnTrace
    const events = this.eventStream
    return {
      transcript: formatTranscript({
        record,
        events,
        trace,
        opening: this.opening,
        final: this.game.shorthand(),
        terrain: Array.from(this.game.board.terrain),
        boards: options.boards,
      }),
      analysis: analyzeGame(record, events, trace),
    }
  }

  /** Tick of the last valid trace entry, or -1 when there is none. */
  private lastTick(): number {
    const trace = this.turnTrace
    return trace.length > 0 ? trace[trace.length - 1].tick : -1
  }

  /**
   * Drop retained turns/events beyond the cursor. Runs at the start of a new
   * turn, so an abandoned redo branch is discarded before its replacement is
   * played. A no-op during normal play.
   */
  private truncateToCursor(): void {
    const cutoff = this.lastTick()
    this.trace = this.trace.filter((t) => t.turn <= this.cursorTurn)
    this.events = cutoff >= 0 ? this.events.filter((e) => e.tick <= cutoff) : []
  }

  /** Sample the current turn boundary and advance the cursor. */
  private capture(): void {
    this.sample()
    this.cursorTurn = this.game.turn
  }

  private sample(): void {
    const pieces: PieceTrace[] = []
    for (const e of this.game.world.query(Cell, Team, PieceType, Health, Motion, Order, Target)) {
      const cell = this.game.world.require(e, Cell)
      const hp = this.game.world.require(e, Health)
      const motion = this.game.world.require(e, Motion)
      const order = this.game.world.require(e, Order)
      const target = this.game.world.require(e, Target)
      pieces.push({
        entity: e,
        team: this.game.world.require(e, Team),
        kind: this.game.world.require(e, PieceType).kind,
        cell: { x: cell.x, y: cell.y },
        goal: motion.goal ? { x: motion.goal.x, y: motion.goal.y } : null,
        moving: motion.moving,
        movedThisTurn: motion.movedThisTurn,
        orderKind: order.kind,
        target: target.entity,
        underFire: target.lastAttacker !== null && this.game.tick < target.underFireUntil,
        hp: hp.cur,
        maxHp: hp.max,
      })
    }
    this.trace.push({ turn: this.game.turn, tick: this.game.tick, pieces })
  }
}
