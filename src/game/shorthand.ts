import {
  Cell,
  Fx,
  Health,
  Motion,
  Order,
  PieceType,
  Position,
  Projectile,
  Stance,
  Target,
  Team,
  Weapon,
} from '../ecs/components'
import { TERRAIN_DEFS } from './board'
import { coordName, fileLabel } from './coords'
import type { Game } from './game'
import type { Entity } from '../ecs/world'
import type { TeamId, Vec2 } from './types'

const PIECE_LETTER: Record<string, string> = {
  pawn: 'P',
  knight: 'N',
  bishop: 'B',
  rook: 'R',
  queen: 'Q',
  king: 'K',
}

const TERRAIN_CHAR: Record<number, string> = {
  0: '.',
  1: ':',
  2: ',',
  3: '~',
  4: '#',
}

const MAX_PATH = 16
const MAX_TERRAIN = 256

const FORMAT_LEGEND =
  '# fmt: r|b + piece(PNBRQK) + cell; hp=cur/max; @M=move @A=attack stance; goto=<cell>; ' +
  'atk=#id(cell)[!]=attack order (! positionally unreachable); tgt=#id(cell) current target; ' +
  'fire=#id under retaliation; goal=<cell> path end; path=hop>hop (A* move hops); blk=route blocked; ' +
  'moving=mid-hop; res=<cell> reserved next cell; park=#id suspended attack; ' +
  'q=step>step queued steps after the active order (cell=goto, atk#id(cell)=attack); ' +
  'w=weapon reload seconds; grid red=Upper blue=lower. terrain: . floor : road , sand ~ water # wall'

/**
 * One-time context for an LLM reading the shorthand. Prepend to a position when
 * the model has no other explanation of the game or the format.
 */
export const LLM_PREAMBLE = `Bar Chess is a real-time, chess-derived battle simulation on a rectangular grid.
Squares are named <file a..><rank from bottom>: a1 is bottom-left, h8 top-right.
Pieces are P N B R Q K. Movement and firing use chess geometry: pawns step/capture one diagonal
forward, sliding pieces (R/B/Q) are blocked by the first piece or wall, knights leap, bishops stay
on one colour. A piece's weapon geometry differs from its movement geometry (e.g. a pawn fires its
two forward diagonals at range 1; a rook fires along ranks/files).
The sim runs a fixed 30Hz tick loop. A "turn" gives each piece one move; a route is an A* path over
its own move geometry, so one "path" cell is one hop (a rook's next hop can be far, a knight's
fixed). All randomness is seeded, so a position plus inputs replays identically.
Reading a position block:
  <r|b><PNBRQK> <cell>   one unit (r=red, b=blue); grid uses Upper=red, lower=blue
  hp<cur>/<max>          present only when damaged
  @M | @A                stance: M=move (return fire only), A=attack (auto-engage nearby)
  goto=<cell>            standing move order (park=<#id(cell)> if an attack is suspended for it)
  atk=#id(cell)          standing attack order ('!' = target positionally unreachable, e.g. wrong colour)
  q=a>b>atk#id(cell)     queued steps after the active order (cell=goto, atk#id=attack), run in sequence
  tgt=#id(cell)          current auto-acquired or retaliated target
  goal=<cell>            current motion goal (where the planned path ends)
  path=a>b>c             planned route waypoints; each is one move hop, not every traversed square
  blk / moving / res     route blocked and waiting / mid-hop / reserved destination cell
  w=<seconds>            weapon reload remaining
  fire=#id               firing under retaliation from that unit
Other lines: "# terrain" lists non-floor cells only; "# proj:" lists in-flight shots as
<team> <cell> -> <target cell> <trajectory> ttl=<seconds>. Empty cells in the grid are terrain.

Position follows:
`

function cellName(width: number, height: number, c: Vec2): string {
  void width
  return coordName(c.x, c.y, height)
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export interface ShorthandOptions {
  /** Draw an ASCII board. Defaults to auto: on for boards up to 16x16. */
  grid?: boolean
}

/** Compact, line-oriented position dump intended for reading, not importing. */
export function formatShorthand(game: Game, options: ShorthandOptions = {}): string {
  const board = game.board
  const width = board.width
  const height = board.height
  const lines: string[] = []

  const mode = game.paused ? 'paused' : 'running'
  const winner = game.winner ? ` winner=${game.winner}` : ''
  lines.push(
    `# ${board.data.id} ${width}x${height} tick=${game.tick} turn=${game.turn} ${game.gameMode} you=${game.playerTeam} ${mode}${winner}`,
  )

  const side = (team: TeamId): string => {
    const runtime = game.teams[team]
    const alive = Object.values(runtime.alive).reduce((a, b) => a + b, 0)
    return `${team} alive=${alive} k=${runtime.kills} L=${runtime.losses}`
  }
  lines.push(`# ${side('red')} | ${side('blue')}`)

  const terrain: string[] = []
  for (let y = 0; y < height && terrain.length < MAX_TERRAIN; y++) {
    for (let x = 0; x < width && terrain.length < MAX_TERRAIN; x++) {
      const id = board.terrainAt(x, y)
      if (id !== 0) terrain.push(`${coordName(x, y, height)}=${TERRAIN_DEFS[id]?.name ?? id}`)
    }
  }
  if (terrain.length > 0) {
    lines.push(`# terrain ${terrain.join(' ')}${terrain.length >= MAX_TERRAIN ? ' …' : ''}`)
  }

  interface Unit {
    team: TeamId
    cell: Vec2
    kind: string
    text: string
  }
  const units: Unit[] = []
  const byCell = new Map<number, Entity>()

  for (const e of game.world.query(Cell, Team, PieceType, Health, Stance, Order, Target, Motion)) {
    const cell = game.world.require(e, Cell)
    const team = game.world.require(e, Team)
    const kind = game.world.require(e, PieceType).kind
    const health = game.world.require(e, Health)
    const stance = game.world.require(e, Stance)
    const order = game.world.require(e, Order)
    const target = game.world.require(e, Target)
    const motion = game.world.require(e, Motion)
    byCell.set(cell.y * width + cell.x, e)

    const flags: string[] = []
    if (health.cur < health.max) flags.push(`hp${Math.round(health.cur)}/${health.max}`)
    if (stance.mode === 'move') flags.push('@M')
    else if (stance.mode === 'attack') flags.push('@A')

    if (order.kind === 'goto') {
      flags.push(`goto=${order.dest ? cellName(width, height, order.dest) : '?'}`)
      if (order.resumeTarget !== null && game.world.isAlive(order.resumeTarget)) {
        flags.push(`park=${refName(game, width, height, order.resumeTarget)}`)
      }
    } else if (order.kind === 'attack' && order.target !== null) {
      flags.push(`atk=${refName(game, width, height, order.target)}${order.reachable ? '' : '!'}`)
    }
    if (order.queue.length > 0) {
      const steps = order.queue
        .map((step) =>
          step.kind === 'goto' ? cellName(width, height, step.dest) : `atk${refName(game, width, height, step.target)}`,
        )
        .join('>')
      flags.push(`q=${steps}`)
    }

    if (target.entity !== null && game.world.isAlive(target.entity)) {
      flags.push(`tgt=${refName(game, width, height, target.entity)}`)
    }
    const attacker =
      target.lastAttacker !== null && game.world.isAlive(target.lastAttacker) ? target.lastAttacker : null
    if (attacker !== null && game.tick < target.underFireUntil) {
      flags.push(`fire=${refName(game, width, height, attacker)}`)
    }

    if (motion.goal) flags.push(`goal=${cellName(width, height, motion.goal)}`)
    if (motion.blocked) flags.push('blk')
    if (motion.moving) flags.push('moving')
    if (motion.reserved) flags.push(`res=${cellName(width, height, motion.reserved)}`)
    if (motion.path.length > 0) {
      const cells = motion.path
        .slice(0, MAX_PATH)
        .map((c) => cellName(width, height, c))
        .join('>')
      flags.push(`path=${cells}${motion.path.length > MAX_PATH ? '…' : ''}`)
    }
    const weapon = game.world.get(e, Weapon)
    if (weapon && weapon.left > 0.05) flags.push(`w=${round1(weapon.left)}`)

    const letter = PIECE_LETTER[kind] ?? '?'
    units.push({
      team,
      cell: { x: cell.x, y: cell.y },
      kind,
      text: `${team[0]}${letter} ${cellName(width, height, cell)}${flags.length ? ' ' + flags.join(' ') : ''}`,
    })
  }

  const showGrid = options.grid ?? (width <= 16 && height <= 16)
  if (showGrid) {
    lines.push('# grid')
    lines.push(gridHeader(width))
    for (let y = 0; y < height; y++) {
      const rank = String(height - y).padStart(String(height).length)
      const cells: string[] = []
      for (let x = 0; x < width; x++) {
        const e = byCell.get(y * width + x)
        if (e !== undefined) {
          const team = game.world.require(e, Team)
          const letter = PIECE_LETTER[game.world.require(e, PieceType).kind] ?? '?'
          cells.push(team === 'red' ? letter : letter.toLowerCase())
        } else {
          cells.push(TERRAIN_CHAR[board.terrainAt(x, y)] ?? '?')
        }
      }
      lines.push(`${rank} ${cells.join(' ')}`)
    }
  }

  lines.push(FORMAT_LEGEND)

  units.sort((a, b) => {
    if (a.team !== b.team) return a.team === 'red' ? -1 : 1
    return a.cell.y - b.cell.y || a.cell.x - b.cell.x
  })
  for (const unit of units) lines.push(unit.text)

  if (game.selected.length > 0) {
    lines.push(`# selected ${game.selected.map((e) => `#${e}`).join(' ')}`)
  }

  const projectiles = game.world.query(Projectile, Position)
  if (projectiles.length > 0) {
    const parts = projectiles.map((e) => {
      const proj = game.world.require(e, Projectile)
      const pos = game.world.require(e, Position)
      const cell = board.worldToCell(pos.x, pos.y)
      const targetCell = proj.target !== null ? game.world.get(proj.target, Cell) : undefined
      const to = targetCell ? cellName(width, height, targetCell) : '?'
      return `${proj.team[0]} ${cellName(width, height, cell)}->${to} ${proj.trajectory} ttl=${round1(proj.ttl)}`
    })
    lines.push(`# proj: ${parts.join('; ')}`)
  }

  const fx = game.world.query(Fx).length
  if (fx > 0) lines.push(`# fx ${fx}`)

  return lines.join('\n')
}

/** Preamble + position, for the first message of a debugging conversation. */
export function formatForLlm(game: Game, options: ShorthandOptions = {}): string {
  return `${LLM_PREAMBLE}\n${formatShorthand(game, options)}`
}

function refName(game: Game, width: number, height: number, entity: Entity): string {
  const cell = game.world.get(entity, Cell)
  return cell ? `#${entity}(${cellName(width, height, cell)})` : `#${entity}`
}

function gridHeader(width: number): string {
  const labels: string[] = []
  for (let x = 0; x < width; x++) labels.push(fileLabel(x))
  return `  ${labels.join(' ')}`
}
