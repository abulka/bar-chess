import { EventBus } from '../ecs/events'
import type { EventRecord } from '../ecs/events'
import { Pipeline } from '../ecs/pipeline'
import { createPipeline } from '../ecs/systems'
import { World } from '../ecs/world'
import type { Entity } from '../ecs/world'
import type { Commands, SimContext, TeamRuntime } from '../ecs/types'
import { Cell, Fx, Intent, Motion, PieceType, Position, Projectile, Team } from '../ecs/components'
import type { MotionData } from '../ecs/components'
import { Board } from './board'
import type { BoardSize, Placement } from './boards'
import { createBoardData, initialArmy } from './boards'
import { FIXED_DT, MAX_STEPS_PER_FRAME, PATH_BUDGET_PER_TICK, TEAM_COLORS, TEAM_NAMES } from './constants'
import { createPiece } from './factory'
import type { IntentMode, TeamId, Vec2 } from './types'
import { PIECE_LIST, PIECES } from './pieces'
import { findPath } from './pathfind'
import { Rng } from './rng'

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
  intentions: boolean
  paths: boolean
  ranges: boolean
  targets: boolean
  health: boolean
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
  terrainVersion: number
}

function createTeamRuntime(): TeamRuntime {
  const cooldown: Record<string, number> = {}
  const alive: Record<string, number> = {}
  for (const def of PIECE_LIST) {
    cooldown[def.key] = 0
    alive[def.key] = 0
  }
  return { cooldown, alive, kills: 0, losses: 0, supply: 0, deployed: 0 }
}

export class Game {
  world = new World()
  bus = new EventBus()
  pipeline: Pipeline = createPipeline()
  board: Board
  rng = new Rng()
  cmds: Commands = { damage: [], deploy: [], destroy: [] }
  teams: Record<TeamId, TeamRuntime> = { red: createTeamRuntime(), blue: createTeamRuntime() }
  occupancy = new Map<number, Entity>()

  tick = 0
  speed = 1
  running = false
  paused = false
  hudVisible = true
  winner: TeamId | null = null
  terrainVersion = 0

  overlays: OverlayFlags = {
    grid: true,
    intentions: false,
    paths: true,
    ranges: false,
    targets: false,
    health: true,
  }

  selected: Entity[] = []

  fps = 0
  private tps = 0
  private ticksThisSecond = 0
  private secondTimer = 0
  private lastTime = 0
  private accumulator = 0
  private raf = 0
  private ctx: SimContext

  onFrame: ((alpha: number) => void) | null = null

  constructor(size: BoardSize = 16) {
    this.board = new Board(createBoardData(size))
    this.ctx = this.buildContext()
    this.placeArmy(initialArmy(size))
    this.bus.emit('map', `loaded ${this.board.data.name}`)
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
    this.paused = !this.paused
    this.bus.emit('info', this.paused ? 'paused' : 'resumed')
  }

  stepOnce(): void {
    this.paused = true
    this.step()
    this.bus.emit('info', `stepped to tick ${this.tick}`)
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
    this.bus.tick = this.tick
    this.bus.phase = 'tick'
    this.pipeline.run(this.ctx)
    this.tick++
    this.ticksThisSecond++
    this.updateWinner()
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
    this.teams = { red: createTeamRuntime(), blue: createTeamRuntime() }
    this.board = new Board(createBoardData(size))
    this.occupancy.clear()
    this.tick = 0
    this.rng.reset()
    this.selected = []
    this.winner = null
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
    const result = findPath(this.board, cell, dest, def.move, team)
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
