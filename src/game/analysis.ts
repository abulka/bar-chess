import { coordName } from './coords'
import type { EventRecord } from '../ecs/events'
import { vecEquals } from './math'
import type { GameRecord } from './record'
import { pieceTag } from './trace'
import type { PieceTrace, TurnTrace } from './trace'
import type { TeamId, Vec2 } from './types'

/** Aggregate behaviour of one piece across a whole game. */
export interface PieceStats {
  entity: number
  team: TeamId
  kind: string
  firstCell: Vec2
  lastCell: Vec2
  moves: number
  shots: number
  kills: number
  hitsTaken: number
  damageTaken: number
  underFireTurns: number
  heldTurns: number[]
  /** Hits absorbed on turns spent stationary under fire. */
  heldHits: number
  /** Longest run of turns stationary under fire while taking at least one hit. */
  maxHoldStreak: number
  /** Self-preservation retreat episodes started, from the order log. */
  retreats: number
  diedTurn: number | null
  lastTurn: number
  hp: number
  maxHp: number
}

export function pieceLabel(stats: PieceStats, height: number): string {
  return `${pieceTag(stats.team, stats.kind)} ${coordName(stats.lastCell.x, stats.lastCell.y, height)}`
}

/** Compress turn numbers into ranges, e.g. [4,5,6,9] -> "T4-6,T9". */
export function rangeLabel(turns: number[]): string {
  if (turns.length === 0) return '-'
  const sorted = [...turns].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const value = sorted[i]
    if (value === prev + 1) {
      prev = value
      continue
    }
    parts.push(start === prev ? `T${start}` : `T${start}-${prev}`)
    start = value
    prev = value
  }
  return parts.join(',')
}

/** Roll the per-turn trace plus the event stream into per-piece statistics. */
export function summarizePieces(trace: TurnTrace[], events: EventRecord[]): PieceStats[] {
  const stats = new Map<number, PieceStats>()
  const ensure = (piece: PieceTrace): PieceStats => {
    let s = stats.get(piece.entity)
    if (!s) {
      s = {
        entity: piece.entity,
        team: piece.team,
        kind: piece.kind,
        firstCell: { ...piece.cell },
        lastCell: { ...piece.cell },
        moves: 0,
        shots: 0,
        kills: 0,
        hitsTaken: 0,
        damageTaken: 0,
        underFireTurns: 0,
        heldTurns: [],
        heldHits: 0,
        maxHoldStreak: 0,
        retreats: 0,
        diedTurn: null,
        lastTurn: 0,
        hp: piece.hp,
        maxHp: piece.maxHp,
      }
      stats.set(piece.entity, s)
    }
    return s
  }

  // Hits per turn per piece, so a hold streak counts turns that actually hurt,
  // not merely turns spent inside the `underFire` latch.
  const hitsByTurnEntity = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'damage' || event.entity === undefined) continue
    const key = `${turnForTick(trace, event.tick)}:${event.entity}`
    hitsByTurnEntity.set(key, (hitsByTurnEntity.get(key) ?? 0) + 1)
  }
  // Retreat episodes, deduped across the per-turn orderLog snapshots.
  const retreatKeys = new Map<number, Set<string>>()
  for (const turn of trace) {
    for (const piece of turn.pieces) {
      for (const note of piece.orderLog ?? []) {
        if (!note.text.startsWith('self-preservation: retreating')) continue
        let set = retreatKeys.get(piece.entity)
        if (!set) {
          set = new Set()
          retreatKeys.set(piece.entity, set)
        }
        set.add(`${note.tick}\u0000${note.text}`)
      }
    }
  }

  let prev = new Map<number, PieceTrace>()
  const holdStreak = new Map<number, number>()
  for (const turn of trace) {
    const current = new Map<number, PieceTrace>()
    for (const piece of turn.pieces) {
      const s = ensure(piece)
      const before = prev.get(piece.entity)
      if (before && !vecEquals(before.cell, piece.cell)) s.moves++
      if (piece.underFire) {
        s.underFireTurns++
        if (before && vecEquals(before.cell, piece.cell)) {
          s.heldTurns.push(turn.turn)
          const hits = hitsByTurnEntity.get(`${turn.turn}:${piece.entity}`) ?? 0
          if (hits > 0) {
            s.heldHits += hits
            const streak = (holdStreak.get(piece.entity) ?? 0) + 1
            holdStreak.set(piece.entity, streak)
            if (streak > s.maxHoldStreak) s.maxHoldStreak = streak
          } else {
            holdStreak.set(piece.entity, 0)
          }
        }
      } else {
        holdStreak.set(piece.entity, 0)
      }
      s.lastCell = { ...piece.cell }
      s.hp = piece.hp
      s.maxHp = piece.maxHp
      s.lastTurn = turn.turn
      current.set(piece.entity, piece)
    }
    for (const entity of prev.keys()) {
      if (!current.has(entity)) {
        const s = stats.get(entity)
        if (s && s.diedTurn === null) s.diedTurn = turn.turn
      }
    }
    prev = current
  }

  for (const s of stats.values()) s.retreats = retreatKeys.get(s.entity)?.size ?? 0

  for (const event of events) {
    if (event.type === 'shot' && event.entity !== undefined) {
      const s = stats.get(event.entity)
      if (s) s.shots++
    } else if (event.type === 'damage' && event.entity !== undefined) {
      const s = stats.get(event.entity)
      if (s) {
        s.hitsTaken++
        const amount = event.data?.amount
        if (typeof amount === 'number') s.damageTaken += amount
      }
    } else if (event.type === 'kill') {
      const source = event.data?.source
      if (typeof source === 'number') {
        const s = stats.get(source)
        if (s) s.kills++
      }
    }
  }
  return [...stats.values()]
}

export interface HeldUnderFire {
  piece: string
  turns: string
  /** Total hits the piece took over the whole game. */
  hitsTaken: number
  /** Hits taken on the turns it spent stationary under fire. */
  heldHits: number
  /** Longest consecutive run of such turns with at least one hit. */
  maxStreak: number
  isPawn: boolean
}

export interface FocusFire {
  target: string
  attackers: number
  turn: number
}

export interface GameAnalysis {
  winner: TeamId | null
  turns: number
  partial: boolean
  shots: number
  hits: number
  kills: number
  /** Every piece that spent at least one turn stationary while under fire. */
  heldUnderFire: HeldUnderFire[]
  /** The subset of `heldUnderFire` that never moved at all, the stricter gap. */
  neverMovedUnderFire: HeldUnderFire[]
  neverMoved: string[]
  neverFired: string[]
  focusFire: FocusFire[]
  /** Turns where three or more attackers hit the same target. */
  overkill: number
  noProgressTurns: number
  oscillation: string[]
  /** Pieces that started three or more self-preservation retreats. */
  retreatLoops: string[]
  /** Turns where exactly one side had only its king left. */
  kingOnlyTurns: number
  /** Shots fired by a king while its side was down to that king alone. */
  kingShotsWhileAlone: number
  /** Cell signature of the first turns, for spotting identical openings. */
  openingSignature: string
}

function turnForTick(trace: TurnTrace[], tick: number): number {
  for (const t of trace) if (t.tick >= tick) return t.turn
  return trace.length > 0 ? trace[trace.length - 1].turn : 0
}

/** Identify gameplay gaps in one finished (or partial) game. */
export function analyzeGame(record: GameRecord, events: EventRecord[], trace: TurnTrace[]): GameAnalysis {
  const height = record.size
  const stats = summarizePieces(trace, events)
  const labels = new Map(stats.map((s) => [s.entity, pieceLabel(s, height)]))
  const labelOf = (entity: number): string => labels.get(entity) ?? `#${entity}`

  const shots = events.filter((e) => e.type === 'shot').length
  const hits = events.filter((e) => e.type === 'damage').length
  const kills = events.filter((e) => e.type === 'kill').length

  const heldUnderFire: HeldUnderFire[] = stats
    .filter((s) => s.heldTurns.length > 0)
    .map((s) => ({
      piece: pieceLabel(s, height),
      turns: rangeLabel(s.heldTurns),
      hitsTaken: s.hitsTaken,
      heldHits: s.heldHits,
      maxStreak: s.maxHoldStreak,
      isPawn: s.kind === 'pawn',
    }))

  const neverMovedUnderFire: HeldUnderFire[] = stats
    .filter((s) => s.moves === 0 && s.underFireTurns > 0)
    .map((s) => ({
      piece: pieceLabel(s, height),
      turns: rangeLabel(s.heldTurns),
      hitsTaken: s.hitsTaken,
      heldHits: s.heldHits,
      maxStreak: s.maxHoldStreak,
      isPawn: s.kind === 'pawn',
    }))

  const neverMoved = stats.filter((s) => s.moves === 0).map((s) => pieceLabel(s, height))
  const neverFired = stats.filter((s) => s.shots === 0).map((s) => pieceLabel(s, height))

  // Focus fire: turns where two or more distinct attackers damaged the same piece.
  const byTurnTarget = new Map<string, Set<number>>()
  for (const event of events) {
    if (event.type !== 'damage' || event.entity === undefined) continue
    const source = event.data?.source
    if (typeof source !== 'number') continue
    const turn = turnForTick(trace, event.tick)
    const key = `${turn}:${event.entity}`
    let set = byTurnTarget.get(key)
    if (!set) {
      set = new Set()
      byTurnTarget.set(key, set)
    }
    set.add(source)
  }
  const focusFire: FocusFire[] = []
  for (const [key, sources] of byTurnTarget) {
    if (sources.size < 2) continue
    const [turnText, entityText] = key.split(':')
    focusFire.push({ target: labelOf(Number(entityText)), attackers: sources.size, turn: Number(turnText) })
  }
  focusFire.sort((a, b) => a.turn - b.turn)
  const overkill = focusFire.filter((f) => f.attackers >= 3).length

  // No-progress turns: nobody moved and nothing took damage.
  let noProgressTurns = 0
  for (let i = 1; i < trace.length; i++) {
    const before = new Map(trace[i - 1].pieces.map((p) => [p.entity, p.cell]))
    let moved = 0
    for (const piece of trace[i].pieces) {
      const prevCell = before.get(piece.entity)
      if (prevCell && !vecEquals(prevCell, piece.cell)) moved++
    }
    const damaged = events.some((e) => e.type === 'damage' && turnForTick(trace, e.tick) === trace[i].turn)
    if (moved === 0 && !damaged) noProgressTurns++
  }

  // Oscillation: a piece that repeatedly returns to a square it just left.
  const oscillation: string[] = []
  for (const s of stats) {
    const cells: string[] = []
    for (const turn of trace) {
      const piece = turn.pieces.find((p) => p.entity === s.entity)
      if (!piece) continue
      const key = `${piece.cell.x},${piece.cell.y}`
      if (cells[cells.length - 1] !== key) cells.push(key)
    }
    let bounces = 0
    for (let i = 2; i < cells.length; i++) {
      if (cells[i] === cells[i - 2] && cells[i] !== cells[i - 1]) bounces++
    }
    if (bounces >= 3) oscillation.push(`${pieceLabel(s, height)} (${bounces} reversals)`)
  }

  const retreatLoops = stats
    .filter((s) => s.retreats >= 3)
    .map((s) => `${pieceLabel(s, height)} (${s.retreats} retreats)`)

  // King-only tracking: turns where exactly one side has nothing but its king,
  // and the shots its king fired during that phase (the death-spiral measure).
  const kingOnlyByTurn = new Map<number, Set<TeamId>>()
  let kingOnlyTurns = 0
  for (const turn of trace) {
    const hasField: Record<TeamId, boolean> = { red: false, blue: false }
    for (const piece of turn.pieces) if (piece.kind !== 'king') hasField[piece.team] = true
    const alone = new Set<TeamId>()
    if (!hasField.red) alone.add('red')
    if (!hasField.blue) alone.add('blue')
    if (alone.size === 1) {
      kingOnlyTurns++
      kingOnlyByTurn.set(turn.turn, alone)
    }
  }
  let kingShotsWhileAlone = 0
  for (const event of events) {
    if (event.type !== 'shot' || event.entity === undefined) continue
    const turn = turnForTick(trace, event.tick)
    const alone = kingOnlyByTurn.get(turn)
    if (!alone) continue
    const entry = trace.find((t) => t.turn === turn)
    const piece = entry?.pieces.find((p) => p.entity === event.entity)
    if (piece && piece.kind === 'king' && alone.has(piece.team)) kingShotsWhileAlone++
  }

  const openingSignature = trace
    .slice(0, 3)
    .map((t) =>
      t.pieces
        .map((p) => `${p.team}${p.kind}${p.cell.x},${p.cell.y}`)
        .sort()
        .join('|'),
    )
    .join(';')

  return {
    winner: record.result?.winner ?? null,
    turns: record.result?.turns ?? trace.length - 1,
    partial: record.result?.timedOut ?? false,
    shots,
    hits,
    kills,
    heldUnderFire,
    neverMovedUnderFire,
    neverMoved,
    neverFired,
    focusFire,
    overkill,
    noProgressTurns,
    oscillation,
    retreatLoops,
    kingOnlyTurns,
    kingShotsWhileAlone,
    openingSignature,
  }
}

export interface BatchGame {
  seed: number
  winner: TeamId | null
  turns: number
  partial: boolean
  analysis: GameAnalysis
}

export interface BatchSummary {
  games: number
  redWins: number
  blueWins: number
  /** Games that ended with no winner for a reason other than the turn cap. */
  draws: number
  /** Games stopped at the turn cap without a king death. */
  timeouts: number
  avgTurns: number
  totalKills: number
  totalShots: number
  totalHits: number
  heldCount: number
  neverMovedUnderFireCount: number
  neverMovedCount: number
  neverFiredCount: number
  oscillationCount: number
  noProgressTurns: number
  /** Total turns across the batch where one side had only its king left. */
  kingOnlyTurns: number
  /** Total shots fired by king-only sides. */
  kingShotsWhileAlone: number
  overkill: number
  retreatLoopCount: number
  /** Distinct opening signatures: 1 means every seed opened identically. */
  openingVariants: number
}

export function summarizeBatch(games: BatchGame[]): BatchSummary {
  let redWins = 0
  let blueWins = 0
  let draws = 0
  let timeouts = 0
  let turns = 0
  let totalKills = 0
  let totalShots = 0
  let totalHits = 0
  let heldCount = 0
  let neverMovedUnderFireCount = 0
  let neverMovedCount = 0
  let neverFiredCount = 0
  let oscillationCount = 0
  let noProgressTurns = 0
  let kingOnlyTurns = 0
  let kingShotsWhileAlone = 0
  let overkill = 0
  let retreatLoopCount = 0
  const openings = new Set<string>()
  for (const g of games) {
    if (g.winner === 'red') redWins++
    else if (g.winner === 'blue') blueWins++
    else if (g.partial) timeouts++
    else draws++
    turns += g.turns
    totalKills += g.analysis.kills
    totalShots += g.analysis.shots
    totalHits += g.analysis.hits
    heldCount += g.analysis.heldUnderFire.length
    neverMovedUnderFireCount += g.analysis.neverMovedUnderFire.length
    neverMovedCount += g.analysis.neverMoved.length
    neverFiredCount += g.analysis.neverFired.length
    oscillationCount += g.analysis.oscillation.length
    noProgressTurns += g.analysis.noProgressTurns
    kingOnlyTurns += g.analysis.kingOnlyTurns
    kingShotsWhileAlone += g.analysis.kingShotsWhileAlone
    overkill += g.analysis.overkill
    retreatLoopCount += g.analysis.retreatLoops.length
    if (g.analysis.openingSignature) openings.add(g.analysis.openingSignature)
  }
  const n = games.length || 1
  return {
    games: games.length,
    redWins,
    blueWins,
    draws,
    timeouts,
    avgTurns: turns / n,
    totalKills,
    totalShots,
    totalHits,
    heldCount,
    neverMovedUnderFireCount,
    neverMovedCount,
    neverFiredCount,
    oscillationCount,
    noProgressTurns,
    kingOnlyTurns,
    kingShotsWhileAlone,
    overkill,
    retreatLoopCount,
    openingVariants: openings.size,
  }
}

/** One-line, LLM-readable batch summary. */
export function formatBatchSummary(summary: BatchSummary): string {
  const hitRate = summary.totalShots > 0 ? ((summary.totalHits / summary.totalShots) * 100).toFixed(0) : '0'
  return (
    `games=${summary.games} red=${summary.redWins} blue=${summary.blueWins} draw=${summary.draws} ` +
    `timeouts=${summary.timeouts} avgTurns=${summary.avgTurns.toFixed(1)} kills=${summary.totalKills} ` +
    `shots=${summary.totalShots} hits=${summary.totalHits} hitRate=${hitRate}% ` +
    `heldUnderFire=${summary.heldCount} neverMovedUnderFire=${summary.neverMovedUnderFireCount} ` +
    `neverMoved=${summary.neverMovedCount} neverFired=${summary.neverFiredCount} ` +
    `oscillation=${summary.oscillationCount} noProgressTurns=${summary.noProgressTurns} ` +
    `retreatLoops=${summary.retreatLoopCount} kingOnlyTurns=${summary.kingOnlyTurns} ` +
    `kingShotsWhileAlone=${summary.kingShotsWhileAlone} overkill=${summary.overkill} ` +
    `openingVariants=${summary.openingVariants}`
  )
}
