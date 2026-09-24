import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Motion, Order, Stance, Target, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { coordName } from '../../src/game/coords'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { PIECE_LIST, PIECES, WEAPONS, weaponDamage } from '../../src/game/pieces'
import { MAX_ORDER_LOG, noteOrder } from '../../src/game/queue'
import { clearComponents, duelSetup, orderAttack, placePiece } from '../helpers'

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
    // The capture advance is a slow glide: the cell is not claimed until the
    // killer actually arrives.
    runUntil(game, () => {
      const c = game.world.require(knight, Cell)
      return c.x === 5 && c.y === 1
    })

    expect(game.world.require(knight, Cell)).toEqual({ x: 5, y: 1 })
  })

  it('replays a finished turn under the rules it was played with', () => {
    const game = new Game(8, 'human-vs-human')
    game.setChessKills(true)
    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 4000) game.runTicks(1)
    expect(game.canReplay).toBe(true)

    game.setChessKills(false)
    game.replayTurn()
    // The turn snapshot restores the rules in force at capture, so the replay
    // re-runs with chess kills on even though the live toggle is now off.
    expect(game.chessKills).toBe(true)

    guard = 0
    while (game.replaying && guard++ < 4000) game.runTicks(1)
    expect(game.chessKills).toBe(true)
    expect(game.replaying).toBe(false)
  })

  it('keeps a badly hurt piece on its attack order instead of disengaging', () => {
    const game = new Game(8)
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const knight = createPiece(shim, 'blue', PIECES.knight, { x: 2, y: 2 }) // c6
    const queen = createPiece(shim, 'red', PIECES.queen, { x: 3, y: 0 }) // d8
    createPiece(shim, 'red', PIECES.rook, { x: 5, y: 2 }) // f6, covers the rank
    createPiece(shim, 'red', PIECES.bishop, { x: 3, y: 3 }) // d5, diagonal to c6
    createPiece(shim, 'red', PIECES.pawn, { x: 3, y: 1 }) // d7, fires on c6
    game.world.require(knight, Health).cur = Math.floor(PIECES.knight.hp * 0.3)
    const order = game.world.require(knight, Order)
    order.kind = 'attack'
    order.target = queen
    order.reachable = true

    game.runTicks(1)

    // An explicit kill order takes priority over self-preservation.
    expect(game.world.require(knight, Motion).intent).not.toBe('preserve')
    expect(game.world.isAlive(knight)).toBe(true)
  })

  it('clears the reported under-fire once the piece leaves the attacker line', () => {
    const game = new Game(8, 'human-vs-human')
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const bishop = createPiece(shim, 'blue', PIECES.bishop, { x: 2, y: 2 }) // c6
    const rook = createPiece(shim, 'red', PIECES.rook, { x: 2, y: 7 }) // c1, same file
    const target = game.world.require(bishop, Target)
    target.lastAttacker = rook
    target.underFireUntil = game.tick + 90
    game.selected = [bishop]

    expect(game.snapshot().pieceInfo?.underFire?.entity).toBe(rook)
    expect(game.shorthand()).toMatch(/bB c6[^\n]*fire=/)

    // Step the bishop off the c-file: the rook no longer covers it.
    game.world.require(bishop, Cell).x = 3

    expect(game.snapshot().pieceInfo?.underFire).toBeNull()
    expect(game.shorthand()).not.toMatch(/bB d6[^\n]*fire=/)
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
    const { game, attacker, victim } = duelSetup()
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

  it('records the reason for each player order change', () => {
    const { game, attacker } = duelSetup()
    game.selected = [attacker]
    const order = game.world.require(attacker, Order)

    game.orderAt({ x: 4, y: 5 }, 'attack')
    expect(order.log[order.log.length - 1].text).toContain('attack ordered')

    game.orderAt({ x: 3, y: 4 }, 'move')
    expect(order.log[order.log.length - 1].text).toContain('move replaced attack')

    game.clearOrders()
    expect(order.log[order.log.length - 1].text).toContain('orders cleared')
    expect(order.kind).toBe('none')
  })

  it('caps the order-change log', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    const order = game.world.require(rook, Order)
    for (let i = 0; i < 10; i++) noteOrder(order, i, `change ${i}`)
    expect(order.log).toHaveLength(MAX_ORDER_LOG)
    expect(order.log[order.log.length - 1].text).toBe('change 9')
  })

  it('an attack command needs an enemy target', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    game.selected = [attacker]
    game.orderAt({ x: 3, y: 3 }, 'attack')
    expect(game.world.require(attacker, Order).kind).toBe('none')
  })

  it('does not command AI-controlled pieces', () => {
    const { game, attacker } = duelSetup(8, 'ai-vs-ai')
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

  it('keeps the selection across undo/redo so the panel follows the restored state', () => {
    const game = new Game(8)
    const pawn = placePiece(game, 'pawn', 'blue', { x: 3, y: 6 })
    game.selected = [pawn]
    game.orderAt({ x: 3, y: 4 }, 'move')
    runTurn(game)

    expect(game.snapshot().pieceInfo?.entity).toBe(pawn)
    expect(game.snapshot().pieceInfo?.cell).toEqual({ x: 3, y: 4 })

    game.undoTurn()
    expect(game.selected).toEqual([pawn])
    expect(game.snapshot().pieceInfo?.entity).toBe(pawn)
    // The constructor snapshot has the pawn on its spawn rank, not d4.
    expect(game.snapshot().pieceInfo?.cell).not.toEqual({ x: 3, y: 4 })

    game.redoTurn()
    expect(game.selected).toEqual([pawn])
    expect(game.snapshot().pieceInfo?.entity).toBe(pawn)
    expect(game.snapshot().pieceInfo?.cell).toEqual({ x: 3, y: 4 })
  })

  it('prunes from the selection the pieces the restored state does not have', () => {
    const game = new Game(8)
    const veteran = placePiece(game, 'pawn', 'blue', { x: 3, y: 6 })
    game.selected = [veteran]
    game.orderAt({ x: 3, y: 4 }, 'move')
    runTurn(game)

    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const reinforcement = createPiece(shim, 'blue', PIECES.pawn, { x: 5, y: 7 })
    game.selected = [reinforcement, veteran]
    expect(game.snapshot().pieceInfo?.entity).toBe(reinforcement)

    game.undoTurn()

    // The reinforcement never existed at the restored boundary; the veteran
    // survives and keeps focus so the panel shows a real piece.
    expect(game.selected).toEqual([veteran])
    expect(game.snapshot().selected).toEqual([veteran])
    expect(game.snapshot().selectionCount).toBe(1)
    expect(game.snapshot().pieceInfo?.entity).toBe(veteran)
  })

  it('an attack order does not change the piece stance', () => {
    const { game, attacker } = duelSetup()
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
    const { game, attacker, victim } = duelSetup()
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
    const { game, attacker, victim } = duelSetup()
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

describe('Game integration — healing-aware self-preservation', () => {
  beforeEach(() => clearComponents())

  /** An empty board with a blue king on e1 and a badly wounded piece elsewhere. */
  function healingGame(
    piece: { kind: keyof typeof PIECES; cell: { x: number; y: number }; hp: number },
    orderDest?: { x: number; y: number },
  ): { game: Game; piece: number } {
    const game = new Game(8)
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    createPiece(shim, 'blue', PIECES.king, { x: 4, y: 7 }) // e1
    const e = createPiece(shim, 'blue', PIECES[piece.kind], piece.cell)
    const hp = game.world.require(e, Health)
    hp.cur = piece.hp
    game.world.require(e, Motion).holdUntilHp = hp.max
    if (orderDest) {
      const order = game.world.require(e, Order)
      order.kind = 'goto'
      order.dest = orderDest
    }
    return { game, piece: e }
  }

  const inAura = (game: Game, e: number): boolean => {
    const c = game.world.require(e, Cell)
    return Math.max(Math.abs(c.x - 4), Math.abs(c.y - 7)) <= 2
  }

  it('walks a latched, badly wounded piece to the aura so it can heal', () => {
    const { game, piece } = healingGame({ kind: 'rook', cell: { x: 0, y: 5 }, hp: 8 })

    for (let i = 0; i < 4; i++) runTurn(game)

    expect(inAura(game, piece)).toBe(true)
    expect(game.world.require(piece, Health).cur).toBeGreaterThan(8)
  })

  it('honours a latched move order that ends in the aura and then heals', () => {
    const { game, piece } = healingGame(
      { kind: 'rook', cell: { x: 0, y: 5 }, hp: 8 },
      { x: 3, y: 7 }, // d1, adjacent to the king
    )

    for (let i = 0; i < 4; i++) runTurn(game)

    expect(game.world.require(piece, Cell)).toEqual({ x: 3, y: 7 })
    expect(game.world.require(piece, Health).cur).toBeGreaterThan(8)
  })

  it('releases the safe-hold once the healing trip restores full health', () => {
    const { game, piece } = healingGame({ kind: 'rook', cell: { x: 0, y: 5 }, hp: 8 })

    runUntil(game, () => game.world.require(piece, Motion).holdUntilHp === 0, 20000)

    const hp = game.world.require(piece, Health)
    expect(game.world.require(piece, Motion).holdUntilHp).toBe(0)
    expect(hp.cur).toBe(hp.max)
    expect(inAura(game, piece)).toBe(true)
  })

  it('walks a wounded, boxed-in piece home to heal instead of standing in the fire', () => {
    // Human-vs-human so the red "cover" pieces hold still; their weapons are
    // removed so they shape the threat field (all knight steps covered) without
    // actually killing the retreating knight.
    const game = new Game(8, 'human-vs-human')
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    createPiece(shim, 'blue', PIECES.king, { x: 4, y: 7 }) // e1
    const knight = createPiece(shim, 'blue', PIECES.knight, { x: 2, y: 1 }) // c7
    const rook = createPiece(shim, 'red', PIECES.rook, { x: 1, y: 0 }) // b8
    const bishop = createPiece(shim, 'red', PIECES.bishop, { x: 2, y: 0 }) // c8
    const queen = createPiece(shim, 'red', PIECES.queen, { x: 3, y: 4 }) // d4
    const redKing = createPiece(shim, 'red', PIECES.king, { x: 4, y: 0 }) // e8, blocks the last open hop
    for (const e of [rook, bishop, queen, redKing]) game.world.remove(e, Weapon)
    game.world.require(knight, Health).cur = 22 // wounded, not critical
    const target = game.world.require(knight, Target)
    target.lastAttacker = rook
    target.underFireUntil = 9999

    runTurn(game)

    const motion = game.world.require(knight, Motion)
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
    // It left the square it was standing on, heading for the king.
    expect(game.world.require(knight, Cell)).not.toEqual({ x: 2, y: 1 })
  })

  it('does not park a cornered, badly wounded knight: it seeks its king', () => {
    // The enemy corner (a7) is locally safe but a dead end; the fix is that the
    // latched knight heads for its own king instead of holding with no goal.
    const { game, piece } = healingGame({ kind: 'knight', cell: { x: 0, y: 1 }, hp: 8 })

    game.runTicks(1)
    const motion = game.world.require(piece, Motion)
    expect(motion.goal).not.toBeNull()
    expect(motion.intent).toBe('preserve')

    const before = Math.max(Math.abs(0 - 4), Math.abs(1 - 7))
    for (let i = 0; i < 3 && game.world.isAlive(piece); i++) runTurn(game)
    const c = game.world.require(piece, Cell)
    expect(c).not.toEqual({ x: 0, y: 1 })
    expect(Math.max(Math.abs(c.x - 4), Math.abs(c.y - 7))).toBeLessThan(before)
  })
})

describe('Game integration — AI move budget', () => {
  beforeEach(() => clearComponents())

  /** The live entity standing on `cell`. */
  function pieceAt(game: Game, x: number, y: number): number {
    for (const e of game.world.query(Cell)) {
      const c = game.world.require(e, Cell)
      if (c.x === x && c.y === y) return e
    }
    throw new Error(`no piece at ${x},${y}`)
  }

  /** Command the blue pawn on `from` to step one square to `to`. */
  function orderPawn(game: Game, from: { x: number; y: number }, to: { x: number; y: number }): void {
    game.selected = [pieceAt(game, from.x, from.y)]
    game.orderAt(to, 'move')
    game.selected = []
  }

  it('answers two human moves with two AI moves in the same turn', () => {
    const game = new Game(8) // human-vs-ai, you=blue
    orderPawn(game, { x: 3, y: 6 }, { x: 3, y: 5 }) // d2 -> d3
    orderPawn(game, { x: 4, y: 6 }, { x: 4, y: 5 }) // e2 -> e3

    runTurn(game)

    expect(game.teams.blue.movesMade).toBe(2)
    expect(game.teams.red.movesMade).toBe(2)
  })

  it('gives the AI one move when the human does nothing', () => {
    const game = new Game(8)
    runTurn(game)

    expect(game.teams.blue.movesMade).toBe(0)
    expect(game.teams.red.movesMade).toBe(1)
  })

  it('does not bank unused AI moves across turns', () => {
    const game = new Game(8)
    runTurn(game)
    runTurn(game)

    expect(game.teams.blue.movesMade).toBe(0)
    expect(game.teams.red.movesMade).toBe(2) // one per turn, never a burst
  })

  it('never lets the AI out-move the human within a turn', () => {
    const game = new Game(8)
    orderPawn(game, { x: 3, y: 6 }, { x: 3, y: 5 }) // d2 -> d3

    runTurn(game)

    expect(game.teams.blue.movesMade).toBe(1)
    expect(game.teams.red.movesMade).toBeLessThanOrEqual(game.teams.blue.movesMade)
  })
})

describe('Game integration — king guard lethality', () => {
  beforeEach(() => clearComponents())

  it('deals 80% of a target’s max HP, so one hit is never fatal but two are', () => {
    for (const piece of PIECE_LIST) {
      const hit = weaponDamage(WEAPONS.kingGuard, piece.hp)
      expect(hit).toBeLessThan(piece.hp)
      expect(hit * 2).toBeGreaterThanOrEqual(piece.hp)
    }
  })

  it('leaves a queen alive after one king shot but kills it with the second', () => {
    const game = new Game(8)
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const king = createPiece(shim, 'blue', PIECES.king, { x: 4, y: 4 })
    const queen = createPiece(shim, 'red', PIECES.queen, { x: 5, y: 4 })
    const max = game.world.require(queen, Health).max
    const hit = weaponDamage(WEAPONS.kingGuard, max)

    game.cmds.damage.push({ target: queen, source: king, amount: hit, kind: 'projectile', direct: true })
    game.runTicks(1)
    expect(game.world.isAlive(queen)).toBe(true)

    game.cmds.damage.push({ target: queen, source: king, amount: hit, kind: 'projectile', direct: true })
    game.runTicks(1)
    expect(game.world.isAlive(queen)).toBe(false)
  })

  it('fires only once per turn, giving the victim a turn to escape', () => {
    const game = new Game(8)
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const king = createPiece(shim, 'blue', PIECES.king, { x: 4, y: 4 })
    const queen = createPiece(shim, 'red', PIECES.queen, { x: 5, y: 4 })
    // Keep the queen planted so the test measures the king's cadence, not a
    // retreat, and unarmed so it cannot fight back.
    game.world.remove(queen, Motion)
    game.world.remove(queen, Weapon)
    game.world.require(king, Stance).mode = 'attack'
    orderAttack(game, king, queen, true)
    game.world.require(king, Weapon).left = 0

    // ~2.4s, just under the 2.5s recharge. At the old 1.1s cadence this turn
    // landed two 80% hits and killed the queen.
    game.runTicks(72)

    const health = game.world.require(queen, Health)
    expect(game.world.isAlive(queen)).toBe(true)
    expect(health.cur).toBeLessThan(health.max)
  })
})

describe('Game replay from any history point', () => {
  beforeEach(() => clearComponents())

  function replayToEnd(game: Game): void {
    game.replayTurn()
    expect(game.snapshot().replaying).toBe(true)
    let guard = 0
    while (game.snapshot().replaying && guard++ < 5000) game.runTicks(1)
    expect(guard).toBeLessThan(5000)
  }

  it('replays the turn at an undone cursor, keeping the cursor and redo branch', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    const after1 = JSON.stringify(game.toDebugJson())
    runTurn(game)
    runTurn(game)
    const after3 = JSON.stringify(game.toDebugJson())

    game.undoTurn()
    game.undoTurn()
    expect(game.snapshot().canReplay).toBe(true)

    replayToEnd(game)

    // It ended exactly on the boundary the cursor already points at.
    expect(JSON.stringify(game.toDebugJson())).toBe(after1)
    expect(game.snapshot().canRedo).toBe(true)
    expect(game.snapshot().canUndo).toBe(true)

    // The abandoned future is still there.
    game.redoTurn()
    game.redoTurn()
    expect(JSON.stringify(game.toDebugJson())).toBe(after3)
  })

  it('walks undo 3x → replay, redo 2x → replay', () => {
    const game = new Game(8, 'ai-vs-ai')
    const states = [JSON.stringify(game.toDebugJson())]
    for (let i = 0; i < 4; i++) {
      runTurn(game)
      states.push(JSON.stringify(game.toDebugJson()))
    }

    game.undoTurn()
    game.undoTurn()
    game.undoTurn()
    replayToEnd(game)
    expect(JSON.stringify(game.toDebugJson())).toBe(states[1])

    game.redoTurn()
    game.redoTurn()
    replayToEnd(game)
    expect(JSON.stringify(game.toDebugJson())).toBe(states[3])
  })

  it('keeps the selection across a replay', () => {
    const game = new Game(8)
    const pawn = placePiece(game, 'pawn', 'blue', { x: 3, y: 6 })
    game.selected = [pawn]
    game.orderAt({ x: 3, y: 4 }, 'move')
    runTurn(game)
    const end = JSON.stringify(game.toDebugJson())

    replayToEnd(game)

    expect(game.selected).toEqual([pawn])
    expect(game.snapshot().pieceInfo?.entity).toBe(pawn)
    // The replay reproduces the whole turn, not just the selection.
    expect(JSON.stringify(game.toDebugJson())).toBe(end)
  })

  it('replays paused orders after undoing to the start and redoing one turn', () => {
    // Regression: orders issued while paused live only in the live world, never
    // in a history boundary, so replay must restore the recorded turn-start
    // snapshot rather than reconstruct from the previous boundary.
    const game = new Game(8) // human-vs-ai: blue is human
    const pawn = placePiece(game, 'pawn', 'blue', { x: 3, y: 6 })
    game.selected = [pawn]
    game.orderAt({ x: 3, y: 4 })
    runTurn(game)
    expect(game.world.require(pawn, Cell)).toEqual({ x: 3, y: 4 })
    const end = JSON.stringify(game.toDebugJson())

    game.undoTurn() // back to the opening state; the paused order is gone
    game.redoTurn()
    replayToEnd(game)

    expect(game.world.require(pawn, Cell)).toEqual({ x: 3, y: 4 })
    expect(JSON.stringify(game.toDebugJson())).toBe(end)
  })

  it('re-applies commands pending at turn start so the replay matches', () => {
    const game = new Game(8, 'ai-vs-ai')
    const victim = placePiece(game, 'rook', 'red', { x: 0, y: 0 })
    game.cmds.damage.push({
      target: victim,
      source: null,
      amount: 100000,
      kind: 'test',
      lethal: true,
    })
    runTurn(game)
    expect(game.world.isAlive(victim)).toBe(false)
    const end = JSON.stringify(game.toDebugJson())

    replayToEnd(game)

    expect(game.world.isAlive(victim)).toBe(false)
    expect(JSON.stringify(game.toDebugJson())).toBe(end)
  })

  it('reproduces a turn that began from a drifted world', () => {
    const game = new Game(8, 'ai-vs-ai')
    // Free-run off the boundary, then start a turn from the drifted state.
    game.runTicks(5)
    runTurn(game)
    const end = JSON.stringify(game.toDebugJson())

    replayToEnd(game)

    expect(JSON.stringify(game.toDebugJson())).toBe(end)
  })

  it('does not grow the event log or shot/kill counters during a replay', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    const shots = game.bus.count('shot')
    const kills = game.bus.count('kill')
    const tailShots = game.bus.tail(600).filter((e) => e.type === 'shot' || e.type === 'kill').length

    replayToEnd(game)

    // Only the replay's own info bookends are logged; its re-emitted sim events
    // are duplicates and must not inflate the counters or the HUD stream.
    expect(game.bus.count('shot')).toBe(shots)
    expect(game.bus.count('kill')).toBe(kills)
    expect(game.bus.tail(600).filter((e) => e.type === 'shot' || e.type === 'kill').length).toBe(
      tailShots,
    )
    expect(game.snapshot().shots).toBe(shots)
    expect(game.bus.tail(600).some((e) => e.msg === 'replay finished')).toBe(true)
  })

  it('cannot replay a boundary that was not a turn', () => {
    const game = new Game(8)
    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 4 })
    game.cmds.damage.push({ target: redKing, source: null, amount: 100000, kind: 'test' })
    game.stepOnce()
    expect(game.winner).toBe('blue')
    expect(game.canReplay).toBe(false)

    game.undoTurn()
    expect(game.winner).toBeNull()
    expect(game.canReplay).toBe(false)
  })

  it('replays the fatal turn after the game ends', () => {
    const game = new Game(8)
    const redKing = placePiece(game, 'king', 'red', { x: 4, y: 4 })
    game.cmds.damage.push({ target: redKing, source: null, amount: 100000, kind: 'test' })
    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 3000) game.runTicks(1)
    expect(game.winner).toBe('blue')
    expect(game.canReplay).toBe(true)

    // No undo needed: replay rewinds to the pre-fatal start and re-runs it.
    game.replayTurn()
    expect(game.snapshot().replaying).toBe(true)
    guard = 0
    while (game.snapshot().replaying && guard++ < 5000) game.runTicks(1)
    expect(game.winner).toBe('blue')
    expect(game.world.isAlive(redKing)).toBe(false)
  })
})

describe('Game save/load with history', () => {
  beforeEach(() => clearComponents())

  it('restores the full undo history from a saved game', () => {
    const game = new Game(8, 'ai-vs-ai')
    const states = [JSON.stringify(game.toDebugJson())]
    for (let i = 0; i < 3; i++) {
      runTurn(game)
      states.push(JSON.stringify(game.toDebugJson()))
    }

    const saved = game.exportPosition({ history: true })
    expect(saved.history).toHaveLength(4)
    expect(saved.cursor).toBe(3)

    const loaded = new Game(8)
    const result = loaded.importPosition(JSON.parse(JSON.stringify(saved)))
    expect(result.ok).toBe(true)
    expect(JSON.stringify(loaded.toDebugJson())).toBe(states[3])
    expect(loaded.snapshot().canUndo).toBe(true)

    loaded.undoTurn()
    expect(JSON.stringify(loaded.toDebugJson())).toBe(states[2])
    loaded.undoTurn()
    expect(JSON.stringify(loaded.toDebugJson())).toBe(states[1])
    loaded.undoTurn()
    expect(JSON.stringify(loaded.toDebugJson())).toBe(states[0])

    // Replay metadata survives the round trip too.
    loaded.redoTurn()
    loaded.redoTurn()
    expect(loaded.canReplay).toBe(true)
    loaded.replayTurn()
    let guard = 0
    while (loaded.snapshot().replaying && guard++ < 5000) loaded.runTicks(1)
    expect(JSON.stringify(loaded.toDebugJson())).toBe(states[2])
  })

  it('keeps the saved cursor and redo branch', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    const after1 = JSON.stringify(game.toDebugJson())
    runTurn(game)
    const after2 = JSON.stringify(game.toDebugJson())
    game.undoTurn()

    const saved = game.exportPosition({ history: true })
    expect(saved.cursor).toBe(1)

    const loaded = new Game(8)
    loaded.importPosition(JSON.parse(JSON.stringify(saved)))
    expect(JSON.stringify(loaded.toDebugJson())).toBe(after1)
    expect(loaded.snapshot().canRedo).toBe(true)

    loaded.redoTurn()
    expect(JSON.stringify(loaded.toDebugJson())).toBe(after2)
  })

  it('leaves a position-only save without undo history', () => {
    const game = new Game(8, 'ai-vs-ai')
    runTurn(game)
    runTurn(game)
    const saved = game.exportPosition()
    expect(saved.history).toBeUndefined()

    const loaded = new Game(8)
    expect(loaded.importPosition(JSON.parse(JSON.stringify(saved))).ok).toBe(true)
    expect(loaded.snapshot().canUndo).toBe(false)
    expect(loaded.canReplay).toBe(false)
  })

  it('restores sim settings saved with the game', () => {
    const game = new Game(8, 'ai-vs-ai')
    game.setAutoPreserve(false)
    game.setChessKills(true)
    const saved = game.exportPosition({ history: true })

    const loaded = new Game(8)
    loaded.importPosition(JSON.parse(JSON.stringify(saved)))
    expect(loaded.autoPreserve).toBe(false)
    expect(loaded.chessKills).toBe(true)
  })
})

describe('hover readout', () => {
  beforeEach(() => clearComponents())

  it('reports a friendly piece name, kind and motion intent', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 3, y: 3 })
    game.world.require(rook, Motion).intent = 'defense'
    game.hoverCell = { x: 3, y: 3 }

    const hover = game.snapshot().hover
    expect(hover?.kind).toBe('friendly')
    expect(hover?.coord).toBe(coordName(3, 3, 8))
    expect(hover?.piece?.name).toBe(PIECES.rook.name)
    expect(hover?.piece?.intent).toBe('defense')
    expect(hover?.piece?.redacted).toBe(false)
  })

  it('redacts an enemy intent until the enemy-plans overlay is on', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'red', { x: 3, y: 3 })
    const motion = game.world.require(rook, Motion)
    motion.intent = 'preserve'
    motion.goal = { x: 4, y: 3 }
    game.hoverCell = { x: 3, y: 3 }

    const hidden = game.snapshot().hover
    expect(hidden?.kind).toBe('enemy')
    expect(hidden?.piece?.intent).toBe('none')
    expect(hidden?.piece?.goalCoord).toBeNull()
    expect(hidden?.piece?.redacted).toBe(true)

    game.overlays.enemyPlans = true
    const shown = game.snapshot().hover
    expect(shown?.piece?.intent).toBe('preserve')
    expect(shown?.piece?.goalCoord).toBe(coordName(4, 3, 8))
    expect(shown?.piece?.redacted).toBe(false)
  })

  it('reports an empty square with no piece', () => {
    const game = new Game(8)
    game.hoverCell = { x: 4, y: 4 }
    const hover = game.snapshot().hover
    expect(hover?.kind).toBe('empty')
    expect(hover?.piece).toBeNull()
  })
})
