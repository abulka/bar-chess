import { coordName } from './coords'
import type { EventRecord } from '../ecs/events'
import { cellIndex } from './board'
import { byTeamThenCell, renderAsciiGrid, TERRAIN_CHAR } from './grid'
import { vecEquals } from './math'
import type { GameRecord } from './record'
import { pieceTag } from './trace'
import type { PieceTrace, TurnTrace } from './trace'
import { pieceLabel, rangeLabel, summarizePieces } from './analysis'

export interface TranscriptInput {
  record: GameRecord
  events: EventRecord[]
  trace: TurnTrace[]
  /** Pre-rendered opening/final position blocks (optional). */
  opening?: string
  final?: string
  /** Board terrain, so per-turn boards show walls/water (optional). */
  terrain?: number[]
  /** Draw a compact board after each turn (default false). */
  boards?: boolean
}

const ACTIVITY_TYPES = new Set(['shot', 'damage', 'kill', 'advance', 'warn'])

function renderGrid(pieces: PieceTrace[], size: number, terrain?: number[]): string {
  return renderAsciiGrid(pieces, size, size, (x, y) =>
    terrain ? (TERRAIN_CHAR[terrain[cellIndex(x, y, size)]] ?? '.') : '.',
  )
}

/** One turn's activity line plus the end-of-turn piece layout. */
export interface TurnActivity {
  turn: number
  tick: number
  /** `T<n>: ...`, empty when nothing happened that turn. */
  text: string
  pieces: PieceTrace[]
}

/**
 * Render each turn's activity (moves, shots, damage, kills, held-under-fire).
 * Shared by the full transcript and the snapshot.
 */
export function turnActivities(trace: TurnTrace[], events: EventRecord[], height: number): TurnActivity[] {
  const stats = summarizePieces(trace, events)
  const statsByEntity = new Map(stats.map((s) => [s.entity, s]))
  const labelAt = (turnIndex: number, entity: number): string => {
    const piece = trace[turnIndex]?.pieces.find((p) => p.entity === entity)
    if (piece) return `${pieceTag(piece.team, piece.kind)} ${coordName(piece.cell.x, piece.cell.y, height)}`
    const stat = statsByEntity.get(entity)
    return stat ? pieceLabel(stat, height) : `#${entity}`
  }

  const out: TurnActivity[] = []
  for (let i = 1; i < trace.length; i++) {
    const before = new Map(trace[i - 1].pieces.map((p) => [p.entity, p]))
    const tokens: string[] = []
    const relabel = (text: string): string =>
      text.replace(/#(\d+)/g, (_m, id: string) => labelAt(i, Number(id)))
    for (const piece of trace[i].pieces) {
      const prev = before.get(piece.entity)
      if (prev && !vecEquals(prev.cell, piece.cell)) {
        tokens.push(
          `${pieceTag(piece.team, piece.kind)} ` +
            `${coordName(prev.cell.x, prev.cell.y, height)}->${coordName(piece.cell.x, piece.cell.y, height)}`,
        )
      } else if (prev && piece.underFire && piece.hp < prev.hp) {
        tokens.push(
          `${pieceTag(piece.team, piece.kind)} ` +
            `${coordName(piece.cell.x, piece.cell.y, height)} held(fire)`,
        )
      }
    }
    for (const event of events) {
      if (!ACTIVITY_TYPES.has(event.type)) continue
      if (event.tick <= trace[i - 1].tick || event.tick > trace[i].tick) continue
      tokens.push(relabel(event.msg))
    }
    // Why each order changed this turn: order transitions recorded on the piece
    // that were not present at the previous boundary. Matched by content (not
    // tick) because orders issued while paused share the previous turn's tick.
    for (const piece of trace[i].pieces) {
      const seen = new Set(
        (before.get(piece.entity)?.orderLog ?? []).map((n) => `${n.tick}\u0000${n.text}`),
      )
      for (const note of piece.orderLog ?? []) {
        if (seen.has(`${note.tick}\u0000${note.text}`)) continue
        tokens.push(
          `${pieceTag(piece.team, piece.kind)} ` +
            `${coordName(piece.cell.x, piece.cell.y, height)} order: ${relabel(note.text)}`,
        )
      }
    }
    out.push({
      turn: trace[i].turn,
      tick: trace[i].tick,
      text: tokens.length > 0 ? `T${trace[i].turn}: ${tokens.join('; ')}` : '',
      pieces: trace[i].pieces,
    })
  }
  return out
}

/** Every non-empty turn activity line, e.g. `T5: bP d2->d4; ...`. */
export function turnActivityLines(trace: TurnTrace[], events: EventRecord[], height: number): string[] {
  return turnActivities(trace, events, height)
    .map((a) => a.text)
    .filter((text) => text.length > 0)
}

/** The most recent turn's activity line, or null when nothing happened. */
export function lastTurnActivity(trace: TurnTrace[], events: EventRecord[], height: number): string | null {
  const lines = turnActivityLines(trace, events, height)
  return lines.length > 0 ? lines[lines.length - 1] : null
}

/**
 * Turn a recorded game (plus its event stream and per-turn trace) into a compact,
 * LLM-readable transcript: header, opening board, per-turn activity and a
 * per-piece activity summary that makes "held under fire" explicit.
 */
export function formatTranscript(input: TranscriptInput): string {
  const { record, events, trace } = input
  const height = record.size
  const result = record.result
  const lines: string[] = []

  lines.push(
    `# game ${record.boardId} seed=${record.seed} mode=${record.mode} ` +
      `winner=${result?.winner ?? 'none'} turns=${result?.turns ?? trace.length - 1} ` +
      `ticks=${result?.ticks ?? '?'}${result?.timedOut ? ' (turn cap)' : ''}`,
  )
  lines.push(
    `# rules autoPreserve=${record.settings.autoPreserve ? 'on' : 'off'} ` +
      `captureAdvance=${record.settings.captureAdvance ? 'on' : 'off'} playerTeam=${record.playerTeam}`,
  )

  lines.push('# opening')
  lines.push(
    input.opening ?? (trace.length > 0 ? renderGrid(trace[0].pieces, height, input.terrain) : ''),
  )

  const stats = summarizePieces(trace, events)

  lines.push('# turns')
  if (input.boards) {
    for (const turn of turnActivities(trace, events, height)) {
      if (turn.text) lines.push(turn.text)
      lines.push(renderGrid(turn.pieces, height, input.terrain))
    }
  } else {
    lines.push(...turnActivityLines(trace, events, height))
  }

  lines.push('# pieces')
  const ordered = [...stats].sort(
    byTeamThenCell((s) => ({ team: s.team, x: s.firstCell.x, y: s.firstCell.y })),
  )
  for (const s of ordered) {
    const death = s.diedTurn !== null ? ` died=T${s.diedTurn}` : ''
    const held = s.heldTurns.length > 0 ? ` held=${rangeLabel(s.heldTurns)}` : ''
    lines.push(
      `${pieceLabel(s, height)}: moves=${s.moves} shots=${s.shots} kills=${s.kills} ` +
        `hitsTaken=${s.hitsTaken} dmg=${s.damageTaken} underFire=${s.underFireTurns}t${held}${death}`,
    )
  }

  if (input.final) {
    lines.push('# final')
    lines.push(input.final)
  }

  return lines.join('\n')
}
