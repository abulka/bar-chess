import { formatBatchSummary, summarizeBatch } from './analysis'
import type { GameAnalysis } from './analysis'
import type { EventRecord } from '../ecs/events'
import type { Game } from './game'
import { PIECE_LIST, WEAPONS } from './pieces'
import type { GameRecord } from './record'
import { LLM_GAME_RULES, LLM_PREAMBLE, formatShorthand } from './shorthand'
import { lastTurnActivity } from './transcript'
import { PIECE_LETTER } from './trace'
import type { TurnTrace } from './trace'
import type { Geometry, TeamId } from './types'

export interface StudyPromptGame {
  seed: number
  winner: TeamId | null
  turns: number
  partial: boolean
  transcript: string
  analysis: GameAnalysis
  record: GameRecord
}

/**
 * Study-only context. The game rules and position format live in the shared
 * `LLM_PREAMBLE`, so this only explains how to read a batch and the known
 * artifacts of its compact transcript.
 */
const STUDY_ADDENDUM = `This is a Study batch: watchable games run back to back, each recorded as a
turn-by-turn transcript plus a flagged analysis of how the pieces behaved.
Reading the batch:
  # batch summary            one line across all games (wins, kills, hits and flag counts)
  ===== game seed=... =====  one game; its seed reproduces it
  # game / # rules ...       per-game header and rule toggles, then # turns / # pieces / # final
  # analysis                 per-game flags: heldUnderFire (pieces that stayed put while
                             under fire; 'pawn' marks the intentional case), neverMoved,
                             neverFired, oscillation (reversals), focusFire (turns where two or
                             more attackers hit one target), noProgressTurns, shots/hits/kills.
Known artifacts of the compact transcript (do not read these as rule flaws):
  - Event lines (fired / took dmg / destroyed / order) name a unit by its position at the END of
    the turn, or its last sampled square if it died that turn.
  - A '->' line is start-of-turn to end-of-turn and can combine a normal move with a
    capture-advance step.
  - A piece that moves and dies in the same turn has no move line and can show moves=0.
The per-turn boards and the # pieces stats are the authority on positions and movement.

Please analyse these games and identify gameplay gaps and playability issues:
- pieces that hold under fire when they should reposition (pawns are by design)
- pieces that never move or never fire
- poor coordination / lack of focus fire
- stalemates, oscillation, or long stretches where nothing happens
- any rule interaction that makes battles boring, degenerate or unfair
For each finding, cite the game seed and turn, explain the likely cause in the
simulation, and rank findings by how much they hurt the game. Prefer concrete,
testable rule or behaviour changes, and separate evidence from speculation.`

function geometryNote(g: Geometry): string {
  switch (g.kind) {
    case 'slide':
      return `slide ${g.dirs.length}dir rng${g.range}`
    case 'leap':
      return 'leap'
    case 'pawn':
      return `pawn fwd${g.forward}`
  }
}

/** Current piece/weapon numbers, generated so the rules reference stays in sync. */
export function formatPieceRules(): string {
  const lines = ['# pieces & weapons (current values)']
  for (const def of PIECE_LIST) {
    const w = WEAPONS[def.weapon]
    const dmg = w.damageFraction !== undefined ? `${w.damageFraction}*maxHp` : `${w.damage}`
    lines.push(
      `${PIECE_LETTER[def.key]} ${def.key} hp=${def.hp} move=${geometryNote(def.move)} ` +
        `moveCd=${def.moveCooldown}s weapon=${w.key} dmg=${dmg} cd=${w.cooldown}s ` +
        `hit=${geometryNote(w.geometry)}`,
    )
  }
  return lines.join('\n')
}

export interface StudyPromptOptions {
  mode?: string
  size?: number
  /** Include each game's full replay record JSON (default false: verbose replay data). */
  includeRecord?: boolean
}

/** Build the full clipboard prompt: preamble + rules + batch summary + every game. */
export function buildStudyPrompt(
  games: StudyPromptGame[],
  options: StudyPromptOptions = {},
): string {
  const summary = summarizeBatch(games)
  const size = options.size ?? 8
  const includeRecord = options.includeRecord ?? false
  const header = `Batch: ${games.length} game(s), board ${size}x${size}, mode ${options.mode ?? 'ai-vs-ai'}.`
  const report = formatBatchSummary(summary)
  const transcripts = games
    .map((g) => {
      const body = formatGamePromptBody(
        { transcript: g.transcript, analysis: g.analysis, record: g.record },
        { includeRecord },
      )
      return (
        `===== game seed=${g.seed} winner=${g.winner ?? 'none'} turns=${g.turns}` +
        `${g.partial ? ' (partial)' : ''} =====\n${body}`
      )
    })
    .join('\n\n')
  return [
    LLM_GAME_RULES.trimEnd(),
    STUDY_ADDENDUM,
    formatPieceRules(),
    header,
    '# batch summary',
    report,
    '# transcripts',
    transcripts,
  ].join('\n\n')
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
  if (analysis.neverMovedUnderFire.length > 0) {
    lines.push(
      'neverMovedUnderFire: ' +
        analysis.neverMovedUnderFire
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

export interface GamePromptBodyInput {
  transcript: string
  analysis: GameAnalysis
  record: GameRecord
}

/**
 * The readable body of one game's prompt: transcript, flagged analysis and
 * (optionally) the replay record. Shared by the live copy bundle and the study
 * batch so both render identically.
 */
export function formatGamePromptBody(
  input: GamePromptBodyInput,
  options: { includeRecord?: boolean } = {},
): string {
  const { transcript, analysis, record } = input
  const result = record.result
  const recordHeader =
    `# replay record seed=${record.seed} mode=${record.mode} board=${record.boardId} ` +
    `playerTeam=${record.playerTeam} winner=${result?.winner ?? 'none'} ` +
    `turns=${result?.turns ?? '?'} ticks=${result?.ticks ?? '?'}${result?.partial ? ' partial' : ''}`
  const recordNote =
    '# note: this record is a deterministic replay (seed + player inputs only); turns\n' +
    '# with no player input are omitted. It cannot be read on its own — the transcript\n' +
    '# above is the readable play-by-play.'
  const sections = ['# transcript', transcript, '# analysis', formatGameAnalysis(analysis)]
  if (options.includeRecord ?? true) sections.push(recordHeader, recordNote, JSON.stringify(record))
  return sections.join('\n\n')
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
  return [
    LLM_PREAMBLE.trimEnd(),
    formatShorthand(game),
    formatGamePromptBody({ transcript, analysis, record }, { includeRecord: true }),
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
