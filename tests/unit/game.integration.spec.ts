import { beforeEach, describe, expect, it } from 'vitest'
import { Motion, Order } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { clearComponents, orderAttack, placePiece } from '../helpers'

function runTurn(game: Game): void {
  game.beginTurn()
  let guard = 0
  while (game.turnActive && guard++ < 2000) game.runTicks(1)
  expect(guard).toBeLessThan(2000)
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

  it('a deploy command spawns a reinforcement on the next tick', () => {
    const game = new Game(8)
    const before = game.teams.blue.alive.pawn
    game.deploy('blue', 'pawn')
    game.stepOnce()
    expect(game.teams.blue.alive.pawn).toBe(before + 1)
  })

  it('orderAt issues a goto in move mode and an attack in attack mode', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]
    const order = game.world.require(attacker, Order)

    game.orderMode = 'move'
    game.orderAt({ x: 4, y: 5 })
    expect(order.kind).toBe('goto')
    expect(order.dest).toEqual({ x: 4, y: 5 })
    expect(order.queue).toEqual([])

    game.clearOrders()
    game.orderMode = 'attack'
    game.orderAt({ x: 4, y: 5 })
    expect(order.kind).toBe('attack')
    expect(order.target).toBe(victim)
    expect(order.reachable).toBe(true)
    expect(game.world.require(attacker, Motion).path).toEqual([])
  })

  it('does not command AI-controlled pieces', () => {
    const game = new Game(8, 'ai-vs-ai')
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]

    game.orderMode = 'attack'
    game.orderAt({ x: 4, y: 5 })
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

  it('orderAttack helper marks a clear shot as reachable', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    orderAttack(game, attacker, victim, true)
    expect(game.world.require(attacker, Order).target).toBe(victim)
  })
})
