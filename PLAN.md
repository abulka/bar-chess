# Bar Chess — Plan

A real-time, chess-derived battlefield. The player commands **pieces** (chess
identities plus custom ones) by giving them **intentions**, then watches
autonomous movement, firing, projectile flight and destruction play out.

## Design principles

- **Command, don't micromanage.** The player sets a piece's intention (mainly a
  destination) once; the piece works toward it, fighting opportunistically.
- **Not chess.** Chess supplies the movement language and piece identities.
  There are no turns, check, checkmate or required 8×8 board.
- **Real-time with pause as a strategy tool.** Pause to think, inspect and issue
  orders; unpause to watch consequences. Auto-pause triggers are planned and
  fully optional.
- **Movement geometry matters.** Rooks travel ranks/files, bishops diagonals,
  knights leap; geometry shapes approach, retreat, flanking and firing.
- **One piece per square.** Pieces occupy cells, block movement and block
  line of sight.
- **Firing geometry derives from the piece.** Rook fires along ranks/files,
  bishop along diagonals, queen both, knight has its own jump pattern, pawn
  forward diagonals. Custom pieces can have novel patterns.
- **Movement and weapons are separate systems.** A piece can move while its
  weapon reloads; both have cooldowns.
- **Projectiles are the product.** Slow, visible projectiles with distinct
  trajectories (line, jump, arcing artillery, homing, beam) that can miss,
  be blocked or arrive late.
- **Simulation and presentation are separate.** The sim knows a projectile was
  fired and where it is going; the spectacular rendering is a read-only layer.
- **Rules are experiments.** Important rules live in a configurable rule bank
  with presets; argue by playing, not by debating.
- **AI uses the same systems.** Human-vs-AI and AI-vs-AI are first-class.

## Approved decisions (defaults)

| # | Decision | Choice |
| - | -------- | ------ |
| 1 | Movement feel | Cell-claim grid movement with smooth render interpolation + move cooldown |
| 2 | Ordering | Watchable vertical slice first, then depth |
| 3 | Renderer | Canvas 2D |
| 4 | Default board | 8×8 @ 48px tiles; sizes 8/16/32/64 selectable |
| 5 | Art | Unicode chess glyphs tinted by team (no CDN dependency) |
| 6 | Blocking | Walls block movement + LOS + projectiles; water blocks movement only; pieces block movement + LOS |
| 7 | Firing | A weapon must satisfy its firing geometry (not merely range) to hit |
| 8 | Input | Click select, shift-click multi-select, right-click order, mode buttons/hotkeys |
| 9 | Teams | red / blue (N-team friendly) |
| 10 | Conventions | Strict TS, single runtime dependency (Vue), no comments unless asked |

## Stance vs order

Two distinct concepts:

**Stance** is a piece's persistent autonomous policy, shown as a badge on the
piece and set with the toolbar buttons or `1` / `2`(`a`) / `3`:

- **Move** (`1`, green) — travel and return fire only; never starts a fight.
- **Fight** (`2` or `a`, red) — seek and attack nearby targets, prefer damaged
  ones, and flee when below 30% HP. Does not chase across the board.
- **Hold** (`3`, amber) — never repositions; fires at whatever enters range.

**Order** is a one-shot instruction that overrides stance until fulfilled:

- **Right-click an empty square** → *goto*: move toward it. This is an
  **objective**, not a strict destination: each selected piece advances as far as
  its own geometry allows, so a pawn ordered to an off-file square still marches
  forward up its own file.
- **Right-click an enemy piece** → *attack*: become glued to that enemy, follow
  it, and fire when possible. Shown as a **red** tracking chain + a **red ring**
  around the targeted enemy. **Only the Fight stance** attacks; a Move/Hold piece
  treats an occupied square as a plain move (best-effort advance), never as a
  target, and a move order clears any stale target.
- Repeating an order toggles it off; `c` or `4` clears orders on the selection.
- The attack's route is planned immediately and drawn as a red dashed path (like
  a move) with a lock reticle on the victim, instead of a straight line.
- Issuing an attack or a Hold command returns the toolbar to Move; Move/Fight
  stay selected. An attack leaves the piece in **Hold** so once the target dies
  it stops and fires at whatever comes into range (no wandering).
- You can select and command **enemy pieces too** — a player-issued order
  bypasses the AI move budget, so you can drive either side.
- Tracking rings/chains follow the overlay scope: visible for the selection and,
  when on, `my orders` (`o`) / `enemy plans` (`e`) — never floating permanently.

**Team colour is Orange vs Blue** so that **red is reserved for attack
indicators** (tracking chain, targeted ring, Fight stance). Pieces have no
default ring — a red ring means "this piece is under an attack order".

Auto-targeting follows from this: attack order = sticky target; Fight = scored
auto-acquire; Hold = in-range only; Move = retaliation only (returns fire at its
attacker while continuing to move).

## Turn flow, pause and replay

The battle **starts paused**. Give orders, then take a turn:

- `space` — **Turn**: pieces move **one at a time**, each making at most one
  move, then the turn auto-pauses. Move cooldowns are cleared at the start, and
  every turn runs a minimum beat (~1s of sim time) so reloads and in-range fire
  still progress even when nobody moves. A turn also ends early if no move has
  started for a while (blocked pieces don't stall it). `space` is ignored while a
  turn is already running, so it always starts the next turn rather than
  cancelling the current one.
- `p` — pause / resume. Pausing mid-turn cancels the turn.
- `s` — single simulation step (one tick), for tracing.
- `r` — **Replay last turn**: the world + RNG + tick are snapshotted at turn
  start (after the turn's setup mutations), so replay deterministically re-plays
  the recorded ticks and returns to exactly the same end state. Because turns are
  serialized, replay shows the moves one piece at a time at ~0.5× speed.

A "move" is one application of the piece's movement geometry, so a pawn advances
one square while a rook may slide several cells along a rank/file — one move.

**AI move budget.** An AI team facing a human may never out-move them: its
cumulative moves are capped by the human's, and unused budget carries over. Order
one pawn and the AI may move one piece; order two and it may move two (possibly
across turns). It may skip moves but never exceed yours. AI-vs-AI is unrestricted.

## Game modes

`human-vs-ai` (default), `ai-vs-ai`, `human-vs-human`, chosen in the toolbar.
The player's team (default blue) is shown in the `You: Blue · Red ai` badge.
Human pieces default to **Hold** and only act on your orders; AI teams
rally/engage on their own. Both still fire autonomously.

## Overlays: seeing what is going on

Scope: the **selection** always shows full detail; `my orders` (`o`) and
`enemy plans` (`e`) extend a summary to each army.

- **Move cells** — blue filled squares (legal one-square moves).
- **Attack cells** — red outlined squares (what the weapon can hit now; outlined
  so it stays visible where it overlaps blue).
- **Range arc** — nominal reach for the selected piece: bands for rook/bishop,
  circle for queen/king, forward half-disc for pawn, 8 dots for knight. **Off by
  default** (enable with the `range` toggle) so targeting circles don't clutter
  the board.
- **Health + reload bars**: every piece shows a thin health bar and a **plain
  red** weapon reload bar (tile-relative, so it stays inside the square), making
  it clear how hurt a piece is and whether it can fire. All pieces render at a
  uniform size. Projectiles are small and distinct per piece (dot / shell /
  lance / tumbling bomb) and travel and rotate in flight.
- A wide **turn bar** under the toolbar fills as a turn (gold) or replay
  (violet) progresses and reads READY when the next turn can be taken.
- Pawns fire the **two forward diagonals** (chess capture). A piece directly
  ahead blocks a pawn, exactly as in chess, and is not a target.
- **Path** — dashed gold route; **destination** crosshair (red if blocked);
  **target** line + reticle.

Army scope shows paths/goals/targets; reach, attack and range are reserved for
selected pieces to keep the board readable.

Mouse: **drag** to box-select (any cell the box touches; shift-click adds),
**shift-drag** or middle-drag to pan, **wheel** to zoom, **right-click** to
order (goto on an empty square, attack on an enemy while in Fight stance). Hover shows a per-piece order preview (faint
ghosts) and the square name. The board is labelled with chess coordinates, and
the control hints + stance legend live in always-visible side rails (even with
the HUD hidden). A **Copy position JSON** button captures the full situation.

Keyboard summary: `1/2/3` stance, `space` turn, `p` pause, `s` step, `r` replay,
`b` rewind (undo last turn), `c`/`4` clear orders, `o` my orders, `e` enemy
plans, `h` HUD, `Esc` clear selection. Turns and replays both play at 0.5× speed
(one move at a time), and the wide **turn bar** under the toolbar sweeps the full
width (same colour for both).

## Roadmap

- [x] **Phase 0 — Scaffold & port.** Vite/Vue/TS project, ECS core, timed
      pipeline, camera, terrain, snapshot UI, 8–64 boards, hideable HUD.
- [x] **Phase 1 — Occupancy, movement, intents.** One piece per square,
      geometry-driven A*, move cooldowns, Move/Fight/Hold, immediate order paths.
- [x] **Phase 2 — Firing geometry & LOS.** Chess weapon patterns, blockers,
      weapon cooldowns, auto-engage while moving.
- [x] **Phase 3 — Projectiles & spectacle.** Data-driven trajectories
      (line/jump/homing/beam), splash, FX, trails.
- [ ] **Phase 4 — Production & reinforcement.** Production queue + build timers,
      supply, entry lanes (currently instant lane deploy).
- [ ] **Phase 5 — Piece/weapon data system.** Authoring custom pieces and
      geometries.
- [ ] **Phase 6 — Rules bank & presets.** `Rules` object in context, toggles,
      King Aura first.
- [x] **Phase 6.5 — Turn pacing & replay.** `space` turn advance (settles on
      squares), `p` pause, `s` step, `r` deterministic replay.
- [x] **Phase 6.6 — Movement correctness & clarity.** Reservation-based
      occupancy (one piece per square, only knights leap), turn settling, team
      controllers/game modes, and the overlay scope/legend overhaul.
- [ ] **Phase 7 — AI controllers & observer.** Intent-based AI, human-vs-AI,
      AI-vs-AI, camera follow, auto-pause triggers.
- [ ] **Phase 8 — Strategy overlays.** LOS, threat/influence, projected movement,
      projected projectile paths.
- [ ] **Phase 9 — Map maker.** Obstacles, entry lanes, formation placement,
      import/export.
- [ ] **Phase 10 — Replay (stretch).** Record seed + ordered commands; re-sim.

## Rule bank (planned)

Rules are named, serializable flags/numbers read by systems. Examples:
`kingAura { hpMult, rangeBonus, radius }`, `pawnShield`, `fireWhileMoving`,
`knightFlanking`, `rookCover`, alternate `cooldownModel`. Presets such as
_Classic_, _Experimental_, _Siege_, _Chaos_ bundle rule combinations and persist
to `localStorage`.

## Known rough edges

- A piece ordered to a cell its geometry can never reach (e.g. a bishop to the
  opposite square colour) now walks its best partial route and shows a red
  destination crosshair.
- Reinforcement is an instant lane deploy; the production queue is Phase 4.
- Overlay rendering recomputes geometry every frame; fine at current unit counts
  but worth caching if piece counts grow.

## Conventions (see also ARCHITECTURE.md)

- TypeScript strict with `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `noUnusedLocals`, `noUnusedParameters`. No `enum`/`namespace`/constructor
  parameter properties. Type-only imports must use `import type`.
- Only runtime dependency is Vue. `npm run build` (`vue-tsc -b && vite build`)
  is the only gate; no test suite, no linter.
- No comments unless asked.
- Determinism: all randomness through `Rng` (seeded `mulberry32`); never
  `Math.random()` in `src/ecs` or `src/game`.
