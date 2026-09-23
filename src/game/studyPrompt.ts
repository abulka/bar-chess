import { formatBatchSummary, summarizeBatch } from './analysis'
import type { GameAnalysis } from './analysis'
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
export const STUDY_PREAMBLE = `You are analysing recorded Bar Chess games for gameplay quality and fun.
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
