import { formatBatchSummary, summarizeBatch } from './analysis'
import type { GameAnalysis } from './analysis'
import type { EventRecord } from '../ecs/events'
import type { Game } from './game'
import type { GameRecord } from './record'
import { LLM_PREAMBLE, formatShorthand } from './shorthand'
import { lastTurnActivity } from './transcript'
import type { TurnTrace } from './trace'
import type { TeamId } from './types'

export interface StudyPromptGame {
  seed: number
  winner: TeamId | null
  turns: number
  partial: boolean
  transcript: string
  analysis: GameAnalysis
}

/** One-time context explaining Bar Chess and the transcript format. */
const STUDY_PREAMBLE = `You are analysing recorded Bar Chess games for gameplay quality and fun.
Bar Chess is a real-time, chess-derived battle simulation on a rectangular grid.
Pieces are P N B R Q K; movement and firing both use chess geometry (rooks slide
on ranks/files, bishops on diagonals, knights leap, pawns advance and fire on
their two forward diagonals). Each turn every piece may make one move. A piece's
weapon geometry differs from its movement geometry. AI teams rally and engage on
their own; in human-vs-ai games the "human" side is driven by a scripted policy.
A piece is "under fire" while an enemy that recently hit it still covers it.
Pawns never retreat by design: they hold and fire instead of stepping back.

Reading a transcript:
  # opening / # final      the board at the start / end (Upper=red, lower=blue)
  T7: bP d2->d4            turn 7: the blue pawn moved d2 to d4
      rP e7 held(fire)     the red pawn stayed put while under fire
      rN f6 fired knight at bP d4   the red knight shot at the blue pawn
      bP d4 took 8 dmg (hp 34/42)   the blue pawn lost 8 hp
      bN c3 order: attack ordered -> bP b6   why the knight's order changed
                           (issued/replaced/completed/abandoned this turn)
  # pieces                 per piece: moves, shots, kills, hits taken, total
                           damage, turns under fire, held turns, death turn

Please analyse these games and identify gameplay gaps and playability issues:
- pieces that hold under fire when they should reposition (pawns are by design)
- pieces that never move or never fire
- poor coordination / lack of focus fire
- stalemates, oscillation, or long stretches where nothing happens
- any rule interaction that makes battles boring, degenerate or unfair
For each finding, cite the game seed and turn, explain the likely cause in the
simulation, and rank findings by how much they hurt the game.`

/** Build the full clipboard prompt: preamble + batch summary + all transcripts. */
export function buildStudyPrompt(
  games: StudyPromptGame[],
  options: { mode?: string; size?: number } = {},
): string {
  const summary = summarizeBatch(games)
  const size = options.size ?? 8
  const header = `Batch: ${games.length} game(s), board ${size}x${size}, mode ${options.mode ?? 'ai-vs-ai'}.`
  const report = formatBatchSummary(summary)
  const transcripts = games
    .map(
      (g) =>
        `===== game seed=${g.seed} winner=${g.winner ?? 'none'} turns=${g.turns}` +
        `${g.partial ? ' (partial)' : ''} =====\n${g.transcript}`,
    )
    .join('\n\n')
  return [STUDY_PREAMBLE, header, '# batch summary', report, '# transcripts', transcripts].join('\n\n')
}

/** One- or few-line, LLM-readable summary of a single game's flagged behaviour. */
export function formatGameAnalysis(analysis: GameAnalysis): string {
  const lines = [
    `winner=${analysis.winner ?? 'none'} turns=${analysis.turns}` +
      `${analysis.partial ? ' (partial)' : ''} shots=${analysis.shots} hits=${analysis.hits} ` +
      `kills=${analysis.kills} noProgressTurns=${analysis.noProgressTurns}`,
  ]
  if (analysis.heldUnderFire.length > 0) {
    lines.push(
      'heldUnderFire: ' +
        analysis.heldUnderFire
          .map((h) => `${h.piece} ${h.turns} (${h.hitsTaken} hits${h.isPawn ? ', pawn' : ''})`)
          .join('; '),
    )
  }
  if (analysis.neverMoved.length > 0) lines.push(`neverMoved: ${analysis.neverMoved.join(', ')}`)
  if (analysis.neverFired.length > 0) lines.push(`neverFired: ${analysis.neverFired.join(', ')}`)
  if (analysis.oscillation.length > 0) lines.push(`oscillation: ${analysis.oscillation.join(', ')}`)
  if (analysis.focusFire.length > 0) {
    lines.push(
      'focusFire: ' + analysis.focusFire.map((f) => `${f.target} T${f.turn}×${f.attackers}`).join('; '),
    )
  }
  return lines.join('\n')
}

export interface GamePromptInput {
  game: Game
  record: GameRecord
  transcript: string
  analysis: GameAnalysis
}

/**
 * A self-contained prompt for debugging one battle: rules, the current compact
 * board, the turn-by-turn transcript, flagged analysis and the replay record.
 * This is the one artifact to paste when asking an LLM about the live game.
 */
export function buildGamePrompt(input: GamePromptInput): string {
  const { game, record, transcript, analysis } = input
  const result = record.result
  const recordHeader =
    `# replay record seed=${record.seed} mode=${record.mode} board=${record.boardId} ` +
    `playerTeam=${record.playerTeam} winner=${result?.winner ?? 'none'} ` +
    `turns=${result?.turns ?? '?'} ticks=${result?.ticks ?? '?'}${result?.partial ? ' partial' : ''}`
  const recordNote =
    '# note: this record is a deterministic replay (seed + player inputs only); turns\n' +
    '# with no player input are omitted. It cannot be read on its own — the transcript\n' +
    '# above is the readable play-by-play.'
  return [
    LLM_PREAMBLE.trimEnd(),
    formatShorthand(game),
    '# transcript',
    transcript,
    '# analysis',
    formatGameAnalysis(analysis),
    recordHeader,
    recordNote,
    JSON.stringify(record),
  ].join('\n\n')
}

export interface SnapshotPromptInput {
  game: Game
  trace: TurnTrace[]
  events: EventRecord[]
}

/**
 * A per-turn situational snapshot: the current compact board plus what happened
 * in the last turn. No preamble or record — small enough to paste every turn.
 */
export function buildSnapshotPrompt(input: SnapshotPromptInput): string {
  const board = formatShorthand(input.game)
  const activity = lastTurnActivity(input.trace, input.events, input.game.board.height)
  return activity ? `${board}\n\n# last turn\n${activity}` : board
}
