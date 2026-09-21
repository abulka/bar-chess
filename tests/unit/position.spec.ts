import { beforeEach, describe, expect, it } from 'vitest'
import { Order } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { clearComponents, orderAttack, placePiece } from '../helpers'

describe('position serialization', () => {
  beforeEach(() => clearComponents())

  it('round-trips a running battle byte-for-byte', () => {
    const game = new Game(16, 'ai-vs-ai')
    game.runTicks(240)
    const json = JSON.stringify(game.exportPosition())

    game.loadSize(8)
    const result = game.importPosition(JSON.parse(json))

    expect(result.ok).toBe(true)
    expect(JSON.stringify(game.exportPosition())).toBe(json)
  })

  it('round-trips in-flight projectiles', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    orderAttack(game, attacker, victim, true)
    game.runTicks(2)
    expect(game.snapshot().counts.projectiles).toBeGreaterThan(0)

    const json = JSON.stringify(game.exportPosition())
    game.importPosition(JSON.parse(json))
    expect(JSON.stringify(game.exportPosition())).toBe(json)
  })

  it('preserves the RNG stream so the future is identical', () => {
    const control = new Game(16, 'ai-vs-ai')
    control.runTicks(60)
    const snapshot = control.exportPosition()
    control.runTicks(120)
    const expected = JSON.stringify(control.exportPosition())

    const restored = new Game(16, 'ai-vs-ai')
    const result = restored.importPosition(snapshot)
    expect(result.ok).toBe(true)
    restored.runTicks(120)

    expect(JSON.stringify(restored.exportPosition())).toBe(expected)
  })

  it('keeps entity references valid across a round trip', () => {
    const game = new Game(8)
    const attacker = placePiece(game, 'queen', 'blue', { x: 4, y: 4 })
    const victim = placePiece(game, 'king', 'red', { x: 4, y: 5 })
    orderAttack(game, attacker, victim, true)
    game.runTicks(3)

    const snapshot = game.exportPosition()
    game.loadSize(8)
    game.importPosition(snapshot)

    expect(game.world.require(attacker, Order).target).toBe(victim)
    expect(game.world.isAlive(victim)).toBe(true)
  })

  it('preserves painted terrain', () => {
    const game = new Game(8)
    game.paint(3, 3, 4)
    const snapshot = game.exportPosition()

    game.loadSize(8)
    game.importPosition(snapshot)

    expect(game.board.terrainAt(3, 3)).toBe(4)
  })

  it('rejects malformed data without touching the game', () => {
    const game = new Game(8)
    const before = JSON.stringify(game.exportPosition())

    expect(game.importPosition({ version: 999 }).ok).toBe(false)
    expect(game.importPosition('not a position').ok).toBe(false)
    expect(game.importPosition(null).ok).toBe(false)

    expect(JSON.stringify(game.exportPosition())).toBe(before)
  })
})
