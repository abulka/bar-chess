import { Cell, Health, Motion, PieceType, Team } from '../ecs/components'
import type { EventRecord } from '../ecs/events'
import { firingPositionExists } from './approach'
import type { BoardSize } from './boards'
import { Game } from './game'
import type { GameMode } from './game'
import { GameLog } from './gameLog'
import { chebyshev, moveDestinations } from './geometry'
import { dist2 } from './math'
import { buildOccupancy, makeOccupied } from './occupancy'
import { PIECES, WEAPONS } from './pieces'
import { Recorder } from './record'
import type { GameRecord } from './record'
import { Rng } from './rng'
import type { GameAnalysis } from './analysis'
import type { TurnTrace } from './trace'
import type { TeamId, Vec2 } from './types'
import type { Entity } from '../ecs/world'

/** `none` runs no scripted orders; `human` is the gentle random player policy. */
export type StudyPolicyName = 'none' | 'human'

/** `watch` plays at animation speed; `fast` drains turns without waiting. */
export type StudySpeed = 'watch' | 'fast'

/** How the scripted human behaves. */
export interface StudyPolicyTuning {
  /** Most pieces given an order in one turn. */
  piecesPerTurn: number
  /** Chance that a chosen piece attacks instead of making a short move. */
  attackChance: number
}

export const DEFAULT_STUDY_TUNING: StudyPolicyTuning = {
  piecesPerTurn: 3,
  attackChance: 0.2,
}

/** Ticks one fast frame may simulate, so the page never freezes for long. */
const FAST_STEPS_PER_FRAME = 2000

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

/** Any living non-king piece on the team? False means the side is king-only. */
function hasFieldPieces(game: Game, team: TeamId): boolean {
  for (const e of game.world.query(PieceType, Team, Health)) {
    if (game.world.require(e, Team) !== team) continue
    if (game.world.require(e, PieceType).kind === 'king') continue
    if (game.world.require(e, Health).cur <= 0) continue
    return true
  }
  return false
}

/** True when neither side has a living non-king piece: no winning material left. */
export function isKingOnlyDraw(game: Game): boolean {
  return !hasFieldPieces(game, 'red') && !hasFieldPieces(game, 'blue')
}

/** Pick `count` distinct items at random, in a seeded, reproducible order. */
function pickSome<T>(items: T[], count: number, rng: Rng): T[] {
  const pool = [...items]
  const out: T[] = []
  const n = Math.min(Math.max(1, count), pool.length)
  for (let i = 0; i < n; i++) {
    const j = rng.int(0, pool.length - 1)
    out.push(pool[j])
    pool.splice(j, 1)
  }
  return out
}

/** Closest living enemy's square, or null when the board is already cleared. */
function nearestEnemyCell(game: Game, e: Entity, team: TeamId): Vec2 | null {
  const cell = game.world.get(e, Cell)
  if (!cell) return null
  let best: Vec2 | null = null
  let bestDist = Infinity
  for (const other of game.world.query(Cell, Team, Health)) {
    if (game.world.require(other, Team) === team) continue
    const oc = game.world.require(other, Cell)
    const d = dist2(oc.x, oc.y, cell.x, cell.y)
    if (d < bestDist) {
      bestDist = d
      best = { x: oc.x, y: oc.y }
    }
  }
  return best
}

/**
 * An enemy this piece could eventually shoot, chosen at random. Uses the same
 * reachability test the order system uses, so the attack order is never
 * positionally impossible (a pawn ordered straight ahead, a bishop on the
 * wrong colour). Returns null when nothing is engageable.
 */
function randomEngageableEnemy(game: Game, e: Entity, team: TeamId, rng: Rng): Entity | null {
  const cell = game.world.get(e, Cell)
  const kind = game.world.get(e, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  if (!cell || !def) return null
  const weaponGeom = WEAPONS[def.weapon].geometry
  const candidates: Entity[] = []
  for (const other of game.world.query(Cell, Team, Health)) {
    if (game.world.require(other, Team) === team) continue
    const oc = game.world.require(other, Cell)
    if (firingPositionExists(game.board, cell, oc, def.move, weaponGeom, team)) {
      candidates.push(other)
    }
  }
  if (candidates.length === 0) return null
  return candidates[rng.int(0, candidates.length - 1)]
}

/**
 * One short, legal move: a single movement hop, biased toward the nearest
 * enemy but chosen from the best few squares so the army does not march in
 * lockstep. Returns null when the piece is boxed in.
 */
function gentleMove(game: Game, e: Entity, team: TeamId, rng: Rng): Vec2 | null {
  const cell = game.world.get(e, Cell)
  const kind = game.world.get(e, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  if (!cell || !def) return null
  const occupied = makeOccupied(game.board, buildOccupancy(game.world, game.board))
  const steps = moveDestinations(game.board, cell, def.move, team, occupied).filter(
    (c) => !occupied(c.x, c.y),
  )
  if (steps.length === 0) return null
  const enemy = enemyOf(team)
  const aim = nearestEnemyCell(game, e, team) ?? game.board.laneMidpoint(enemy) ?? cell
  const ranked = steps
    .map((c) => ({ c, d: chebyshev(c.x, c.y, aim.x, aim.y) }))
    .sort((a, b) => a.d - b.d)
  const window = Math.min(3, ranked.length)
  return ranked[rng.int(0, window - 1)].c
}

/**
 * A gentle, human-like player: each turn it gives orders to a few random
 * pieces. Most orders are a short move toward the fight; now and then a piece
 * attacks an enemy it can genuinely engage. Pieces that are already retreating
 * to heal are left alone.
 */
export function humanPolicy(game: Game, rng: Rng, tuning: StudyPolicyTuning): void {  const team = game.playerTeam
  const idle = piecesOf(game, team).filter((e) => {
    const motion = game.world.get(e, Motion)
    // Leave pieces that are already retreating or holding to heal alone.
    return !motion || (motion.intent !== 'preserve' && motion.holdUntilHp <= 0)
  })
  if (idle.length === 0) return
  const chosen = pickSome(idle, Math.round(tuning.piecesPerTurn), rng)
  const attackChance = Math.min(0.9, Math.max(0, tuning.attackChance))
  for (const e of chosen) {
    // Each order starts fresh, so long queues never build up behind a piece.
    game.selected = [e]
    game.clearOrders()
    if (rng.next() < attackChance) {
      const victim = randomEngageableEnemy(game, e, team, rng)
      const vcell = victim !== null ? game.world.get(victim, Cell) : null
      if (vcell) {
        game.orderAt({ x: vcell.x, y: vcell.y })
        continue
      }
    }
    const dest = gentleMove(game, e, team, rng)
    if (dest) game.orderAt(dest, 'move')
  }
  game.selected = []
}

export interface StudyOptions {
  games: number
  size: BoardSize
  mode: GameMode
  seedBase: number
  maxTurns: number
  policy: StudyPolicyName
  speed: StudySpeed
  piecesPerTurn: number
  attackChance: number
  autoPreserve: boolean
  captureAdvance: boolean
  chessKills: boolean
  promotion: boolean
}

export interface StudyGameResult {
  index: number
  seed: number
  mode: GameMode
  size: number
  policy: StudyPolicyName
  piecesPerTurn: number
  attackChance: number
  winner: TeamId | null
  turns: number
  ticks: number
  /** Stopped early by the user or the turn cap, not a decisive result. */
  partial: boolean
  /** Stopped with no winning material on either side (king versus king). */
  drawn: boolean
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
 * while running: `tick()` is called from the UI loop. `watch` queues one turn
 * per call and lets the animation play it; `fast` drains whole turns per call
 * without waiting, so long batches finish in seconds. `stopCurrent` keeps the
 * partial game's recording; `cancel` discards everything.
 */
export class StudyController {
  private game: Game
  private recorder: Recorder
  private log: GameLog
  private options: StudyOptions | null = null
  private results: StudyGameResult[] = []
  private running = false
  private index = -1
  /** Scripted-policy randomness, kept separate so the battle's RNG is untouched. */
  private policyRng = new Rng()

  constructor(game: Game, recorder: Recorder) {
    this.game = game
    this.recorder = recorder
    this.log = new GameLog(game)
  }

  dispose(): void {
    this.log.dispose()
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
    this.log.begin()
  }

  /** Called every UI refresh: samples, applies the policy, advances the game. */
  tick(): void {
    if (!this.running || !this.options) return
    if (this.options.speed === 'fast') {
      this.drainFast(FAST_STEPS_PER_FRAME)
      return
    }
    if (this.game.turnActive || this.game.isReplaying) return
    if (this.game.winner !== null || this.game.turn >= this.options.maxTurns) {
      this.finishGame()
      return
    }
    this.startNextTurn()
  }

  /** Simulate up to `budget` steps without waiting for animation. */
  private drainFast(budget: number): void {
    let left = budget
    while (left-- > 0 && this.running && this.options) {
      if (this.game.turnActive || this.game.isReplaying) {
        this.game.runTicks(1)
        continue
      }
      if (this.game.winner !== null || this.game.turn >= this.options.maxTurns) {
        this.finishGame()
        continue
      }
      this.startNextTurn()
    }
  }

  private startNextTurn(): void {
    this.log.tick()
    this.applyPolicy()
    this.game.queueTurn()
  }

  private applyPolicy(): void {
    const options = this.options
    if (!options || options.policy === 'none') return
    if (this.game.teams[this.game.playerTeam].controller !== 'human') return
    humanPolicy(this.game, this.policyRng, {
      piecesPerTurn: options.piecesPerTurn,
      attackChance: options.attackChance,
    })
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
    this.game.chessKills = this.options.chessKills
    this.game.promotion = this.options.promotion
    // Re-run the current template when the requested size matches it, so study
    // batches keep custom starting positions instead of resetting to the default.
    const template = this.game.currentMap
    if (template && template.board.width === this.options.size) {
      this.game.loadMap(template, seed)
    } else {
      this.game.loadSize(this.options.size as BoardSize, seed)
    }
    this.policyRng = new Rng((seed ^ 0x5eed1234) >>> 0)
    this.recorder.reset()
    this.log.begin()
  }

  private finishGame(): void {
    if (!this.options) return
    const stopped = this.game.winner === null
    // A stopped game with no winning material left is a draw rather than a
    // timeout: neither side can make progress, but it is not an unfinished
    // battle. (A player king can still march in, so this is a study label, not
    // an automatic game end.)
    const drawn = stopped && isKingOnlyDraw(this.game)
    const partial = stopped && !drawn
    const record = structuredClone(
      this.recorder.finish({
        turns: this.game.turn,
        ticks: this.game.tick,
        timedOut: partial,
        partial,
        drawn,
      }),
    )
    const { transcript, analysis } = this.log.finish(record, {
      boards: true,
      study: this.options.policy === 'none' ? undefined : {
        policy: this.options.policy,
        piecesPerTurn: this.options.piecesPerTurn,
        attackChance: this.options.attackChance,
      },
    })
    this.results.push({
      index: this.index,
      seed: record.seed,
      mode: record.mode,
      size: record.size,
      policy: this.options.policy,
      piecesPerTurn: this.options.piecesPerTurn,
      attackChance: this.options.attackChance,
      winner: record.result?.winner ?? null,
      turns: record.result?.turns ?? this.game.turn,
      ticks: record.result?.ticks ?? this.game.tick,
      partial,
      drawn,
      record,
      events: this.log.eventStream,
      trace: this.log.turnTrace,
      transcript,
      analysis,
    })
    this.startNext()
  }
}
