import { Board } from '../src/game/board'
import type { MapData } from '../src/game/board'
import type { OccupiedFn } from '../src/game/geometry'
import * as components from '../src/ecs/components'
import { Cell, Motion, Order, PieceType, Position, Team } from '../src/ecs/components'
import { EventBus } from '../src/ecs/events'
import type { SimContext, TeamController, TeamRuntime } from '../src/ecs/types'
import { World } from '../src/ecs/world'
import { PATH_BUDGET_PER_TICK } from '../src/game/constants'
import { Game } from '../src/game/game'
import type { GameMode } from '../src/game/game'
import type { PieceDef } from '../src/game/pieces'
import { Rng } from '../src/game/rng'
import type { TeamId, Vec2 } from '../src/game/types'

/**
 * Component stores are module-level singletons shared by every World, so tests
 * that build more than one world (or Game) must clear them to stay isolated.
 */
export function clearComponents(): void {
  for (const value of Object.values(components)) {
    const store = value as unknown as { map?: Map<unknown, unknown> } | undefined
    if (store && store.map instanceof Map) store.map.clear()
  }
}

/** An all-floor square board, independent of the generated maps. */
export function flatBoard(size = 8): Board {
  const data: MapData = {
    id: `test-${size}`,
    name: 'test',
    width: size,
    height: size,
    tile: 48,
    legend: {},
    terrain: new Array<number>(size * size).fill(0),
    spawns: {
      red: { x: 0, y: 0, w: size, h: 1 },
      blue: { x: 0, y: size - 1, w: size, h: 1 },
    },
    lanes: { red: [], blue: [] },
  }
  return new Board(data)
}

/** Fresh per-team runtime counters for a system-level `SimContext`. */
export function teamRuntime(controller: TeamController = 'human'): TeamRuntime {
  return {
    controller,
    cooldown: {},
    alive: {},
    kills: 0,
    losses: 0,
    supply: 0,
    deployed: 0,
    movesMade: 0,
    movesThisTurn: 0,
  }
}

/**
 * Shared system-test context: flat board, deterministic RNG, empty commands.
 * Override `size` / `captureAdvance` / `autoPreserve` per suite.
 */
export function makeContext(
  opts?: { size?: number; captureAdvance?: boolean; autoPreserve?: boolean; promotion?: boolean },
): SimContext {
  return {
    world: new World(),
    bus: new EventBus(),
    board: flatBoard(opts?.size ?? 8),
    rng: new Rng(1),
    tick: 0,
    turn: 0,
    dt: 1 / 30,
    cmds: { damage: [], deploy: [], destroy: [], advance: [] },
    teams: { red: teamRuntime(), blue: teamRuntime() },
    occupancy: new Map(),
    pathBudget: PATH_BUDGET_PER_TICK,
    verbosePhases: false,
    turnActive: false,
    autoPreserve: opts?.autoPreserve ?? true,
    captureAdvance: opts?.captureAdvance ?? false,
    promotion: opts?.promotion ?? true,
  }
}

/**
 * Common queen-vs-king fixture: blue queen at e4 (4,4), red king at e5 (4,5)
 * on a fresh size-8 game (full army still deployed; `placePiece` relocates).
 */
export function duelSetup(
  size = 8,
  mode: GameMode = 'human-vs-ai',
): {
  game: Game
  attacker: number
  victim: number
} {
  const game = new Game(size, mode)
  const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
  const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
  return { game, attacker, victim }
}

/** An OccupiedFn that reports true for exactly the given cells. */
export function occupiedCells(cells: Vec2[]): OccupiedFn {
  return (x, y) => cells.some((c) => c.x === x && c.y === y)
}

/** Move the first live piece of `kind`/`team` to a cell, keeping Position in sync. */
export function placePiece(game: Game, kind: string, team: TeamId, cell: Vec2): number {
  for (const e of game.world.query(Cell, Team, PieceType)) {
    if (game.world.require(e, Team) !== team) continue
    if ((game.world.require(e, PieceType).kind as PieceDef['key']) !== kind) continue
    const c = game.world.require(e, Cell)
    c.x = cell.x
    c.y = cell.y
    const p = game.world.require(e, Position)
    const center = game.board.cellCenter(cell.x, cell.y)
    p.x = center.x
    p.y = center.y
    return e
  }
  throw new Error(`no ${team} ${kind} to place`)
}

/** Give a piece an attack order aimed at `target`, with a settled (empty) route. */
export function orderAttack(game: Game, attacker: number, target: number, reachable: boolean): void {
  const order = game.world.require(attacker, Order)
  order.kind = 'attack'
  order.target = target
  order.dest = null
  order.reachable = reachable
  const motion = game.world.require(attacker, Motion)
  motion.path = []
  motion.goal = null
}
