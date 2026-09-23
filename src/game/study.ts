import { Cell, Health, Motion, Order, PieceType, Target, Team } from '../ecs/components'
import type { EventRecord } from '../ecs/events'
import type { BoardSize } from './boards'
import { Game } from './game'
import type { GameMode } from './game'
import { Recorder } from './record'
import type { GameRecord } from './record'
import { analyzeGame } from './analysis'
import type { GameAnalysis } from './analysis'
import { formatTranscript } from './transcript'
import { buildStudyPrompt } from './studyPrompt'
import type { PieceTrace, TurnTrace } from './trace'
import type { TeamId } from './types'

export type StudyPolicyName = 'none' | 'advance' | 'focus' | 'turtle'

export const STUDY_POLICIES: Array<{ id: StudyPolicyName; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'advance', label: 'Advance' },
  { id: 'focus', label: 'Focus fire' },
  { id: 'turtle', label: 'Attack stance' },
]

export type StudyPolicy = (game: Game, turn: number) => void

function piecesOf(game: Game, team: TeamId): number[] {
  const out: number[] = []
  for (const e of game.world.query(Cell, Team, PieceType, Health)) {
    if (game.world.require(e, Team) === team) out.push(e)
  }
  return out
}

function enemyOf(team: TeamId): TeamId {
  return team === 'red' ? 'blue' : 'red'
}

/** Advance every piece toward the enemy back rank; never initiates a fight. */
export const advancePolicy: StudyPolicy = (game) => {
  const goalY = enemyOf(game.playerTeam) === 'red' ? 0 : game.board.height - 1
  for (const e of piecesOf(game, game.playerTeam)) {
    const cell = game.world.get(e, Cell)
    if (!cell) continue
    game.selected = [e]
    game.orderAt({ x: cell.x, y: goalY }, 'move')
  }
  game.selected = []
}

/** Attack the nearest enemy within 8 squares, else advance. */
export const focusFirePolicy: StudyPolicy = (game) => {
  const team = game.playerTeam
  const enemy = enemyOf(team)
  const goalY = enemy === 'red' ? 0 : game.board.height - 1
  const enemies: Array<{ x: number; y: number }> = []
  for (const e of piecesOf(game, enemy)) {
    const cell = game.world.get(e, Cell)
    if (cell) enemies.push({ x: cell.x, y: cell.y })
  }
  for (const e of piecesOf(game, team)) {
    const cell = game.world.get(e, Cell)
    if (!cell) continue
    let best: { x: number; y: number } | null = null
    let bestDist = Infinity
    for (const target of enemies) {
      const d = (target.x - cell.x) ** 2 + (target.y - cell.y) ** 2
      if (d < bestDist) {
        bestDist = d
        best = target
      }
    }
    game.selected = [e]
    if (best && bestDist <= 64) game.orderAt({ x: best.x, y: best.y })
    else game.orderAt({ x: cell.x, y: goalY }, 'move')
  }
  game.selected = []
}

/** Set the whole army to Attack stance once and let it fight autonomously. */
export const turtlePolicy: StudyPolicy = (game, turn) => {
  if (turn > 1) return
  game.selected = piecesOf(game, game.playerTeam)
  game.setPieceStance('attack')
  game.selected = []
}

const POLICIES: Record<StudyPolicyName, StudyPolicy | undefined> = {
  none: undefined,
  advance: advancePolicy,
  focus: focusFirePolicy,
  turtle: turtlePolicy,
}

export interface StudyOptions {
  games: number
  size: BoardSize
  mode: GameMode
  seedBase: number
  maxTurns: number
  policy: StudyPolicyName
  autoPreserve: boolean
  captureAdvance: boolean
}

export interface StudyGameResult {
  index: number
  seed: number
  mode: GameMode
  size: number
  winner: TeamId | null
  turns: number
  ticks: number
  /** Stopped early by the user or the turn cap, not a decisive result. */
  partial: boolean
  record: GameRecord
  events: EventRecord[]
  trace: TurnTrace[]
  transcript: string
  analysis: GameAnalysis
}

export interface StudyState {
  running: boolean
  games: number
  /** 0-based index of the game currently playing, or -1 when idle. */
  index: number
  seed: number
  turn: number
  results: StudyGameResult[]
}

/**
 * Drives the live `Game` through a batch of watchable games, recording each one
 * (seed + inputs, event stream and per-turn piece trace). It owns the main board
 * while running: `tick()` is called from the UI loop to keep turns flowing.
 * `stopCurrent` keeps the partial game's recording; `cancel` discards everything.
 */
export class StudyController {
  private static readonly MAX_EVENTS = 20000

  private game: Game
  private recorder: Recorder
  private options: StudyOptions | null = null
  private results: StudyGameResult[] = []
  private events: EventRecord[] = []
  private trace: TurnTrace[] = []
  private running = false
  private index = -1
  private lastSampledTurn = -1
  private opening = ''
  private unsubscribe: () => void

  constructor(game: Game, recorder: Recorder) {
    this.game = game
    this.recorder = recorder
    this.unsubscribe = game.bus.subscribe((event) => {
      if (!this.running) return
      if (this.events.length < StudyController.MAX_EVENTS) this.events.push(event)
    })
  }

  dispose(): void {
    this.unsubscribe()
  }

  start(options: StudyOptions): void {
    this.options = { ...options }
    this.results = []
    this.running = true
    this.index = -1
    this.startNext()
  }

  /** Finish the current game as a kept partial recording, then start the next. */
  stopCurrent(): void {
    if (!this.running) return
    this.finishGame()
  }

  /** Abort the whole batch and discard every recording. */
  cancel(): void {
    this.running = false
    this.index = -1
    this.results = []
    this.events = []
    this.trace = []
  }

  /** Called every UI refresh: samples, applies the policy, starts the next turn. */
  tick(): void {
    if (!this.running || !this.options) return
    if (this.game.turnActive || this.game.isReplaying) return
    if (this.game.winner !== null) {
      this.finishGame()
      return
    }
    if (this.game.turn >= this.options.maxTurns) {
      this.finishGame()
      return
    }
    if (this.game.turn > this.lastSampledTurn) {
      this.sampleTrace()
      this.lastSampledTurn = this.game.turn
    }
    const policy = POLICIES[this.options.policy]
    if (policy && this.game.teams[this.game.playerTeam].controller === 'human') {
      policy(this.game, this.game.turn + 1)
    }
    this.game.queueTurn()
  }

  get state(): StudyState {
    const options = this.options
    const seed = options ? (this.index >= 0 ? options.seedBase + this.index : options.seedBase) : 0
    return {
      running: this.running,
      games: options?.games ?? 0,
      index: this.index,
      seed,
      turn: this.game.turn,
      results: this.results,
    }
  }

  buildPrompt(): string {
    return buildStudyPrompt(this.results, { mode: this.options?.mode, size: this.options?.size })
  }

  private startNext(): void {
    this.index++
    if (!this.options || this.index >= this.options.games) {
      this.running = false
      this.index = -1
      return
    }
    const seed = this.options.seedBase + this.index
    this.game.setGameMode(this.options.mode)
    this.game.autoPreserve = this.options.autoPreserve
    this.game.captureAdvance = this.options.captureAdvance
    this.game.loadSize(this.options.size as BoardSize, seed)
    this.recorder.reset()
    this.events = []
    this.trace = []
    this.lastSampledTurn = -1
    this.opening = this.game.shorthand()
  }

  private finishGame(): void {
    if (!this.options) return
    const partial = this.game.winner === null
    const record = structuredClone(
      this.recorder.finish({
        turns: this.game.turn,
        ticks: this.game.tick,
        timedOut: partial,
      }),
    )
    if (this.game.turn > this.lastSampledTurn) {
      this.sampleTrace()
      this.lastSampledTurn = this.game.turn
    }
    const transcript = formatTranscript({
      record,
      events: this.events,
      trace: this.trace,
      opening: this.opening,
      final: this.game.shorthand(),
    })
    this.results.push({
      index: this.index,
      seed: record.seed,
      mode: record.mode,
      size: record.size,
      winner: record.result?.winner ?? null,
      turns: record.result?.turns ?? this.game.turn,
      ticks: record.result?.ticks ?? this.game.tick,
      partial,
      record,
      events: this.events,
      trace: this.trace,
      transcript,
      analysis: analyzeGame(record, this.events, this.trace),
    })
    this.startNext()
  }

  private sampleTrace(): void {
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
