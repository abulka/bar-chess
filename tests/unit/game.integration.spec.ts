import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Motion, Order, Stance, Target } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { PIECES } from '../../src/game/pieces'
import { clearComponents, orderAttack, placePiece } from '../helpers'

function runTurn(game: Game): void {
  game.beginTurn()
  let guard = 0
  while (game.turnActive && guard++ < 2000) game.runTicks(1)
  expect(guard).toBeLessThan(2000)
}

function runUntil(game: Game, pred: () => boolean, max = 4000): void {
  let guard = 0
  while (!pred() && guard++ < max) game.runTicks(1)
  expect(guard).toBeLessThan(max)
}

describe('Game integration', () => {
  beforeEach(() => clearComponents())

  it('starts paused with a full army deployed', () => {
    const game = new Game(8)
    expect(game.paused).toBe(true)
    expect(game.snapshot().counts.pieces).toBe(32)
  })

  it('runTicks advances the tick counter deterministically', () => {
    const game = new Game(8)
    game.runTicks(10)
    expect(game.tick).toBe(10)
  })

  it('applies a capture-advance toggle set after construction', () => {
    const game = new Game(8)
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const knight = createPiece(shim, 'blue', PIECES.knight, { x: 6, y: 3 }) // g5
    const pawn = createPiece(shim, 'red', PIECES.pawn, { x: 5, y: 1 }) // f7
    game.world.require(knight, Stance).mode = 'attack'
    game.cmds.damage.push({ target: pawn, source: knight, amount: 999, kind: 'projectile', direct: true })
    game.setCaptureAdvance(true)

    game.runTicks(1)

    expect(game.world.require(knight, Cell)).toEqual({ x: 5, y: 1 })
  })

  it('lets a home pawn take its two-square first move in a single turn', () => {
    const game = new Game(8)
    const pawn = placePiece(game, 'pawn', 'blue', { x: 3, y: 6 }) // d2, blue home rank
    game.selected = [pawn]
    game.orderAt({ x: 3, y: 4 }, 'move')

    runTurn(game)

    expect(game.world.require(pawn, Cell)).toEqual({ x: 3, y: 4 })
  })

  it('a deploy command spawns a reinforcement on the next tick', () => {
    const game = new Game(8)
    const before = game.teams.blue.alive.pawn
    game.deploy('blue', 'pawn')
    game.stepOnce()
    expect(game.teams.blue.alive.pawn).toBe(before + 1)
  })

  it('orderAt honors an explicit move/attack and is context-sensitive by default', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]
    const order = game.world.require(attacker, Order)

    game.orderAt({ x: 4, y: 5 }, 'move')
    expect(order.kind).toBe('goto')
    expect(order.dest).toEqual({ x: 4, y: 5 })
    expect(order.queue).toEqual([])

    game.clearOrders()
    game.orderAt({ x: 4, y: 5 })
    expect(order.kind).toBe('attack')
    expect(order.target).toBe(victim)
    expect(order.reachable).toBe(true)
    expect(game.world.require(attacker, Motion).path).toEqual([])
  })

  it('an attack command needs an enemy target', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    game.selected = [attacker]
    game.orderAt({ x: 3, y: 3 }, 'attack')
    expect(game.world.require(attacker, Order).kind).toBe('none')
  })

  it('does not command AI-controlled pieces', () => {
    const game = new Game(8, 'ai-vs-ai')
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]

    game.orderAt({ x: 4, y: 5 }, 'attack')
    expect(game.world.require(attacker, Order).kind).toBe('none')
  })

  it('selectRect selects every piece the box touches', () => {
    const game = new Game(8)
    game.selectRect(-1, -1, game.board.pixelWidth + 1, game.board.pixelHeight + 1)
    expect(game.selected).toHaveLength(32)
  })

  it('is deterministic for the same seed and inputs (reset and re-run)', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    const first = JSON.stringify(game.toDebugJson())

    game.reset()
    runTurn(game)
    expect(JSON.stringify(game.toDebugJson())).toBe(first)
  })

  it('replay reproduces the exact end state of a turn', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    expect(game.canReplay).toBe(true)
    const end = JSON.stringify(game.toDebugJson())

    game.replayTurn()
    let guard = 0
    while (game.snapshot().replaying && guard++ < 5000) game.runTicks(1)
    expect(game.snapshot().replaying).toBe(false)
    expect(JSON.stringify(game.toDebugJson())).toBe(end)
  })

  it('the turn bar reaches and holds full, then resets for the next turn', () => {
    const game = new Game(8, 'ai-vs-ai')
    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 2000) {
      game.runTicks(1)
      if (game.turnActive) expect(game.snapshot().barProgress).toBeLessThan(1)
    }
    expect(game.turnActive).toBe(false)
    expect(game.snapshot().barProgress).toBe(1)
    // It stays full while waiting for the next turn...
    game.runTicks(5)
    expect(game.snapshot().barProgress).toBe(1)
    // ...and resets to empty when a new turn starts.
    game.beginTurn()
    expect(game.snapshot().barProgress).toBe(0)
  })

  it('the replay bar reaches and holds full', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    game.replayTurn()
    let guard = 0
    while (game.snapshot().replaying && guard++ < 5000) game.runTicks(1)
    expect(game.snapshot().replaying).toBe(false)
    expect(game.snapshot().barProgress).toBe(1)
  })

  it('undo and redo walk the turn history step by step', () => {
    const game = new Game(8, 'ai-vs-ai')
    const start = JSON.stringify(game.toDebugJson())
    runTurn(game)
    const after1 = JSON.stringify(game.toDebugJson())
    runTurn(game)
    const after2 = JSON.stringify(game.toDebugJson())

    expect(game.snapshot().canUndo).toBe(true)
    expect(game.snapshot().canRedo).toBe(false)

    game.undoTurn()
    expect(JSON.stringify(game.toDebugJson())).toBe(after1)
    expect(game.snapshot().canRedo).toBe(true)

    game.undoTurn()
    expect(JSON.stringify(game.toDebugJson())).toBe(start)
    expect(game.snapshot().canUndo).toBe(false)

    game.redoTurn()
    expect(JSON.stringify(game.toDebugJson())).toBe(after1)
    game.redoTurn()
    expect(JSON.stringify(game.toDebugJson())).toBe(after2)
    expect(game.snapshot().canRedo).toBe(false)
  })

  it('a new turn after undo discards the redo branch', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    runTurn(game)
    game.undoTurn()
    game.undoTurn()
    expect(game.snapshot().canRedo).toBe(true)

    runTurn(game)
    expect(game.snapshot().canRedo).toBe(false)
    expect(game.snapshot().canUndo).toBe(true)
  })

  it('an attack order does not change the piece stance', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]
    expect(game.world.require(attacker, Stance).mode).toBe('none')

    game.orderAt({ x: 4, y: 5 }, 'attack')
    expect(game.world.require(attacker, Order).kind).toBe('attack')
    expect(game.world.require(attacker, Stance).mode).toBe('none')
  })

  it('setPieceStance applies to the selection, including none', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    const knight = placePiece(game, 'knight', 'blue', { x: 7, y: 7 })
    game.selected = [rook, knight]

    game.setPieceStance('attack')
    expect(game.world.require(rook, Stance).mode).toBe('attack')
    expect(game.world.require(knight, Stance).mode).toBe('attack')

    game.setPieceStance('none')
    expect(game.world.require(rook, Stance).mode).toBe('none')
    expect(game.world.require(knight, Stance).mode).toBe('none')
  })

  it('right-clicking a friendly square is a no-op', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    const friend = placePiece(game, 'knight', 'blue', { x: 0, y: 5 })
    game.selected = [rook]

    game.orderAt({ x: 0, y: 5 })
    expect(game.world.require(rook, Order).kind).toBe('none')
    expect(game.world.require(rook, Order).target).toBeNull()
    expect(friend).toBeGreaterThan(0)
  })

  it('clearOrders drops the current target so the piece stops engaging', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]
    game.orderAt({ x: 4, y: 5 }, 'attack')
    game.world.require(attacker, Target).entity = victim

    game.clearOrders()
    expect(game.world.require(attacker, Target).entity).toBeNull()
  })

  it('exposes focused piece info for the properties panel', () => {
    const game = new Game(8)
    const queen = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    game.selected = [queen]
    game.setPieceStance('attack')
    game.orderAt({ x: 5, y: 4 }, 'move')
    game.orderAt({ x: 3, y: 4 }, 'move')

    const info = game.snapshot().pieceInfo
    expect(info).not.toBeNull()
    expect(info!.entity).toBe(queen)
    expect(info!.kind).toBe('queen')
    expect(info!.stance).toBe('attack')
    expect(info!.commandable).toBe(true)
    expect(info!.order.kind).toBe('goto')
    expect(info!.order.destCoord).toBe('f4')
    expect(info!.order.reachable).toBe(true)
    expect(info!.motion.intent).toBe('order')
    expect(info!.order.queue).toHaveLength(1)
    expect(info!.order.queue[0].source).toBe('manual')
    expect(info!.health.max).toBeGreaterThan(0)
    expect(game.snapshot().selectionCount).toBe(1)
  })

  it('tracks a pending BAR-style command', () => {
    const game = new Game(8)
    expect(game.snapshot().pendingCommand).toBe('none')
    game.setPendingCommand('attack')
    expect(game.snapshot().pendingCommand).toBe('attack')
    game.clearPendingCommand()
    expect(game.snapshot().pendingCommand).toBe('none')
  })

  it('orderAttack helper marks a clear shot as reachable', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    orderAttack(game, attacker, victim, true)
    expect(game.world.require(attacker, Order).target).toBe(victim)
  })

  it('ends the game when a king dies and freezes play', () => {
    const game = new Game(8)
    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 4 })
    game.cmds.damage.push({ target: redKing, source: null, amount: 100000, kind: 'test' })

    game.stepOnce()

    expect(game.winner).toBe('blue')
    expect(game.snapshot().winner).toBe('blue')
    expect(game.world.isAlive(redKing)).toBe(false)

    // Play is suspended: beginning a turn does nothing.
    game.beginTurn()
    expect(game.turnActive).toBe(false)
  })

  it('undo reopens a game that ended on a king kill', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    expect(game.snapshot().canUndo).toBe(true)

    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 4 })
    game.cmds.damage.push({ target: redKing, source: null, amount: 100000, kind: 'test' })
    game.stepOnce()
    expect(game.winner).toBe('blue')
    expect(game.snapshot().canUndo).toBe(true)

    game.undoTurn()

    expect(game.winner).toBeNull()
    expect(game.world.isAlive(redKing)).toBe(true)
    game.beginTurn()
    expect(game.turnActive).toBe(true)
  })

  it('closes a live turn the moment the king falls', () => {
    const game = new Game(8, 'ai-vs-ai')
    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 4 })
    game.beginTurn()
    expect(game.turnActive).toBe(true)

    game.cmds.damage.push({ target: redKing, source: null, amount: 100000, kind: 'test' })
    game.runTicks(1)

    expect(game.winner).toBe('blue')
    expect(game.turnActive).toBe(false)
    expect(game.snapshot().canUndo).toBe(true)
  })

  it('AI king holds its post instead of charging with the army', () => {
    const game = new Game(8, 'ai-vs-ai')
    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 0 })

    game.stepOnce()

    expect(game.world.require(redKing, Motion).goal).toBeNull()
  })

  it('AI king retreats from a nearby enemy instead of advancing', () => {
    const game = new Game(8, 'ai-vs-ai')
    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 2 })
    placePiece(game, 'queen', 'blue', { x: 4, y: 4 })

    game.stepOnce()

    const motion = game.world.require(redKing, Motion)
    expect(motion.goal).not.toBeNull()
    // It must not charge the enemy; it opens the gap instead.
    expect(motion.goal!.y).toBeLessThanOrEqual(2)
    const before = Math.hypot(4 - 4, 2 - 4)
    const after = Math.hypot(motion.goal!.x - 4, motion.goal!.y - 4)
    expect(after).toBeGreaterThan(before)
  })
})

describe('Game queued turns', () => {
  beforeEach(() => clearComponents())

  it('starts immediately when idle and buffers a second request', () => {
    const game = new Game(8)
    game.queueTurn()
    expect(game.turnActive).toBe(true)
    expect(game.turn).toBe(1)

    game.queueTurn()
    expect(game.queuedTurns).toBe(1)
  })

  it('runs buffered turns back-to-back', () => {
    const game = new Game(8)
    game.queueTurn()
    game.queueTurn()

    // Wait out the first turn, which then auto-starts the second.
    runUntil(game, () => game.turn === 2 && !game.turnActive)
    expect(game.turn).toBe(2)
    expect(game.queuedTurns).toBe(0)
    expect(game.snapshot().canReplay).toBe(true)
  })

  it('caps the buffer so a held key cannot queue a runaway', () => {
    const game = new Game(8)
    game.queueTurn()
    for (let i = 0; i < 10; i++) game.queueTurn()
    expect(game.queuedTurns).toBe(3)
    expect(game.snapshot().queuedTurns).toBe(3)
  })

  it('clears buffered turns when the active turn is cancelled', () => {
    const game = new Game(8)
    game.queueTurn()
    game.queueTurn()
    expect(game.queuedTurns).toBe(1)

    game.togglePause()
    expect(game.turnActive).toBe(false)
    expect(game.queuedTurns).toBe(0)
  })
})
