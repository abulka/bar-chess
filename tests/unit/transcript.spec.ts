import { describe, expect, it } from 'vitest'
import type { EventRecord } from '../../src/ecs/events'
import { analyzeGame, summarizePieces } from '../../src/game/analysis'
import { formatTranscript } from '../../src/game/transcript'
import type { GameRecord } from '../../src/game/record'
import type { TurnTrace } from '../../src/game/trace'

function record(): GameRecord {
  return {
    v: 1,
    boardId: 'board-8',
    size: 8,
    mode: 'ai-vs-ai',
    playerTeam: 'blue',
    seed: 1,
    settings: { autoPreserve: true, captureAdvance: false },
    turns: [],
    result: { winner: 'blue', turns: 2, ticks: 120, timedOut: false },
  }
}

function trace(): TurnTrace[] {
  return [
    {
      turn: 0,
      tick: 0,
      pieces: [
        { entity: 1, team: 'red', kind: 'pawn', cell: { x: 4, y: 6 }, goal: null, moving: false, movedThisTurn: false, orderKind: 'none', target: null, underFire: false, hp: 42, maxHp: 42 },
        { entity: 2, team: 'blue', kind: 'pawn', cell: { x: 3, y: 5 }, goal: null, moving: false, movedThisTurn: false, orderKind: 'none', target: null, underFire: false, hp: 42, maxHp: 42 },
      ],
    },
    {
      turn: 1,
      tick: 100,
      pieces: [
        { entity: 1, team: 'red', kind: 'pawn', cell: { x: 4, y: 6 }, goal: null, moving: false, movedThisTurn: false, orderKind: 'none', target: 2, underFire: true, hp: 34, maxHp: 42 },
        { entity: 2, team: 'blue', kind: 'pawn', cell: { x: 3, y: 6 }, goal: null, moving: false, movedThisTurn: true, orderKind: 'none', target: 1, underFire: false, hp: 42, maxHp: 42 },
      ],
    },
  ]
}

const events: EventRecord[] = [
  { seq: 1, tick: 50, phase: 'combat', type: 'shot', msg: '#2 fired pawn at #1', entity: 2, team: 'blue' },
  { seq: 2, tick: 60, phase: 'damage', type: 'damage', msg: '#1 took 8 dmg (hp 34/42)', entity: 1, team: 'red', data: { amount: 8, source: 2 } },
]

describe('transcript & analysis', () => {
  it('marks a piece held under fire and reports its stats', () => {
    const text = formatTranscript({ record: record(), events, trace: trace() })
    expect(text).toContain('# game board-8 seed=1')
    expect(text).toContain('rP e2 held(fire)')
    expect(text).toContain('bP d3->d2')
    expect(text).toContain('rP e2: moves=0 shots=0 kills=0 hitsTaken=1 dmg=8')
    expect(text).toContain('underFire=1t held=T1')
  })

  it('flags held-under-fire, never-moved and hit rate gaps', () => {
    const analysis = analyzeGame(record(), events, trace())
    expect(analysis.shots).toBe(1)
    expect(analysis.hits).toBe(1)
    expect(analysis.heldUnderFire).toEqual([
      { piece: 'rP e2', turns: 'T1', hitsTaken: 1, isPawn: true },
    ])
    expect(analysis.neverMoved).toContain('rP e2')
    expect(analysis.neverFired).toContain('rP e2')
  })

  it('summarizes per-piece movement', () => {
    const stats = summarizePieces(trace(), events)
    const pawn = stats.find((s) => s.entity === 2)
    expect(pawn?.moves).toBe(1)
    const held = stats.find((s) => s.entity === 1)
    expect(held?.moves).toBe(0)
    expect(held?.heldTurns).toEqual([1])
  })

  it('surfaces why an order changed, only for transitions new this turn', () => {
    const t = trace()
    t[0].pieces[0].orderLog = [{ tick: 0, text: 'attack ordered → #2' }]
    t[1].pieces[0].orderLog = [
      { tick: 0, text: 'attack ordered → #2' },
      { tick: 50, text: 'target #2 lost — attack abandoned' },
    ]
    const text = formatTranscript({ record: record(), events, trace: t })
    expect(text).toContain('rP e2 order: target bP d2 lost — attack abandoned')
    expect(text).not.toContain('rP e2 order: attack ordered')
  })
})
