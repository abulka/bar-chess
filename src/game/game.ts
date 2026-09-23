import { EventBus } from '../ecs/events'
import type { EventRecord } from '../ecs/events'
import { Pipeline } from '../ecs/pipeline'
import { createPipeline } from '../ecs/systems'
import { World } from '../ecs/world'
import type { Entity, WorldSnapshot } from '../ecs/world'
import type { Commands, SimContext, TeamController, TeamRuntime } from '../ecs/types'
import {
  Cell,
  Fx,
  Health,
  Motion,
  Order,
  PieceType,
  Position,
  Projectile,
  Stance,
  Target,
  Team,
  Weapon,
} from '../ecs/components'
import type { MotionData, OrderData, OrderStep } from '../ecs/components'
import { Board } from './board'
import type { BoardSize, Placement } from './boards'
import { createBoardData, initialArmy } from './boards'
import {
  BOTTOM_FRACTION_DEFAULT,
  BOTTOM_FRACTION_MAX,
  BOTTOM_FRACTION_MIN,
  FIXED_DT,
  MAX_STEPS_PER_FRAME,
  PATH_BUDGET_PER_TICK,
  SPEEDS,
  TEAM_COLORS,
  TEAM_NAMES,
} from './constants'
import { coordName } from './coords'
import { containsCell, fireCells } from './geometry'
import type { OccupiedFn } from './geometry'
import { closestEmptyCell, firingPositionExists, previewFiringCell } from './approach'
import { createPiece } from './factory'
import { buildOccupancy, occupiedExcept } from './occupancy'
import type { Occupancy } from './occupancy'
import type { OrderKind, StanceMode, TeamId, Vec2 } from './types'
import { PIECE_LIST, PIECES, WEAPONS } from './pieces'
import { findPath } from './pathfind'
import { anchorFor, planStep } from './queue'
import { buildBoard, buildWorldSnapshot, serializePosition, validatePosition } from './position'
import type { SavedPosition } from './position'
import { formatForLlm, formatShorthand } from './shorthand'
import type { GameSettings, SettingsPatch } from './settings'
import { Rng } from './rng'

export type GameMode = 'human-vs-ai' | 'ai-vs-ai' | 'human-vs-human'

export const GAME_MODES: Array<{ id: GameMode; label: string }> = [
  { id: 'human-vs-ai', label: 'Human vs AI' },
  { id: 'ai-vs-ai', label: 'AI vs AI' },
  { id: 'human-vs-human', label: 'Human vs Human' },
]

export interface PieceSnapshot {
  key: string
  name: string
  glyph: string
  cost: number
  cap: number
  supply: number
  alive: number
}

export interface TeamSnapshot {
  id: TeamId
  name: string
  color: string
  controller: TeamController
  alive: number
  kills: number
  losses: number
  deployed: number
  supply: number
  pieces: PieceSnapshot[]
}

export interface ComponentLine {
  name: string
  value: string
}

export interface HoverPreview {
  entity: Entity
  cells: Vec2[]
  dest: Vec2 | null
  attack: boolean
}

/** A lightweight reference to a piece, for the inspector panel. */
export interface PieceRef {
  entity: Entity
  kind: string
  name: string
  glyph: string
  team: TeamId
  color: string
  coord: string
  health: { cur: number; max: number; ratio: number } | null
}

/** Everything the piece properties panel shows for the focused selection. */
export interface PieceInfo {
  entity: Entity
  kind: string
  name: string
  glyph: string
  team: TeamId
  color: string
  cell: Vec2
  coord: string
  health: { cur: number; max: number; ratio: number }
  weapon: { key: string; left: number; cooldown: number; ready: boolean; fired: boolean } | null
  stance: StanceMode
  commandable: boolean
  target: PieceRef | null
  underFire: { entity: Entity; coord: string } | null
  order: {
    kind: OrderKind
    dest: Vec2 | null
    destCoord: string | null
    target: PieceRef | null
    reachable: boolean
    regrouping: boolean
    parked: PieceRef | null
    queue: Array<{ kind: OrderStep['kind']; label: string }>
  }
  motion: {
    goal: Vec2 | null
    goalCoord: string | null
    pathLength: number
    blocked: boolean
    moving: boolean
    movedThisTurn: boolean
  }
}

export interface StanceSummary {
  none: number
  move: number
  attack: number
  mixed: boolean
}

export interface OverlayFlags {
  grid: boolean
  health: boolean
  myOrders: boolean
  enemyPlans: boolean
  moveCells: boolean
  attackCells: boolean
  rangeArcs: boolean
  reload: boolean
}

interface TurnState {
  world: WorldSnapshot
  rng: number
  tick: number
  turn: number
  teams: Record<TeamId, TeamRuntime>
  winner: TeamId | null
}

export interface GameSnapshot {
  running: boolean
  paused: boolean
  tick: number
  /** Monotonic turn index, matching the game's turn counter. */
  turn: number
  fps: number
  tps: number
  speed: number
  boardId: string
  boardSize: number
  boardSizes: number[]
  teams: Record<TeamId, TeamSnapshot>
  timings: Array<{ name: string; ema: number }>
  events: EventRecord[]
  eventCount: number
  shots: number
  kills: number
  warnings: number
  selected: Entity[]
  selectedLines: Array<{ entity: Entity; kind: string; lines: ComponentLine[] }>
  counts: { entities: number; pieces: number; projectiles: number; fx: number }
  winner: TeamId | null
  overlays: OverlayFlags
  hudVisible: boolean
  autoPreserve: boolean
  captureAdvance: boolean
  /** Whether combat sound effects are enabled. */
  soundEnabled: boolean
  /** Whether the left/right side rails (controls, stance, position) are shown. */
  railsVisible: boolean
  playerTeam: TeamId
  gameMode: GameMode
  gameModes: Array<{ id: GameMode; label: string }>
  hoverName: string | null
  hoverKind: 'empty' | 'friendly' | 'enemy' | 'blocked' | null
  turnActive: boolean
  /** Turns buffered by extra space presses, run back-to-back after the current one. */
  queuedTurns: number
  canReplay: boolean
  canUndo: boolean
  canRedo: boolean
  replaying: boolean
  /** Unified turn/replay bar fill (0..1); holds at 1 until the next action. */
  barProgress: number
  /** BAR-style command waiting for the next left-click (`none` = plain select). */
  pendingCommand: StanceMode
  selectionCount: number
  stanceSummary: StanceSummary
  /** Focused selected piece (first in the selection), for the properties panel. */
  pieceInfo: PieceInfo | null
  terrainVersion: number
}

function createTeamRuntime(controller: TeamController): TeamRuntime {
  const cooldown: Record<string, number> = {}
  const alive: Record<string, number> = {}
  for (const def of PIECE_LIST) {
    cooldown[def.key] = 0
    alive[def.key] = 0
  }
  return {
    controller,
    cooldown,
    alive,
    kills: 0,
    losses: 0,
    supply: 0,
    deployed: 0,
    movesMade: 0,
    movesThisTurn: 0,
  }
}

function controllersFor(mode: GameMode, playerTeam: TeamId): Record<TeamId, TeamController> {
  if (mode === 'ai-vs-ai') return { red: 'ai', blue: 'ai' }
  if (mode === 'human-vs-human') return { red: 'human', blue: 'human' }
  return playerTeam === 'blue' ? { red: 'ai', blue: 'human' } : { red: 'human', blue: 'ai' }
}

export class Game {
  world = new World()
  bus = new EventBus()
  pipeline: Pipeline = createPipeline()
  board: Board
  rng = new Rng()
  cmds: Commands = { damage: [], deploy: [], destroy: [], advance: [] }
  teams: Record<TeamId, TeamRuntime>
  occupancy = new Map<number, Entity>()

  tick = 0
  /** Monotonic turn index, incremented when each turn begins (drives regrouping). */
  turn = 0
  speed = 1
  running = false
  paused = false
  hudVisible = false
  railsVisible = true
  soundEnabled = false
  /** HUD bottom-panel height as a fraction of the viewport. */
  bottomFraction = BOTTOM_FRACTION_DEFAULT
  winner: TeamId | null = null
  terrainVersion = 0
  playerTeam: TeamId = 'blue'
  gameMode: GameMode = 'human-vs-ai'
  /** Hurt pieces step out of fire on their own, even without orders. */
  autoPreserve = true
  /** An idle killer steps onto the square of a piece it just killed. */
  captureAdvance = false
  /** Transient BAR-style command awaiting the next left-click. */
  pendingCommand: StanceMode = 'none'

  overlays: OverlayFlags = {
    grid: true,
    health: true,
    myOrders: true,
    enemyPlans: false,
    moveCells: true,
    attackCells: true,
    rangeArcs: false,
    reload: true,
  }

  selected: Entity[] = []
  hoverCell: Vec2 | null = null
  hoverPreview: HoverPreview[] = []
  hoverAttackTarget: Entity | null = null

  turnActive = false
  canReplay = false
  /** Unified turn/replay progress (0..1) shown by the wide bar. */
  barProgress = 0
  // Last two tick values for per-frame render interpolation.
  private barPrev = 0
  private barLast = 0
  /** Extra space-bar turns buffered while a turn/replay is already running. */
  queuedTurns = 0

  private turnSnapshot: TurnState | null = null
  private turnTicks = 0
  private turnMovesSeen = 0
  private turnNoProgressTicks = 0
  private lastTurn: { snapshot: TurnState; ticks: number } | null = null
  private replaying = false
  private replayTicks = 0
  // Turn-boundary states for undo/redo. `history[cursor]` is the state the game
  // is currently showing; `history.length - 1 === cursor` means "at the latest".
  private history: TurnState[] = []
  private cursor = 0
  /** Cap on retained turn states so long AI-vs-AI runs cannot grow unbounded. */
  private static readonly HISTORY_LIMIT = 100
  // Turns are serialized (one move at a time), so the cap is generous; the turn
  // normally ends as soon as every piece has moved or is blocked.
  private static readonly TURN_MAX_TICKS = 240
  /** Minimum sim time per turn (~1s) so reloads/fire advance even if nobody moves. */
  private static readonly MIN_TURN_TICKS = 30
  // Smallest per-tick bar advance so it never visibly freezes on a work plateau;
  // kept under (just-under-full / TURN_MAX_TICKS) so it can't reach the cap early.
  private static readonly BAR_MIN_STEP = 0.004
  /** Rough tick cost of one queued move, for shaping the bar only. */
  private static readonly NOMINAL_MOVE_TICKS = 5
  /** Cap on buffered space-bar turns, so a held key cannot queue a runaway. */
  private static readonly MAX_QUEUED_TURNS = 3

  fps = 0
  private tps = 0
  private ticksThisSecond = 0
  private secondTimer = 0
  private lastTime = 0
  private accumulator = 0
  private raf = 0
  private ctx: SimContext

  onFrame: ((alpha: number) => void) | null = null
  /** Per-frame turn/replay bar value (0..1), interpolated for smooth motion. */
  onProgress: ((value: number) => void) | null = null

  constructor(size: BoardSize = 8, mode: GameMode = 'human-vs-ai') {
    this.gameMode = mode
    const controllers = controllersFor(mode, this.playerTeam)
    this.teams = {
      red: createTeamRuntime(controllers.red),
      blue: createTeamRuntime(controllers.blue),
    }
    this.board = new Board(createBoardData(size))
    this.ctx = this.buildContext()
    this.placeArmy(initialArmy(size))
    this.history = [this.captureTurn()]
    this.cursor = 0
    this.paused = true
    this.bus.emit('map', `loaded ${this.board.data.name}`)
    this.bus.emit('info', 'paused \u2014 give orders, then press space for a turn')
  }

  setGameMode(mode: GameMode): void {
    this.gameMode = mode
    const controllers = controllersFor(mode, this.playerTeam)
    for (const id of ['red', 'blue'] as TeamId[]) {
      this.teams[id].controller = controllers[id]
    }
    this.bus.emit('info', `mode: ${mode} (you: ${this.playerTeam})`)
  }

  private buildContext(): SimContext {
    return {
      world: this.world,
      bus: this.bus,
      board: this.board,
      rng: this.rng,
      tick: this.tick,
      turn: this.turn,
      dt: FIXED_DT,
      cmds: this.cmds,
      teams: this.teams,
      occupancy: this.occupancy,
      pathBudget: PATH_BUDGET_PER_TICK,
      verbosePhases: this.pipeline.verbose,
      turnActive: this.turnActive,
      autoPreserve: this.autoPreserve,
      captureAdvance: this.captureAdvance,
    }
  }

  private placeArmy(army: Placement[]): void {
    for (const p of army) {
      const def = PIECES[p.key]
      if (!def) continue
      createPiece(this.ctx, p.team, def, { x: p.x, y: p.y })
      this.teams[p.team].alive[p.key] = (this.teams[p.team].alive[p.key] ?? 0) + 1
      this.teams[p.team].deployed++
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = 0
    this.raf = requestAnimationFrame(this.frame)
    this.bus.emit('boot', 'simulation started')
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  togglePause(): void {
    this.queuedTurns = 0
    if (this.turnActive) {
      this.turnActive = false
      this.paused = true
      this.bus.emit('info', 'turn cancelled')
      return
    }
    // A finished game stays frozen until it is undone.
    if (this.winner !== null) return
    if (this.replaying) this.replaying = false
    this.paused = !this.paused
    this.bus.emit('info', this.paused ? 'paused' : 'resumed')
  }

  stepOnce(): void {
    if (this.winner !== null) return
    this.queuedTurns = 0
    if (this.turnActive) this.turnActive = false
    if (this.replaying) this.replaying = false
    this.paused = true
    this.step()
    this.bus.emit('info', `stepped to tick ${this.tick}`)
  }

  /**
   * Advance the simulation by `n` fixed steps synchronously, bypassing the rAF
   * loop. Turns and replays keep running through `step`, so this drives them
   * deterministically for tests and tooling.
   */
  runTicks(n: number): void {
    for (let i = 0; i < n; i++) this.step()
  }

  /**
   * Request a turn: start one immediately when idle, otherwise buffer it so it
   * runs back-to-back once the current turn/replay finishes. This makes rapid
   * space presses (a double-tap) queue two turns instead of dropping the second.
   */
  queueTurn(): void {
    if (this.winner) return
    if (this.turnActive || this.replaying) {
      this.queuedTurns = Math.min(this.queuedTurns + 1, Game.MAX_QUEUED_TURNS)
      return
    }
    this.beginTurn()
  }

  /**
   * A "turn" is one movement step per piece. Every piece may make at most one
   * move, then the turn pauses (waiting for in-flight moves to land first).
   * Move cooldowns are cleared at the start so each piece is ready, which makes
   * turns short, readable beats rather than several seconds of real time.
   */
  beginTurn(): void {
    if (this.turnActive || this.replaying || this.winner !== null) return
    // Mutate first, then snapshot: replay must start from the exact turn-start
    // state (cooldowns cleared, movedThisTurn set) or it diverges.
    this.turn++
    this.turnTicks = 0
    for (const e of this.world.query(Motion)) {
      const motion = this.world.get(e, Motion)
      if (!motion) continue
      motion.cooldown = 0
      motion.movedThisTurn = motion.moving
    }
    this.teams.red.movesThisTurn = 0
    this.teams.blue.movesThisTurn = 0
    this.turnSnapshot = this.captureTurn()
    this.canReplay = false
    this.turnActive = true
    this.barProgress = 0
    this.turnMovesSeen = this.teams.red.movesMade + this.teams.blue.movesMade
    this.turnNoProgressTicks = 0
    this.paused = false
    this.bus.emit('info', 'turn started')
  }

  /** Step back one completed turn in the history. */
  undoTurn(): void {
    if (this.turnActive || this.replaying || this.cursor <= 0) return
    this.queuedTurns = 0
    this.restoreTurn(this.history[--this.cursor])
    this.selected = []
    this.barProgress = 0
    this.paused = true
    this.canReplay = this.cursor === this.history.length - 1 && this.lastTurn !== null
    this.bus.emit('info', `undo (turn ${this.cursor}/${this.history.length - 1})`)
  }

  /** Step forward to a turn previously undone. */
  redoTurn(): void {
    if (this.turnActive || this.replaying || this.cursor >= this.history.length - 1) return
    this.queuedTurns = 0
    this.restoreTurn(this.history[++this.cursor])
    this.selected = []
    this.barProgress = 0
    this.paused = true
    this.canReplay = this.cursor === this.history.length - 1 && this.lastTurn !== null
    this.bus.emit('info', `redo (turn ${this.cursor}/${this.history.length - 1})`)
  }

  replayTurn(): void {
    if (!this.lastTurn || this.replaying || this.turnActive || this.winner !== null) return
    // Replay only makes sense from the latest state: rewinding first would let
    // the replayed turn land ahead of the cursor and desync the history.
    if (this.cursor !== this.history.length - 1) return
    this.queuedTurns = 0
    this.restoreTurn(this.lastTurn.snapshot)
    this.selected = []
    this.replaying = true
    this.replayTicks = 0
    this.barProgress = 0
    this.paused = false
    this.bus.emit('info', `replaying last turn (${this.lastTurn.ticks} ticks)`)
  }

  private advanceTurn(): void {
    this.turnTicks++
    // Pending = pieces still able to make their one move (or mid-move); a piece
    // with no goal, or blocked with no route, counts as settled. `remaining`
    // estimates the ticks still needed (mirroring movement.ts travel), so the bar
    // can be driven by elapsed / (elapsed + remaining): always advancing, never
    // stalling on blocked pieces, and landing on 100% when the turn really ends.
    let pending = 0
    let remaining = 0
    for (const e of this.world.query(Motion)) {
      const motion = this.world.get(e, Motion)
      if (!motion) continue
      if (motion.moving) {
        pending++
        remaining += Math.max(0, (motion.travel - motion.elapsed) / FIXED_DT)
        continue
      }
      if (motion.movedThisTurn) continue
      if (!motion.goal || motion.path.length === 0) continue
      pending++
      // Nominal cost of one move (~0.16s) keeps this cheap: it only needs to
      // shape the bar, not be exact.
      remaining += Game.NOMINAL_MOVE_TICKS
    }

    // Watch for a stall: blocked pieces can keep reporting a non-empty route
    // forever, so end the turn once no move has started for a while.
    const moves = this.teams.red.movesMade + this.teams.blue.movesMade
    if (moves !== this.turnMovesSeen) {
      this.turnMovesSeen = moves
      this.turnNoProgressTicks = 0
    } else {
      this.turnNoProgressTicks++
    }

    // Keep the minimum beat in the denominator so the bar does not reach full
    // before the turn's floor; ease the tail out as the stall timer or hard cap
    // approaches so it still glides to 100% at the end. The work estimate can
    // rise when pieces replan, so the bar is floored to a small forward step
    // every tick: it tracks real progress but never freezes.
    const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
    remaining = Math.max(remaining, Game.MIN_TURN_TICKS - this.turnTicks)
    remaining *= 1 - clamp01(this.turnNoProgressTicks / 45)
    remaining = Math.min(remaining, Game.TURN_MAX_TICKS - this.turnTicks)
    remaining = Math.max(0, remaining)
    const candidate = this.turnTicks / (this.turnTicks + remaining + 1e-6)
    this.barProgress = Math.min(1, Math.max(this.barProgress + Game.BAR_MIN_STEP, candidate))

    const stalled = this.turnNoProgressTicks >= 45
    if ((pending === 0 || stalled) && this.turnTicks >= Game.MIN_TURN_TICKS) {
      this.finishTurn()
      return
    }
    if (this.turnTicks >= Game.TURN_MAX_TICKS) {
      this.snapMoves()
      this.finishTurn()
    }
  }

  /** Settle any in-flight animation onto its logical cell (deterministic). */
  private snapMoves(): void {
    for (const e of this.world.query(Motion, Cell, Position)) {
      const motion = this.world.get(e, Motion)
      const cell = this.world.get(e, Cell)
      const pos = this.world.get(e, Position)
      if (!motion || !cell || !pos || !motion.moving) continue
      const dest = this.board.worldToCell(motion.toX, motion.toY)
      cell.x = dest.x
      cell.y = dest.y
      pos.x = motion.toX
      pos.y = motion.toY
      motion.moving = false
      motion.reserved = null
    }
  }

  private finishTurn(): void {
    this.turnActive = false
    this.barProgress = 1
    this.paused = true
    if (this.turnSnapshot) {
      this.lastTurn = { snapshot: this.turnSnapshot, ticks: this.turnTicks }
      this.turnSnapshot = null
      // A completed turn is a new history boundary; anything undone is replaced.
      this.history.length = this.cursor + 1
      this.history.push(this.captureTurn())
      if (this.history.length > Game.HISTORY_LIMIT) this.history.shift()
      this.cursor = this.history.length - 1
      this.canReplay = true
    }
    this.bus.emit('info', `turn ended after ${this.turnTicks} ticks`)
    // A buffered space press starts the next turn immediately, back-to-back.
    if (this.queuedTurns > 0 && !this.winner) {
      this.queuedTurns--
      this.beginTurn()
    }
  }

  private captureTurn(): TurnState {
    return {
      world: this.world.capture(),
      rng: this.rng.getState(),
      tick: this.tick,
      turn: this.turn,
      teams: structuredClone(this.teams),
      winner: this.winner,
    }
  }

  private restoreTurn(state: TurnState): void {
    this.world.restore(state.world)
    this.rng.setState(state.rng)
    this.tick = state.tick
    this.turn = state.turn
    // Mutate the existing team objects in place: `ctx.teams` already points at
    // this record, so replacing it would leave systems writing to a stale copy.
    for (const id of ['red', 'blue'] as TeamId[]) {
      this.teams[id] = structuredClone(state.teams[id])
    }
    this.winner = state.winner
    this.occupancy.clear()
    this.selected = this.selected.filter((e) => this.world.isAlive(e))
  }

  setSpeed(speed: number): void {
    this.speed = speed
    this.bus.emit('info', `speed x${speed}`)
  }

  /** Current UI/session preferences, ready to persist. */
  settings(): GameSettings {
    return {
      overlays: { ...this.overlays },
      hudVisible: this.hudVisible,
      railsVisible: this.railsVisible,
      speed: this.speed,
      gameMode: this.gameMode,
      autoPreserve: this.autoPreserve,
      captureAdvance: this.captureAdvance,
      soundEnabled: this.soundEnabled,
      bottomFraction: this.bottomFraction,
    }
  }

  /**
   * Apply persisted preferences, validating every field so a stale or corrupt
   * entry cannot leave the game in an invalid state.
   */
  applySettings(settings: SettingsPatch): void {
    if (settings.overlays) {
      for (const key of Object.keys(this.overlays) as Array<keyof OverlayFlags>) {
        const value = settings.overlays[key]
        if (typeof value === 'boolean') this.overlays[key] = value
      }
    }
    if (typeof settings.hudVisible === 'boolean') this.hudVisible = settings.hudVisible
    if (typeof settings.railsVisible === 'boolean') this.railsVisible = settings.railsVisible
    if (typeof settings.speed === 'number' && SPEEDS.includes(settings.speed)) this.speed = settings.speed
    if (typeof settings.autoPreserve === 'boolean') this.autoPreserve = settings.autoPreserve
    if (typeof settings.captureAdvance === 'boolean') this.captureAdvance = settings.captureAdvance
    if (typeof settings.soundEnabled === 'boolean') this.soundEnabled = settings.soundEnabled
    if (
      typeof settings.bottomFraction === 'number' &&
      Number.isFinite(settings.bottomFraction) &&
      settings.bottomFraction >= BOTTOM_FRACTION_MIN &&
      settings.bottomFraction <= BOTTOM_FRACTION_MAX
    ) {
      this.bottomFraction = settings.bottomFraction
    }
    if (settings.gameMode && GAME_MODES.some((m) => m.id === settings.gameMode)) {
      this.setGameMode(settings.gameMode)
    }
  }

  setAutoPreserve(value: boolean): void {
    this.autoPreserve = value
    this.bus.emit('info', `auto-preserve ${value ? 'on' : 'off'}`)
  }

  setCaptureAdvance(value: boolean): void {
    this.captureAdvance = value
    this.bus.emit('info', `capture advance ${value ? 'on' : 'off'}`)
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame)
    if (this.lastTime === 0) this.lastTime = now
    const delta = (now - this.lastTime) / 1000
    this.lastTime = now

    this.secondTimer += delta
    if (this.secondTimer >= 1) {
      this.fps = Math.round(1 / Math.max(delta, 0.0001))
      this.tps = this.ticksThisSecond
      this.ticksThisSecond = 0
      this.secondTimer = 0
    }

    // Absorb out-of-band changes (turn start, undo/redo, reset) as an instant
    // snap; in-step changes below become the interpolation target.
    if (this.barProgress !== this.barLast) {
      this.barPrev = this.barProgress
      this.barLast = this.barProgress
    }
    if (!this.paused) {
      // Turns and replays both play at half speed (one move at a time).
      const scale = this.turnActive || this.replaying ? 0.5 : this.speed
      this.accumulator += delta * scale
      let steps = 0
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.step()
        this.accumulator -= FIXED_DT
        steps++
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0
    }
    if (this.barProgress !== this.barLast) {
      this.barPrev = this.barLast
      this.barLast = this.barProgress
    }

    const alpha = Math.min(1, this.accumulator / FIXED_DT)
    this.onFrame?.(alpha)
    // Interpolate between the last two tick values so the bar sweeps smoothly
    // rather than stepping at the (half-speed) simulation tick rate. When the
    // sim is paused (turn/replay over) settle on the latest value so it cannot
    // freeze a fraction short of full.
    const barAlpha = this.paused ? 1 : alpha
    this.onProgress?.(this.barPrev + (this.barLast - this.barPrev) * barAlpha)
  }

  private step(): void {
    // Once a winner is decided the battle is frozen; undo (or redo) rewinds it.
    // A replay is exempt so it can reproduce the fatal turn exactly.
    if (this.winner !== null && !this.replaying) return
    this.ctx.tick = this.tick
    this.ctx.turn = this.turn
    this.ctx.verbosePhases = this.pipeline.verbose
    // Runtime toggles are copied onto the shared context here so toolbar changes
    // take effect immediately rather than only after a reset/import.
    this.ctx.autoPreserve = this.autoPreserve
    this.ctx.captureAdvance = this.captureAdvance
    // A replay re-runs a recorded turn, so the one-move-per-turn gate must apply.
    this.ctx.turnActive = this.turnActive || this.replaying
    this.bus.tick = this.tick
    this.bus.phase = 'tick'
    this.pipeline.run(this.ctx)
    this.tick++
    this.ticksThisSecond++
    const before = this.winner
    this.updateWinner()

    // A king just fell during a live turn: close the turn (so the history
    // boundary is the pre-fatal state) and freeze. Undo reopens the game.
    if (this.winner !== null && before === null && !this.replaying) {
      this.endGame(this.winner)
      return
    }

    if (this.replaying) {
      this.replayTicks++
      const total = this.lastTurn?.ticks ?? 0
      this.barProgress = total > 0 ? Math.min(1, this.replayTicks / total) : 1
      if (this.replayTicks >= total) {
        this.replaying = false
        this.barProgress = 1
        this.paused = true
        this.bus.emit('info', 'replay finished')
        // A space press during the replay starts the queued turn right after it.
        if (this.queuedTurns > 0 && !this.winner) {
          this.queuedTurns--
          this.beginTurn()
        }
      }
      return
    }
    if (this.turnActive) this.advanceTurn()
  }

  /**
   * Chess-style decisive condition: a team is defeated the moment it has no
   * living king. If both kings fall on the same tick the battle is a draw and
   * play continues. Undo/redo/replay recompute this deterministically.
   */
  private updateWinner(): void {
    const redKing = this.teams.red.alive.king ?? 0
    const blueKing = this.teams.blue.alive.king ?? 0
    if (redKing > 0 && blueKing > 0) this.winner = null
    else if (redKing === 0 && blueKing > 0) this.winner = 'blue'
    else if (blueKing === 0 && redKing > 0) this.winner = 'red'
    else this.winner = null
  }

  /** Freeze the battle on a victory and record the state it ended on. */
  private endGame(winner: TeamId): void {
    if (this.turnActive) {
      this.finishTurn()
    } else {
      // A king can also fall while single-stepping outside a turn; record a
      // boundary so undo still has somewhere to go.
      this.history.length = this.cursor + 1
      this.history.push(this.captureTurn())
      if (this.history.length > Game.HISTORY_LIMIT) this.history.shift()
      this.cursor = this.history.length - 1
    }
    this.turnActive = false
    this.replaying = false
    this.barProgress = 1
    this.paused = true
    this.bus.emit('win', `${TEAM_NAMES[winner]} wins \u2014 undo (u) to continue`, { team: winner })
  }

  loadSize(size: BoardSize): void {
    this.world.clear()
    const controllers = controllersFor(this.gameMode, this.playerTeam)
    this.teams = {
      red: createTeamRuntime(controllers.red),
      blue: createTeamRuntime(controllers.blue),
    }
    this.board = new Board(createBoardData(size))
    this.occupancy.clear()
    this.tick = 0
    this.turn = 0
    this.rng.reset()
    this.selected = []
    this.winner = null
    this.turnActive = false
    this.replaying = false
    this.canReplay = false
    this.lastTurn = null
    this.turnSnapshot = null
    this.queuedTurns = 0
    this.paused = true
    this.ctx = this.buildContext()
    this.placeArmy(initialArmy(size))
    this.history = [this.captureTurn()]
    this.cursor = 0
    this.terrainVersion++
    this.bus.emit('map', `loaded ${this.board.data.name}`)
  }

  reset(): void {
    this.loadSize(this.board.width as BoardSize)
  }

  deploy(team: TeamId, key: string): void {
    this.cmds.deploy.push({ team, key })
  }

  /** World-pixel hit test; `additive` toggles the piece in the multi-selection. */
  selectAt(worldX: number, worldY: number, additive = false): Entity | null {
    let best: Entity | null = null
    let bestDist = Infinity
    const maxDist = (this.board.tile * 0.6) ** 2
    for (const e of this.world.query(Position, Cell)) {
      const pos = this.world.require(e, Position)
      const d = (pos.x - worldX) ** 2 + (pos.y - worldY) ** 2
      if (d < bestDist && d < maxDist) {
        bestDist = d
        best = e
      }
    }
    if (best === null) {
      if (!additive) this.selected = []
      return null
    }
    if (additive) {
      const idx = this.selected.indexOf(best)
      if (idx >= 0) this.selected.splice(idx, 1)
      else this.selected.push(best)
    } else {
      this.selected = [best]
    }
    return best
  }

  /** Select every piece whose position falls inside a world-space rectangle. */
  selectRect(ax: number, ay: number, bx: number, by: number, additive = false): void {
    const minX = Math.min(ax, bx)
    const maxX = Math.max(ax, bx)
    const minY = Math.min(ay, by)
    const maxY = Math.max(ay, by)
    const t = this.board.tile
    const chosen: Entity[] = []
    // Any cell the selection rectangle touches is selected (not just centers).
    for (const e of this.world.query(Position, Cell)) {
      const c = this.world.require(e, Cell)
      const x0 = c.x * t
      const y0 = c.y * t
      if (x0 + t >= minX && x0 <= maxX && y0 + t >= minY && y0 <= maxY) chosen.push(e)
    }
    if (additive) {
      for (const e of chosen) if (!this.selected.includes(e)) this.selected.push(e)
    } else {
      this.selected = chosen
    }
  }

  clearSelection(): void {
    this.selected = []
  }

  /**
   * Set the persistent stance of every selected commandable piece. Unlike an
   * order, this survives the order completing — `none` stands ground and only
   * fires in range, so it is the way to disengage a previously attacking piece.
   */
  setPieceStance(mode: StanceMode): void {
    let n = 0
    for (const e of this.selected) {
      if (!this.world.isAlive(e)) continue
      const team = this.world.get(e, Team)
      if (!team || !this.commandable(team)) continue
      const stance = this.world.get(e, Stance)
      if (stance) stance.mode = mode
      n++
    }
    this.bus.emit('info', `${n} piece(s) stance: ${mode}`)
  }

  /** Arm a BAR-style command prefix for the next left-click. */
  setPendingCommand(mode: StanceMode): void {
    this.pendingCommand = mode
    if (mode !== 'none') this.bus.emit('info', `${mode} command: left-click a target (shift to queue)`)
  }

  clearPendingCommand(): void {
    this.pendingCommand = 'none'
  }

  /** A piece can be commanded only when its team is under human control. */
  private commandable(team: TeamId): boolean {
    return this.teams[team].controller === 'human'
  }

  /**
   * Issue an order at `cell` for every selected commandable piece.
   *
   * `command` is the resolved intent: an explicit `attack` (from an `a`
   * prefix or a right-click on an enemy) requires an enemy occupant, an explicit
   * `move` always creates a goto, and when omitted the square's occupant decides
   * (enemy → attack, friendly → ignored, empty → move). A piece with nothing
   * planned starts the order; otherwise the click appends a queued step. A move
   * on an un-queued attacker suspends/regroups instead of queueing behind it.
   */
  orderAt(cell: Vec2, command?: 'move' | 'attack'): void {
    if (!this.board.inBounds(cell.x, cell.y)) return
    const occ = buildOccupancy(this.world, this.board)
    const occupant = occ.get(cell.y * this.board.width + cell.x)
    let n = 0
    let skippedAttack = false
    for (const e of this.selected) {
      if (!this.world.isAlive(e)) continue
      const order = this.world.get(e, Order)
      const motion = this.world.get(e, Motion)
      const team = this.world.get(e, Team)
      if (!order || !motion || !team) continue
      if (!this.commandable(team)) continue
      const occupantTeam = occupant !== undefined && occupant !== e ? this.world.get(occupant, Team) : undefined
      const enemyOccupied =
        occupant !== undefined && occupant !== e && occupantTeam !== undefined && occupantTeam !== team
      const friendlyOccupied = occupant !== undefined && occupant !== e && occupantTeam === team
      // A context right-click on a friendly square is a no-op (as in BAR).
      if (command === undefined && friendlyOccupied) continue
      // An explicit move never attacks; otherwise the occupant decides.
      const attacking = command === 'move' ? false : enemyOccupied
      if (command === 'attack' && !enemyOccupied) {
        skippedAttack = true
        continue
      }
      const activeEmpty = order.kind === 'none' && order.queue.length === 0

      if (activeEmpty) {
        if (attacking) this.startAttack(e, order, motion, occupant as Entity)
        else this.startGoto(e, order, motion, cell, occ, team)
      } else if (order.kind === 'attack' && order.queue.length === 0 && !attacking) {
        // A move issued on an un-queued attacking piece suspends the attack:
        // park the target so it resumes after the regroup window.
        this.startGoto(e, order, motion, cell, occ, team)
      } else {
        this.appendStep(e, order, motion, cell, attacking ? (occupant as Entity) : null, team)
      }
      n++
    }
    if (skippedAttack && n === 0) {
      this.bus.emit('warn', 'attack needs an enemy target')
      return
    }
    if (occupant !== undefined && this.world.get(occupant, Team) !== undefined) {
      this.bus.emit('info', `orders: ${n} at #${occupant} (${coordName(cell.x, cell.y, this.board.height)})`)
    } else {
      this.bus.emit('info', `orders: ${n} move toward ${coordName(cell.x, cell.y, this.board.height)}`)
    }
  }

  private startAttack(e: Entity, order: OrderData, motion: MotionData, target: Entity): void {
    order.kind = 'attack'
    order.target = target
    order.dest = null
    order.resumeTarget = null
    order.resumeTurn = -1
    motion.goal = null
    motion.path = []
    motion.arrived = true
    // Plan the route to a firing position now so it is visible while paused.
    order.reachable = this.planAttack(e, motion, target)
  }

  private startGoto(
    e: Entity,
    order: OrderData,
    motion: MotionData,
    cell: Vec2,
    occ: Occupancy,
    team: TeamId,
  ): void {
    const parked =
      order.kind === 'attack' &&
      order.target !== null &&
      this.world.isAlive(order.target) &&
      this.world.has(order.target, Cell)
        ? order.target
        : order.resumeTarget
    order.kind = 'goto'
    order.dest = { x: cell.x, y: cell.y }
    order.target = null
    order.resumeTarget = parked
    order.resumeTurn = -1
    // A plain move must not leave a stale combat target behind; a suspended
    // attack keeps lastAttacker/underFire so it can still kite while retreating.
    const t = this.world.get(e, Target)
    if (t && parked === null) {
      t.entity = null
      t.lastAttacker = null
    }
    motion.goal = { x: cell.x, y: cell.y }
    // Fall back to a friendly-passable route when boxed in, so a blocked move
    // still shows a path instead of a bare straight line.
    this.planNow(e, motion, cell, occupiedExcept(this.board, occ, e), this.friendlyPass(occ, e, team))
  }

  private appendStep(
    e: Entity,
    order: OrderData,
    motion: MotionData,
    cell: Vec2,
    attackTarget: Entity | null,
    team: TeamId,
  ): void {
    const kind = this.world.get(e, PieceType)?.kind
    const from = this.world.get(e, Cell)
    const def = kind ? PIECES[kind] : undefined
    if (!def || !from) return
    const last = order.queue[order.queue.length - 1] ?? null
    const anchor = anchorFor(order, motion, from)

    if (attackTarget !== null) {
      if (
        (order.kind === 'attack' && order.target === attackTarget) ||
        (last?.kind === 'attack' && last.target === attackTarget)
      ) {
        return
      }
      const tcell = this.world.get(attackTarget, Cell) ?? null
      const step: OrderStep = { kind: 'attack', target: attackTarget, path: [], goal: null, reachable: true }
      planStep(this.board, anchor, step, def, team, tcell)
      order.queue.push(step)
      return
    }

    if (
      (order.kind === 'goto' && order.dest && order.dest.x === cell.x && order.dest.y === cell.y) ||
      (last?.kind === 'goto' && last.dest.x === cell.x && last.dest.y === cell.y)
    ) {
      return
    }
    const step: OrderStep = { kind: 'goto', dest: { x: cell.x, y: cell.y }, path: [] }
    planStep(this.board, anchor, step, def, team)
    order.queue.push(step)
  }

  clearOrders(): void {
    let n = 0
    for (const e of this.selected) {
      if (!this.world.isAlive(e)) continue
      const team = this.world.get(e, Team)
      if (!team || !this.commandable(team)) continue
      const order = this.world.get(e, Order)
      const motion = this.world.get(e, Motion)
      if (order) {
        order.kind = 'none'
        order.dest = null
        order.target = null
        order.resumeTarget = null
        order.resumeTurn = -1
        order.queue.length = 0
      }
      if (motion) {
        motion.goal = null
        motion.path = []
        motion.arrived = true
      }
      // Drop the current engagement too, so the target line clears immediately.
      // Stance is untouched: set it to `none` in the panel to stop auto-engage.
      const target = this.world.get(e, Target)
      if (target) {
        target.entity = null
        target.retargetAt = 0
      }
      n++
    }
    this.bus.emit('info', `${n} piece(s) order${n === 1 ? '' : 's'} cleared`)
  }

  /** Hover feedback and per-piece order preview (computed once per hovered cell). */
  setHover(cell: Vec2 | null): void {
    if (cell && this.hoverCell && cell.x === this.hoverCell.x && cell.y === this.hoverCell.y) return
    if (!cell && this.hoverCell === null) return
    this.hoverCell = cell ? { x: cell.x, y: cell.y } : null
    this.hoverPreview = []
    this.hoverAttackTarget = null
    if (!cell || !this.board.inBounds(cell.x, cell.y) || this.selected.length === 0) return

    const occ = buildOccupancy(this.world, this.board)
    const occupant = occ.get(cell.y * this.board.width + cell.x)
    for (const e of this.selected) {
      if (!this.world.isAlive(e)) continue
      const team = this.world.get(e, Team)
      const fromCell = this.world.get(e, Cell)
      const kind = this.world.get(e, PieceType)?.kind
      if (!team || !fromCell || !kind) continue
      if (!this.commandable(team)) continue
      const def = PIECES[kind]
      if (!def) continue
      const occupantTeam = occupant !== undefined && occupant !== e ? this.world.get(occupant, Team) : undefined
      if (occupant !== undefined && occupant !== e && occupantTeam !== undefined && occupantTeam !== team) {
        this.hoverAttackTarget = occupant
        this.hoverPreview.push({ entity: e, cells: [], dest: { x: cell.x, y: cell.y }, attack: true })
        continue
      }
      const blocked = occupiedExcept(this.board, occ, e)
      // With a queue, preview the appended leg from the end of the plan.
      const order = this.world.get(e, Order)
      const motion = this.world.get(e, Motion)
      const from = order && order.queue.length > 0 && motion ? anchorFor(order, motion, fromCell) : fromCell
      const result = findPath(this.board, from, cell, def.move, team, blocked)
      const dest = result.cells.length > 0 ? result.cells[result.cells.length - 1] : null
      this.hoverPreview.push({ entity: e, cells: result.cells, dest, attack: false })
    }
  }

  toDebugJson(): unknown {
    const occ = buildOccupancy(this.world, this.board)
    const pieces: unknown[] = []
    for (const e of this.world.query(Position, Cell, Team, PieceType)) {
      const pos = this.world.require(e, Position)
      const cell = this.world.require(e, Cell)
      const team = this.world.require(e, Team)
      const kind = this.world.require(e, PieceType).kind
      const hp = this.world.get(e, Health)
      const stance = this.world.get(e, Stance)
      const order = this.world.get(e, Order)
      const target = this.world.get(e, Target)
      const motion = this.world.get(e, Motion)
      pieces.push({
        e,
        team,
        kind,
        cell: { x: cell.x, y: cell.y },
        name: coordName(cell.x, cell.y, this.board.height),
        pos: { x: Math.round(pos.x), y: Math.round(pos.y) },
        hp: hp ? { cur: hp.cur, max: hp.max } : null,
        stance: stance?.mode ?? null,
        order: order
          ? {
              kind: order.kind,
              dest: order.dest,
              target: order.target,
              reachable: order.reachable,
              resumeTarget: order.resumeTarget,
              resumeTurn: order.resumeTurn,
              queue: order.queue,
            }
          : null,
        target: target ? { entity: target.entity, lastAttacker: target.lastAttacker } : null,
        motion: motion
          ? {
              goal: motion.goal,
              blocked: motion.blocked,
              moving: motion.moving,
              cooldown: Math.round(motion.cooldown * 100) / 100,
              path: motion.path,
            }
          : null,
      })
    }
    return {
      boardId: this.board.data.id,
      size: this.board.width,
      tile: this.board.tile,
      terrain: Array.from(this.board.terrain),
      tick: this.tick,
      gameMode: this.gameMode,
      playerTeam: this.playerTeam,
      turnActive: this.turnActive,
      selected: this.selected.slice(),
      occupancyCells: occ.size,
      teams: { red: this.teams.red, blue: this.teams.blue },
      pieces,
    }
  }

  /**
   * A complete, JSON-serializable snapshot of the battle (terrain, every
   * component, RNG, teams). Round-trips through `importPosition`; used by save
   * slots and export/copy.
   */
  exportPosition(): SavedPosition {
    return serializePosition(this)
  }

  /** Compact, read-oriented position dump for debugging (not importable). */
  shorthand(): string {
    return formatShorthand(this)
  }

  /** `shorthand()` prefixed with a one-time explanation for an LLM. */
  llmShorthand(): string {
    return formatForLlm(this)
  }

  /**
   * Replace the current battle with a previously exported position. Returns an
   * error instead of mutating the game when the data is malformed.
   */
  importPosition(data: unknown): { ok: true } | { ok: false; error: string } {
    const valid = validatePosition(data)
    if (!valid.ok) return valid
    const saved = data as SavedPosition

    this.world.clear()
    this.world.restore(buildWorldSnapshot(saved))
    this.board = buildBoard(saved)

    this.rng.setState(saved.rng)
    this.tick = saved.tick
    this.turn = saved.turn
    this.winner = saved.winner
    this.teams = structuredClone(saved.teams)
    this.gameMode = saved.gameMode
    this.playerTeam = saved.playerTeam
    this.pendingCommand = 'none'
    this.overlays = { ...this.overlays, ...saved.overlays }

    this.occupancy.clear()
    this.selected = []
    this.hoverCell = null
    this.hoverPreview = []
    this.hoverAttackTarget = null
    this.cmds.damage.length = 0
    this.cmds.deploy.length = 0
    this.cmds.destroy.length = 0

    this.turnActive = false
    this.replaying = false
    this.canReplay = false
    this.queuedTurns = 0
    this.turnSnapshot = null
    this.lastTurn = null
    this.turnTicks = 0
    this.barProgress = 0
    this.replayTicks = 0
    this.accumulator = 0
    this.paused = true

    this.terrainVersion++
    this.ctx = this.buildContext()
    this.history = [this.captureTurn()]
    this.cursor = 0

    this.bus.emit('map', `loaded position ${this.board.data.name}`)
    this.bus.emit('info', `position loaded (tick ${this.tick})`)
    return { ok: true }
  }

  /**
   * Route an attack order to the nearest firing position (skipped if in range).
   * Returns whether the target is positionally reachable at all.
   */
  private planAttack(e: Entity, motion: MotionData, target: Entity): boolean {
    const cell = this.world.get(e, Cell)
    const kind = this.world.get(e, PieceType)?.kind
    const team = this.world.get(e, Team)
    const tcell = this.world.get(target, Cell)
    if (!cell || !kind || !team || !tcell) return false
    const def = PIECES[kind]
    if (!def) return false
    const geometry = WEAPONS[def.weapon].geometry
    const occ = buildOccupancy(this.world, this.board)
    const blocked = occupiedExcept(this.board, occ, e)
    const reachable = firingPositionExists(this.board, cell, tcell, def.move, geometry, team)
    if (containsCell(fireCells(this.board, cell, geometry, team, blocked), tcell.x, tcell.y)) {
      motion.goal = null
      motion.path = []
      return true
    }
    // Navigation is theoretical (future): other pieces are assumed to move, so
    // the route only avoids walls and the target's own square and is shown even
    // when the board is currently blocked. It should still end on a real square,
    // so the goal is chosen against the live board (a firing cell, else the
    // closest empty reachable cell). The firing line itself is judged against
    // the live board: clear / blocked / out of reach.
    const targetIdx = tcell.y * this.board.width + tcell.x
    const planOccupied: OccupiedFn = (x, y) => y * this.board.width + x === targetIdx
    const goal =
      previewFiringCell(this.board, cell, tcell, def.move, geometry, team, blocked) ??
      closestEmptyCell(this.board, cell, tcell, def.move, team, blocked) ??
      { x: tcell.x, y: tcell.y }
    motion.goal = goal
    this.planNow(e, motion, goal, planOccupied)
    return reachable
  }

  private planNow(e: Entity, motion: MotionData, dest: Vec2, occupied: OccupiedFn, fallback?: OccupiedFn): void {
    const cell = this.world.get(e, Cell)
    const kind = this.world.get(e, PieceType)?.kind
    const team = this.world.get(e, Team)
    if (!cell || !kind || !team) return
    const def = PIECES[kind]
    if (!def) return
    let result = findPath(this.board, cell, dest, def.move, team, occupied)
    if (!result.found && result.cells.length === 0 && fallback) {
      result = findPath(this.board, cell, dest, def.move, team, fallback)
    }
    motion.path = result.cells
    motion.replanAt = this.tick + 15
    motion.blocked = !result.found
  }

  /** Treats friendly pieces as passable (they move); enemies and walls block. */
  private friendlyPass(occ: Occupancy, self: Entity, team: TeamId): OccupiedFn {
    return (x, y) => {
      const other = occ.get(y * this.board.width + x)
      if (other === undefined || other === self) return false
      return this.world.get(other, Team) !== team
    }
  }

  paint(x: number, y: number, terrain: number): void {
    if (!this.board.inBounds(x, y)) return
    if (this.board.terrainAt(x, y) === terrain) return
    this.board.setTerrain(x, y, terrain)
    this.terrainVersion++
  }

  private hoverKind(): 'empty' | 'friendly' | 'enemy' | 'blocked' | null {
    const cell = this.hoverCell
    if (!cell || !this.board.inBounds(cell.x, cell.y)) return null
    const occupant = buildOccupancy(this.world, this.board).get(cell.y * this.board.width + cell.x)
    if (occupant !== undefined) {
      return this.world.get(occupant, Team) === this.playerTeam ? 'friendly' : 'enemy'
    }
    return this.board.passable(cell.x, cell.y) ? 'empty' : 'blocked'
  }

  snapshot(): GameSnapshot {
    const pieces = this.world.query(Position, Cell).length
    const projectiles = this.world.query(Projectile, Position).length
    const fx = this.world.query(Fx).length

    const stanceSummary = this.stanceSummary()
    const focused = this.selected.find((e) => this.world.isAlive(e))
    const pieceInfo = focused !== undefined ? this.pieceInfo(focused) : null

    const teams = {} as Record<TeamId, TeamSnapshot>
    for (const id of ['red', 'blue'] as TeamId[]) {
      const runtime = this.teams[id]
      teams[id] = {
        id,
        name: TEAM_NAMES[id],
        color: TEAM_COLORS[id],
        controller: runtime.controller,
        alive: Object.values(runtime.alive).reduce((a, b) => a + b, 0),
        kills: runtime.kills,
        losses: runtime.losses,
        deployed: runtime.deployed,
        supply: runtime.supply,
        pieces: PIECE_LIST.map((p) => ({
          key: p.key,
          name: p.name,
          glyph: p.glyph,
          cost: p.buildTime,
          cap: p.cap,
          supply: p.supply,
          alive: runtime.alive[p.key] ?? 0,
        })),
      }
    }

    return {
      running: this.running,
      paused: this.paused,
      tick: this.tick,
      turn: this.turn,
      fps: this.fps,
      tps: this.tps,
      speed: this.speed,
      boardId: this.board.data.id,
      boardSize: this.board.width,
      boardSizes: [8, 16, 32, 64],
      teams,
      timings: this.pipeline.timings.map((t) => ({ name: t.name, ema: t.ema })),
      events: this.bus.tail(600),
      eventCount: this.bus.total,
      shots: this.bus.count('shot'),
      kills: this.bus.count('kill'),
      warnings: this.bus.count('warn'),
      selected: this.selected.slice(),
      selectedLines: this.selected.map((e) => ({
        entity: e,
        kind: this.world.get(e, PieceType)?.kind ?? '?',
        lines: this.inspect(e),
      })),
      counts: { entities: this.world.count, pieces, projectiles, fx },
      winner: this.winner,
      overlays: { ...this.overlays },
      hudVisible: this.hudVisible,
      autoPreserve: this.autoPreserve,
      captureAdvance: this.captureAdvance,
      soundEnabled: this.soundEnabled,
      railsVisible: this.railsVisible,
      playerTeam: this.playerTeam,
      gameMode: this.gameMode,
      gameModes: GAME_MODES,
      hoverName: this.hoverCell ? coordName(this.hoverCell.x, this.hoverCell.y, this.board.height) : null,
      hoverKind: this.hoverKind(),
      turnActive: this.turnActive,
      queuedTurns: this.queuedTurns,
      canReplay: this.canReplay,
      canUndo: this.cursor > 0 && !this.turnActive && !this.replaying,
      canRedo: this.cursor < this.history.length - 1 && !this.turnActive && !this.replaying,
      replaying: this.replaying,
      barProgress: this.barProgress,
      pendingCommand: this.pendingCommand,
      selectionCount: this.selected.filter((e) => this.world.isAlive(e)).length,
      stanceSummary,
      pieceInfo,
      terrainVersion: this.terrainVersion,
    }
  }

  private stanceSummary(): StanceSummary {
    const summary: StanceSummary = { none: 0, move: 0, attack: 0, mixed: false }
    for (const e of this.selected) {
      if (!this.world.isAlive(e)) continue
      const mode = this.world.get(e, Stance)?.mode ?? 'none'
      summary[mode]++
    }
    const kinds = (['none', 'move', 'attack'] as const).filter((k) => summary[k] > 0)
    summary.mixed = kinds.length > 1
    return summary
  }

  private pieceRef(e: Entity): PieceRef | null {
    if (!this.world.isAlive(e)) return null
    const kind = this.world.get(e, PieceType)?.kind ?? '?'
    const def = PIECES[kind]
    const cell = this.world.get(e, Cell)
    const team = this.world.get(e, Team)
    if (!cell || !team) return null
    const hp = this.world.get(e, Health)
    return {
      entity: e,
      kind,
      name: def?.name ?? kind,
      glyph: def?.glyph ?? '?',
      team,
      color: TEAM_COLORS[team],
      coord: coordName(cell.x, cell.y, this.board.height),
      health: hp ? { cur: hp.cur, max: hp.max, ratio: hp.max > 0 ? hp.cur / hp.max : 0 } : null,
    }
  }

  /** Curated view of one piece for the properties panel. */
  private pieceInfo(e: Entity): PieceInfo | null {
    const ref = this.pieceRef(e)
    const cell = this.world.get(e, Cell)
    const kind = this.world.get(e, PieceType)?.kind
    const def = kind ? PIECES[kind] : undefined
    if (!ref || !cell || !def) return null
    const hp = this.world.get(e, Health)
    const stance = this.world.get(e, Stance)?.mode ?? 'none'
    const order = this.world.get(e, Order)
    const motion = this.world.get(e, Motion)
    const target = this.world.get(e, Target)
    const weapon = this.world.get(e, Weapon)
    const wdef = WEAPONS[def.weapon]
    const team = this.world.get(e, Team)
    const coord = (c: Vec2 | null | undefined): string | null =>
      c ? coordName(c.x, c.y, this.board.height) : null

    const queue = (order?.queue ?? []).map((step) => ({
      kind: step.kind,
      label:
        step.kind === 'goto'
          ? `move ${coord(step.dest) ?? '—'}`
          : `attack ${this.pieceRef(step.target)?.coord ?? '—'}`,
    }))

    return {
      entity: e,
      kind: ref.kind,
      name: ref.name,
      glyph: ref.glyph,
      team: ref.team,
      color: ref.color,
      cell: { x: cell.x, y: cell.y },
      coord: ref.coord,
      health: hp ? { cur: hp.cur, max: hp.max, ratio: hp.max > 0 ? hp.cur / hp.max : 0 } : { cur: 0, max: 0, ratio: 0 },
      weapon: weapon
        ? { key: wdef.key, left: weapon.left, cooldown: wdef.cooldown, ready: weapon.left <= 0, fired: weapon.fired }
        : null,
      stance,
      commandable: team !== undefined && this.commandable(team),
      target: target?.entity != null ? this.pieceRef(target.entity) : null,
      underFire:
        target?.lastAttacker != null && this.tick < target.underFireUntil && this.world.isAlive(target.lastAttacker)
          ? { entity: target.lastAttacker, coord: this.pieceRef(target.lastAttacker)?.coord ?? '—' }
          : null,
      order: {
        kind: order?.kind ?? 'none',
        dest: order?.dest ?? null,
        destCoord: coord(order?.dest),
        target: order?.target != null ? this.pieceRef(order.target) : null,
        reachable: order?.reachable ?? true,
        regrouping: (order?.resumeTarget ?? null) !== null && (order?.resumeTurn ?? -1) >= 0,
        parked: order?.resumeTarget != null ? this.pieceRef(order.resumeTarget) : null,
        queue,
      },
      motion: {
        goal: motion?.goal ?? null,
        goalCoord: coord(motion?.goal),
        pathLength: motion?.path.length ?? 0,
        blocked: motion?.blocked ?? false,
        moving: motion?.moving ?? false,
        movedThisTurn: motion?.movedThisTurn ?? false,
      },
    }
  }

  private inspect(e: Entity): ComponentLine[] {
    if (!this.world.isAlive(e)) return []
    const lines: ComponentLine[] = []
    for (const store of this.world.allStores) {
      const value = store.map.get(e)
      if (value === undefined) continue
      lines.push({ name: store.name, value: formatValue(value) })
    }
    return lines
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100)
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))
  } catch {
    return String(value)
  }
}
