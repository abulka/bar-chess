import { beforeEach, describe, expect, it } from 'vitest'
import { Motion, Order } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { clearComponents, placePiece } from '../helpers'

function runTurn(game: Game): void {
  game.beginTurn()
  let guard = 0
  while (game.turnActive && guard++ < 2000) game.runTicks(1)
  expect(guard).toBeLessThan(2000)
}

describe('order queue', () => {
  beforeEach(() => clearComponents())

  it('a second right-click appends a queued goto', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    game.selected = [rook]

    game.orderAt({ x: 0, y: 5 })
    const order = game.world.require(rook, Order)
    expect(order.kind).toBe('goto')
    expect(order.dest).toEqual({ x: 0, y: 5 })
    expect(order.queue).toHaveLength(0)

    game.orderAt({ x: 0, y: 3 })
    expect(order.queue).toHaveLength(1)
    expect(order.queue[0]).toMatchObject({ kind: 'goto', dest: { x: 0, y: 3 } })
  })

  it('queues moves then an attack, context-based', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]

    game.orderAt({ x: 4, y: 3 })
    game.orderAt({ x: 3, y: 4 })
    game.orderAt({ x: 4, y: 5 })

    const order = game.world.require(attacker, Order)
    expect(order.kind).toBe('goto')
    expect(order.queue.map((s) => s.kind)).toEqual(['goto', 'attack'])
    const atk = order.queue[1]
    expect(atk.kind).toBe('attack')
    if (atk.kind === 'attack') expect(atk.target).toBe(victim)
  })

  it('applies the same sequence to every selected commandable piece', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    const knight = placePiece(game, 'knight', 'blue', { x: 7, y: 7 })
    game.selected = [rook, knight]

    game.orderAt({ x: 0, y: 5 })
    game.orderAt({ x: 0, y: 3 })

    expect(game.world.require(rook, Order).queue).toHaveLength(1)
    expect(game.world.require(knight, Order).queue).toHaveLength(1)
  })

  it('keeps the queue while the active waypoint is blocked by a friendly', () => {
    const game = new Game(8)
    // The f1 bishop's diagonal to h3 is blocked by the friendly g2 pawn.
    const bishop = game
      .toDebugJson()
      .pieces.find(
        (p: any) => p.team === 'blue' && p.kind === 'bishop' && p.cell.x === 5 && p.cell.y === 7,
      ).e as number
    game.selected = [bishop]
    game.orderAt({ x: 7, y: 5 })
    game.orderAt({ x: 6, y: 4 })
    runTurn(game)

    const order = game.world.require(bishop, Order)
    expect(order.kind).toBe('goto')
    expect(order.queue).toHaveLength(1)
    if (order.queue[0].kind === 'goto') expect(order.queue[0].dest).toEqual({ x: 6, y: 4 })
  })

  it('promotes the next queued step once the active goto arrives', () => {
    const game = new Game(8)
    const queen = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    game.selected = [queen]

    game.orderAt({ x: 4, y: 3 })
    game.orderAt({ x: 3, y: 3 })
    runTurn(game)

    const order = game.world.require(queen, Order)
    expect(order.queue).toHaveLength(0)
    expect(order.kind).toBe('goto')
    expect(order.dest).toEqual({ x: 3, y: 3 })
  })

  it('clearOrders empties the active order and the queue', () => {
    const game = new Game(8)
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    game.selected = [rook]
    game.orderAt({ x: 0, y: 5 })
    game.orderAt({ x: 0, y: 3 })

    game.clearOrders()
    const order = game.world.require(rook, Order)
    expect(order.kind).toBe('none')
    expect(order.queue).toHaveLength(0)
  })

  it('does not queue orders for AI-controlled pieces', () => {
    const game = new Game(8, 'ai-vs-ai')
    const rook = placePiece(game, 'rook', 'blue', { x: 0, y: 7 })
    game.selected = [rook]

    game.orderAt({ x: 0, y: 5 })
    game.orderAt({ x: 0, y: 3 })

    const order = game.world.require(rook, Order)
    expect(order.kind).toBe('none')
    expect(order.queue).toHaveLength(0)
  })

  it('round-trips a queued sequence through save/load', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    placePiece(game, 'king', 'red', { x: 4, y: 5 })
    game.selected = [attacker]

    game.orderAt({ x: 4, y: 3 })
    game.orderAt({ x: 4, y: 5 })

    const json = JSON.stringify(game.exportPosition())
    game.loadSize(8)
    const result = game.importPosition(JSON.parse(json))
    expect(result.ok).toBe(true)

    const order = game.world.require(attacker, Order)
    expect(order.kind).toBe('goto')
    expect(order.queue.map((s) => s.kind)).toEqual(['attack'])
  })
})
