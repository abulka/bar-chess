import { describe, expect, it } from 'vitest'
import type { GameAnalysis } from '../../src/game/analysis'
import type { GameRecord } from '../../src/game/record'
import { buildStudyPrompt, formatGamePromptBody } from '../../src/game/studyPrompt'
import type { StudyPromptGame } from '../../src/game/studyPrompt'

function analysis(overrides: Partial<GameAnalysis> = {}): GameAnalysis {
  return {
    winner: null,
    turns: 10,
    partial: true,
    shots: 2,
    hits: 2,
    kills: 0,
    heldUnderFire: [{ piece: 'rP e2', turns: 'T1', hitsTaken: 1, isPawn: true }],
    neverMovedUnderFire: [{ piece: 'rP e2', turns: 'T1', hitsTaken: 1, isPawn: true }],
    neverMoved: ['bK e1'],
    neverFired: ['bK e1'],
    focusFire: [],
    noProgressTurns: 1,
    oscillation: [],
    ...overrides,
  }
}

function record(seed = 7): GameRecord {
  return {
    v: 2,
    boardId: 'board-8',
    size: 8,
    mode: 'ai-vs-ai',
    playerTeam: 'blue',
    seed,
    settings: { autoPreserve: true, captureAdvance: false, chessKills: false },
    turns: [],
    result: { winner: null, turns: 10, ticks: 1200, timedOut: true },
  }
}

function game(seed = 7): StudyPromptGame {
  return {
    seed,
    winner: null,
    turns: 10,
    partial: true,
    transcript: `# game board-8 seed=${seed} winner=none turns=10 (turn cap)`,
    analysis: analysis(),
    record: record(seed),
  }
}

describe('study prompt', () => {
  it('reuses the shared preamble, adds rules and per-game analysis', () => {
    const text = buildStudyPrompt([game()])
    expect(text).toContain('A "turn" gives each piece one move')
    expect(text).toContain('the battle ends when a king dies')
    expect(text).toContain('# pieces & weapons (current values)')
    expect(text).toContain('hp=42')
    expect(text).toContain('# transcript')
    expect(text).toContain('# analysis')
    expect(text).toContain('heldUnderFire: rP e2 T1')
    expect(text).toContain('timeouts=1')
    expect(text).not.toContain('# replay record')
  })

  it('numbers each game block and includes the replay record only on request', () => {
    const lean = buildStudyPrompt([game(7), game(8)])
    expect(lean).toContain('===== game seed=7')
    expect(lean).toContain('===== game seed=8')

    const full = buildStudyPrompt([game()], { includeRecord: true })
    expect(full).toContain('# replay record seed=7')
    expect(full).toContain('"boardId":"board-8"')
  })

  it('announces the scripted human policy in the batch header', () => {
    const text = buildStudyPrompt([game()], {
      mode: 'human-vs-ai',
      policy: 'human',
      piecesPerTurn: 2,
      attackChance: 0.25,
    })
    expect(text).toContain('The human side is a scripted policy (human)')
    expect(text).toContain('2 piece(s) per turn')
    expect(text).toContain('25% attacks')
    expect(text).toContain("announced by a '# study'")
  })

  it('shares its body with the live copy bundle', () => {    const body = formatGamePromptBody({ transcript: 'T1: bP d2->d4', analysis: analysis(), record: record() })
    expect(body).toContain('# transcript')
    expect(body).toContain('# analysis')
    expect(body).toContain('# replay record')

    const lean = formatGamePromptBody(
      { transcript: 'T1: bP d2->d4', analysis: analysis(), record: record() },
      { includeRecord: false },
    )
    expect(lean).not.toContain('# replay record')
  })
})
