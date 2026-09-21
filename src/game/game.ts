import { EventBus } from '../ecs/events'
import type { EventRecord } from '../ecs/events'
import { Pipeline } from '../ecs/pipeline'
import { createPipeline } from '../ecs/systems'
import { World } from '../ecs/world'
import type { Entity, WorldSnapshot } from '../ecs/world'
import type { Commands, SimContext, TeamController, TeamRuntime } from '../ecs/types'
import { Cell, Fx, Intent, Motion, PieceType, Position, Projectile, Team } from '../ecs/components'
import type { MotionData } from '../ecs/components'
import { Board } from './board'
import type { BoardSize, Placement } from './boards'
import { createBoardData, initialArmy } from './boards'
import { FIXED_DT, MAX_STEPS_PER_FRAME, PATH_BUDGET_PER_TICK, TEAM_COLORS, TEAM_NAMES } from './constants'
import { createPiece } from './factory'
import { occupiedExcept } from './occupancy'
import type { IntentMode, TeamId, Vec2 } from './types'
import { PIECE_LIST, PIECES } from './pieces'
import { findPath } from './pathfind'
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

export interface OverlayFlags {
  grid: boolean
  health: boolean
  myOrders: boolean
  enemyPlans: boolean
  moveCells: boolean
  attackCells: boolean
  rangeArcs: boolean
}

interface TurnState {
  world: WorldSnapshot
  rng: number
  tick: number
  teams: Record<TeamId, TeamRuntime>
  winner: TeamId | null
}

export interface GameSnapshot {
  running: boolean
  paused: boolean
  tick: number
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
  playerTeam: TeamId
  gameMode: GameMode
  gameModes: Array<{ id: GameMode; label: string }>
  turnActive: boolean
  canReplay: boolean
  replaying: boolean
  terrainVersion: number
}

function createTeamRuntime(controller: TeamController): TeamRuntime {
  const cooldown: Record<string, number> = {}
  const alive: Record<string, number> = {}
  for (const def of PIECE_LIST) {
    cooldown[def.key] = 0
    alive[def.key] = 0
  }
  return { controller, cooldown, alive, kills: 0, losses: 0, supply: 0, deployed: 0 }
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
  cmds: Commands = { damage: [], deploy: [], destroy: [] }
  teams: Record<TeamId, TeamRuntime>
  occupancy = new Map<number, Entity>()

  tick = 0
  speed = 1
  running = false
  paused = false
  hudVisible = true
  winner: TeamId | null = null
  terrainVersion = 0
  playerTeam: TeamId = 'blue'
  gameMode: GameMode = 'human-vs-ai'

  overlays: OverlayFlags = {
    grid: true,
    health: true,
    myOrders: true,
    enemyPlans: false,
    moveCells: true,
    attackCells: true,
    rangeArcs: true,
  }

  selected: Entity[] = []

  turnActive = false
  canReplay = false

  private turnSnapshot: TurnState | null = null
  private turnTicks = 0
  private lastTurn: { snapshot: TurnState; ticks: number } | null = null
  private replaying = false
  private replayTicks = 0
  private static readonly TURN_MAX_TICKS = 60

  fps = 0
  private tps = 0
  private ticksThisSecond = 0
  private secondTimer = 0
  private lastTime = 0
  private accumulator = 0
  private raf = 0
  private ctx: SimContext

  onFrame: ((alpha: number) => void) | null = null

  constructor(size: BoardSize = 16, mode: GameMode = 'human-vs-ai') {
    this.gameMode = mode
    const controllers = controllersFor(mode, this.playerTeam)
    this.teams = {
      red: createTeamRuntime(controllers.red),
      blue: createTeamRuntime(controllers.blue),
    }
    this.board = new Board(createBoardData(size))
    this.ctx = this.buildContext()
    this.placeArmy(initialArmy(size))
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
      dt: FIXED_DT,
      cmds: this.cmds,
      teams: this.teams,
      occupancy: this.occupancy,
      pathBudget: PATH_BUDGET_PER_TICK,
      verbosePhases: this.pipeline.verbose,
      turnActive: this.turnActive,
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
    if (this.turnActive) {
      this.turnActive = false
      this.paused = true
      this.bus.emit('info', 'turn cancelled')
      return
    }
    if (this.replaying) this.replaying = false
    this.paused = !this.paused
    this.bus.emit('info', this.paused ? 'paused' : 'resumed')
  }

  stepOnce(): void {
    if (this.turnActive) this.turnActive = false
    if (this.replaying) this.replaying = false
    this.paused = true
    this.step()
    this.bus.emit('info', `stepped to tick ${this.tick}`)
  }

  /**
   * A "turn" is one movement step per piece. Every piece may make at most one
   * move, then the turn pauses (waiting for in-flight moves to land first).
   * Move cooldowns are cleared at the start so each piece is ready, which makes
   * turns short, readable beats rather than several seconds of real time.
   */
  beginTurn(): void {
    if (this.turnActive || this.replaying) return
    this.turnSnapshot = this.captureTurn()
    this.turnTicks = 0
    for (const e of this.world.query(Motion)) {
      const motion = this.world.get(e, Motion)
      if (!motion) continue
      motion.cooldown = 0
      motion.movedThisTurn = motion.moving
    }
    this.canReplay = false
    this.turnActive = true
    this.paused = false
    this.bus.emit('info', 'turn started')
  }

  replayTurn(): void {
    if (!this.lastTurn || this.replaying || this.turnActive) return
    this.restoreTurn(this.lastTurn.snapshot)
    this.selected = []
    this.replaying = true
    this.replayTicks = 0
    this.paused = false
    this.bus.emit('info', `replaying last turn (${this.lastTurn.ticks} ticks)`)
  }

  private advanceTurn(): void {
    this.turnTicks++
    // Pending = pieces still able to make their one move (or mid-move). A piece
    // with no goal, or blocked with no route, counts as settled.
    let pending = 0
    for (const e of this.world.query(Motion)) {
      const motion = this.world.get(e, Motion)
      if (!motion) continue
      if (motion.moving) {
        pending++
        continue
      }
      if (motion.movedThisTurn) continue
      if (motion.goal && motion.path.length > 0) pending++
    }
    if (pending === 0) {
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
    this.paused = true
    if (this.turnSnapshot) {
      this.lastTurn = { snapshot: this.turnSnapshot, ticks: this.turnTicks }
      this.canReplay = true
      this.turnSnapshot = null
    }
    this.bus.emit('info', `turn ended after ${this.turnTicks} ticks`)
  }

  private captureTurn(): TurnState {
    return {
      world: this.world.capture(),
      rng: this.rng.getState(),
      tick: this.tick,
      teams: structuredClone(this.teams),
      winner: this.winner,
    }
  }

  private restoreTurn(state: TurnState): void {
    this.world.restore(state.world)
    this.rng.setState(state.rng)
    this.tick = state.tick
    this.teams = structuredClone(state.teams)
    this.winner = state.winner
    this.occupancy.clear()
    this.selected = this.selected.filter((e) => this.world.isAlive(e))
  }

  setSpeed(speed: number): void {
    this.speed = speed
    this.bus.emit('info', `speed x${speed}`)
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

    if (!this.paused) {
      this.accumulator += delta * this.speed
      let steps = 0
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.step()
        this.accumulator -= FIXED_DT
        steps++
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0
    }

    const alpha = Math.min(1, this.accumulator / FIXED_DT)
    this.onFrame?.(alpha)
  }

  private step(): void {
    this.ctx.tick = this.tick
    this.ctx.verbosePhases = this.pipeline.verbose
    this.ctx.turnActive = this.turnActive
    this.bus.tick = this.tick
    this.bus.phase = 'tick'
    this.pipeline.run(this.ctx)
    this.tick++
    this.ticksThisSecond++
    this.updateWinner()

    if (this.replaying) {
      this.replayTicks++
      if (this.replayTicks >= (this.lastTurn?.ticks ?? 0)) {
        this.replaying = false
        this.paused = true
        this.bus.emit('info', 'replay finished')
      }
      return
    }
    if (this.turnActive) this.advanceTurn()
  }

  private updateWinner(): void {
    const red = Object.values(this.teams.red.alive).reduce((a, b) => a + b, 0)
    const blue = Object.values(this.teams.blue.alive).reduce((a, b) => a + b, 0)
    if (red === 0 && blue > 0 && this.teams.red.deployed > 0) this.winner = 'blue'
    else if (blue === 0 && red > 0 && this.teams.blue.deployed > 0) this.winner = 'red'
    else if (red > 0 || blue > 0) this.winner = null
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
    this.rng.reset()
    this.selected = []
    this.winner = null
    this.turnActive = false
    this.replaying = false
    this.canReplay = false
    this.lastTurn = null
    this.turnSnapshot = null
    this.paused = true
    this.ctx = this.buildContext()
    this.placeArmy(initialArmy(size))
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
    const chosen: Entity[] = []
    for (const e of this.world.query(Position, Cell)) {
      const pos = this.world.require(e, Position)
      if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY) chosen.push(e)
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

  orderSelected(mode: IntentMode, dest: Vec2 | null): void {
    for (const e of this.selected) {
      if (!this.world.isAlive(e)) continue
      const intent = this.world.get(e, Intent)
      const motion = this.world.get(e, Motion)
      if (!intent || !motion) continue
      intent.mode = mode
      intent.dest = mode === 'hold' ? null : dest
      intent.player = true

      if (mode === 'move' && dest) {
        // Plan immediately so the route is visible even while paused.
        motion.goal = dest
        this.planNow(e, motion, dest)
      } else if (mode === 'fight' && dest) {
        // Fight treats the destination as a rally point until a target appears.
        motion.goal = dest
        this.planNow(e, motion, dest)
      } else {
        motion.goal = null
        motion.path = []
        motion.arrived = true
      }
    }
    const n = this.selected.length
    if (mode === 'move' && dest) {
      this.bus.emit('info', `orders: ${n} piece(s) move to (${dest.x},${dest.y})`)
    } else if (mode === 'hold') {
      this.bus.emit('info', `orders: ${n} piece(s) hold`)
    } else {
      this.bus.emit('info', `orders: ${n} piece(s) ${mode}`)
    }
  }

  private planNow(e: Entity, motion: MotionData, dest: Vec2): void {
    const cell = this.world.get(e, Cell)
    const kind = this.world.get(e, PieceType)?.kind
    const team = this.world.get(e, Team)
    if (!cell || !kind || !team) return
    const def = PIECES[kind]
    if (!def) return
    const occupied = occupiedExcept(this.board, this.occupancy, e)
    const result = findPath(this.board, cell, dest, def.move, team, occupied)
    motion.path = result.cells
    motion.replanAt = this.tick + 15
    motion.blocked = !result.found
  }

  paint(x: number, y: number, terrain: number): void {
    if (!this.board.inBounds(x, y)) return
    if (this.board.terrainAt(x, y) === terrain) return
    this.board.setTerrain(x, y, terrain)
    this.terrainVersion++
  }

  snapshot(): GameSnapshot {
    const pieces = this.world.query(Position, Cell).length
    const projectiles = this.world.query(Projectile, Position).length
    const fx = this.world.query(Fx).length

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
      playerTeam: this.playerTeam,
      gameMode: this.gameMode,
      gameModes: GAME_MODES,
      turnActive: this.turnActive,
      canReplay: this.canReplay,
      replaying: this.replaying,
      terrainVersion: this.terrainVersion,
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
