import { fileLabel, coordName } from './coords'
import type { EventRecord } from '../ecs/events'
import type { GameRecord } from './record'
import { PIECE_LETTER, pieceTag } from './trace'
import type { PieceTrace, TurnTrace } from './trace'
import { pieceLabel, rangeLabel, summarizePieces } from './analysis'

export interface TranscriptInput {
  record: GameRecord
  events: EventRecord[]
  trace: TurnTrace[]
  /** Pre-rendered opening/final position blocks (optional). */
  opening?: string
  final?: string
}

const ACTIVITY_TYPES = new Set(['shot', 'damage', 'kill', 'advance', 'warn'])

function sameCell(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y
}

function renderGrid(pieces: PieceTrace[], size: number): string {
  const byCell = new Map<number, PieceTrace>()
  for (const p of pieces) byCell.set(p.cell.y * size + p.cell.x, p)
  const files: string[] = []
  for (let x = 0; x < size; x++) files.push(fileLabel(x))
  const lines: string[] = ['  ' + files.join(' ')]
  for (let y = 0; y < size; y++) {
    const rank = String(size - y).padStart(String(size).length)
    const cells: string[] = []
    for (let x = 0; x < size; x++) {
      const piece = byCell.get(y * size + x)
      if (!piece) {
        cells.push('.')
        continue
      }
      const letter = PIECE_LETTER[piece.kind] ?? '?'
      cells.push(piece.team === 'red' ? letter : letter.toLowerCase())
    }
    lines.push(`${rank} ${cells.join(' ')}`)
  }
  return lines.join('\n')
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
  lines.push(input.opening ?? (trace.length > 0 ? renderGrid(trace[0].pieces, height) : ''))

  const stats = summarizePieces(trace, events)
  const statsByEntity = new Map(stats.map((s) => [s.entity, s]))
  const labelAt = (turnIndex: number, entity: number): string => {
    const piece = trace[turnIndex]?.pieces.find((p) => p.entity === entity)
    if (piece) return `${pieceTag(piece.team, piece.kind)} ${coordName(piece.cell.x, piece.cell.y, height)}`
    const stat = statsByEntity.get(entity)
    return stat ? pieceLabel(stat, height) : `#${entity}`
  }

  lines.push('# turns')
  for (let i = 1; i < trace.length; i++) {
    const before = new Map(trace[i - 1].pieces.map((p) => [p.entity, p]))
    const tokens: string[] = []
    for (const piece of trace[i].pieces) {
      const prev = before.get(piece.entity)
      if (prev && !sameCell(prev.cell, piece.cell)) {
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
      const msg = event.msg.replace(/#(\d+)/g, (_m, id: string) => labelAt(i, Number(id)))
      tokens.push(msg)
    }
    if (tokens.length > 0) lines.push(`T${trace[i].turn}: ${tokens.join('; ')}`)
  }

  lines.push('# pieces')
  const ordered = [...stats].sort((a, b) => {
    if (a.team !== b.team) return a.team === 'red' ? -1 : 1
    return a.firstCell.y - b.firstCell.y || a.firstCell.x - b.firstCell.x
  })
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
