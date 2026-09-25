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

**Stance** is a piece's persistent autonomous policy, shown as a badge and set
from the **piece panel** (right rail), which applies to the whole selection:

- **None** (default, no badge) — stand ground and fire only at enemies already in
  range, so the opening board stays clean.
- **Move** (`M`, green) — travel and return fire only; never starts an attack.
- **Attack** (`A`, red) — seek and attack nearby targets. Prefers an enemy it can
  actually shoot right now, then whoever is shooting it, then damaged ones.
  Below 30% HP it keeps firing: it holds when already safe, otherwise steps to the
  nearest square that still hits the target but escapes the fire geometry of the
  target and its last attacker; it only runs when the target is out of range.
  Does not chase across the board.

Orders **never** change a piece's stance. Issuing an attack leaves the stance as
it was; when the target dies the order simply completes. Set the stance to
Attack to have a piece keep engaging on its own, or None to disengage.

**Order** is a one-shot (or queued) instruction:

- **Right-click an empty square** → *goto*: move toward it. This is an
  **objective**, not a strict destination: each selected piece advances as far
  as its own geometry allows, so a pawn ordered to an off-file square still
  marches forward up its own file.
- **Right-click an enemy piece** → *attack*: become glued to that enemy, follow
  it, and fire when possible. Shown as a **red** tracking chain + a **red ring**
  around the targeted enemy. Once the target is destroyed the order is removed.
  Right-clicking a friendly square is a no-op (as in BAR).
- **`m` / `a` then left-click** → force a *move* / *attack* command (BAR-style
  prefixes). `a` + click on an empty or friendly square is a no-op. The prefix is
  consumed by the click; hold **Shift** to keep it armed and queue several. A
  plain left-click selects and clears any armed prefix.
- **Right-click again** (or Shift+right-click) → *append* a step to
  the piece's **order queue**. The first right-click on a piece with nothing
  planned creates the active order; further clicks queue `goto`/`attack` steps in
  sequence, so `move, move, attack` is one plan (a duplicate of the active or last
  queued step is ignored). Each step runs to completion (one move per turn) before
  the next promotes; a merely blocked waypoint waits like a single order, while
  one the piece's geometry can never reach is skipped. The queued remainder is
  drawn as a dim dashed chain with numbered waypoint markers (a queued attack
  shows a dim threat line). `c` or `Backspace` clears the active order **and** the
  queue (and drops the current target); it does not change the stance.
- **Pulling back mid-attack**: a move issued on a piece with an active attack
  order *suspends* the attack instead of discarding it — the parked enemy is shown
  with an amber dashed chain/ring. The piece travels to the objective, then
  **regroups for two turns**: it holds position, or kites one step back while under
  fire (raising distance while keeping the enemy in range), and only re-engages
  once the window has elapsed *and* it is no longer under fire. A new order or `c`
  cancels the suspension.
- The attack's route is always shown and **theoretical**: it assumes other pieces
  will move, so only walls and the target's own square are avoided and the route
  stays visible even when the piece is boxed in. It ends on a real square — a
  firing cell when one exists, otherwise the closest empty cell reachable if the
  board were clear. The route uses the gold **route** style so it reads apart
  from the firing line.
  From the end of that route a **firing line** runs to the victim, judged against
  the **current** board: **solid red** when the shot is clear; when it is
  positionally reachable but blocked, **solid red up to the blocker and dashed
  red beyond it**; and **dashed grey** when the target is positionally out of
  reach (e.g. a bishop on the other colour). A lock reticle sits on the victim,
  and the legend groups these under **firing lines**.
- A **goto** order also shows a best-effort route rather than a bare straight
  line, falling back to a friendly-passable plan when the piece is boxed in, and
  always draws a connector from the end of that route to the objective so a
  partial route never dead-ends in mid-air.
- An attack order never changes the piece's stance. When the target dies the
  order clears and the piece reverts to its explicit stance (None = stand & fire
  in range), so it only keeps engaging on its own if the player set Attack.
- Only pieces whose team is under human control can be commanded: your own team
  in Human-vs-AI, **both** teams in Human-vs-Human, nobody in AI-vs-AI. Enemy
  pieces remain selectable for inspection.
- Tracking rings/chains follow the overlay scope: visible for the selection and,
  when on, `my orders` (`o`) / `enemy plans` (`e`) — never floating permanently.

**Team colour is Orange vs Blue** so that **red is reserved for attack
indicators** (tracking chain, targeted ring, Attack stance). Pieces have no
default ring — a red ring means "this piece is under an attack order".

Auto-targeting follows from this: attack order = sticky target; Attack = scored
auto-acquire (a shootable enemy first, then one firing on the piece, then damaged
and nearer ones); no stance = in-range only; Move = retaliation only (returns fire
at its attacker while continuing to move).

## Turn flow, pause and replay

The battle **starts paused**. Give orders, then take a turn:

- `space` — **Turn**: pieces move **one at a time**, each making at most one
  move, then the turn auto-pauses. Move cooldowns are cleared at the start, and
  every turn runs a minimum beat (~1s of sim time) so reloads and in-range fire
  still progress even when nobody moves. A turn also ends early if no move has
  started for a while (blocked pieces don't stall it). While a turn is already
  running, `space` queues the next turn; while **playing** it pauses (see below).
- `shift+space` (or the **Play** button) — **Play**: run continuously, in real
  time, until paused. The played interval is recorded as one **mega turn** — a
  history beat with its exact start and tick count — so a game can mix regular
  turns and mega turns freely and still undo/redo/replay/save as a whole. Issuing
  an order or toggling a rule while playing splits the mega turn so the change is
  part of a replayable start.
- `p` — pause / resume (`togglePause`); also starts play when idle. Pausing
  mid-turn cancels the turn; pausing while playing closes the mega turn.
- `s` — single simulation step (one tick), for tracing.
- `u` / `r` — **Undo / Redo** completed beats (turns or mega turns), stepping
  through a bounded history of boundary states. Taking a new beat after undoing
  replaces the redo branch.
- `y` — **Replay**: re-plays the beat that produced the state you are viewing —
  at any point in the history, not just the latest. It restores that beat's exact
  start snapshot (so orders and stances issued while paused are included),
  re-applies any commands that were pending, re-runs the recorded ticks and
  returns to exactly the same end state, leaving the cursor and redo branch
  untouched. The selection is kept. Every kind of playback — live turns, free
  play and all replays — runs at the selected speed.
- **Save / load**: slots and **Export JSON** store the whole game including the
  undo/redo history, so loading a slot lets you keep undoing, redoing and
  replaying. Saving closes an in-flight mega turn first. If the browser storage
  is full, the slot falls back to a position-only save (undo history is not kept).

## Seeds, self-play & game records

Every battle has an origin **seed** (`Game` ctor / `loadSize` / `reset`). With the
seed and the ordered player inputs the whole game is deterministic, so a game can
be recorded as a header + cell-based intents instead of a stack of position
snapshots. `Game.onCommand` reports each player command (order, stance, clear,
deploy, mode); `Recorder` (`src/game/record.ts`) collects them per turn and
`replayRecord` reproduces the game exactly.

The HUD's **Study** tab runs a batch of games, on the live board in **Watch**
speed or without waiting in **Fast** speed. Pick a count, mode (AI vs AI, or a
random human against the AI), board, seed base, max turns, the scripted human's
pace (pieces per turn and attack chance) and the rule toggles, then
**Run N games**. The scripted human gives short move orders to a few random
pieces each turn and only attacks enemies it can genuinely engage, so it never
issues a positionally impossible attack; hurt pieces that are retreating to heal
are left alone. `Stop game` keeps the current (game's) partial recording and
moves on; `Cancel all` discards everything. As it runs, `StudyController`
(`src/game/study.ts`) records each game and samples a per-turn piece trace, then
`transcript.ts` / `analysis.ts` produce a compact per-game transcript (including
a board per turn) and flag gameplay gaps (pieces that held under fire, never
moved, oscillation, focus fire, no-progress turns). Each transcript names the
human policy, so a reader can tell a policy artifact from a rule problem.
**Copy analysis prompt** reuses the shared `LLM_GAME_RULES` preamble and the same
per-game body as the live "copy history for LLM" bundle, then prepends a batch
summary, a generated piece/weapon stat table and each game's flagged analysis; a
**replay record** toggle optionally appends the full record JSON, and a size
estimate warns before the prompt grows too large for an LLM session.

## Victory

The game ends when a **king** dies. The defeating team's colour wins, a `win`
event is logged, and play freezes: turn/pause/step are disabled. Press
`u` (**Undo**) to step back before the fatal turn and keep playing (or `r` to
redo it); `y` (**Replay**) still works and re-runs the fatal turn from its
recorded start. A team that starts without a king has lost; if both kings fall
at once it is a draw.

A "move" is one application of the piece's movement geometry: a rook may slide
several cells along a rank/file, and a pawn advances one square — or two from its
home rank (rank 2 / rank 7), its chess first move — in a single move. The
two-square step is blocked if the first square is occupied.

**AI move budget.** An AI team facing a human may not out-move them within a
turn: it may make at most as many moves that turn as the human makes, and always
at least one, so a passive player cannot freeze the AI. Order two pieces and the
AI may move two in the same turn; do nothing and it still gets one move. Nothing
carries over between turns, so a blocked AI never bursts later. AI-vs-AI is
unrestricted.

## Game modes

`human-vs-ai` (default), `ai-vs-ai`, `human-vs-human`, chosen in the toolbar.
The player's team (default blue) is shown in the `You: Blue · Red ai` badge.
Human pieces start with **no stance** (no badge) and only act on your orders; AI
teams rally/engage on their own, except the **AI king**, which guards its back
rank instead of advancing. Under fire it steps out of an attacker's firing line
(reacting to any shooter in line of sight, anyone who recently hit it, and nearby
enemies), ranking threats by danger. Nearby AI pieces within a few squares become
**bodyguards**: they step into the line of fire to block the shot when they can
and stay planted while they are blocking it, otherwise they move to intercept the
attacker, while the rest of the army keeps attacking. Both sides still fire
autonomously.

**Self-preservation** runs for every piece, human or AI: once it is hurt and
still under fire it steps off the firing line on its own — even with an
explicit **standing attack order**, which it interrupts and resumes after
healing. A hurt piece outside its king's healing aura walks home to the nearest
aura square rather than taking one local cover step and resuming (that one-step
cycle made it yo-yo between cover and the same fire); it then holds in the aura
until it has recovered to about one hit above its retreat threshold
(`recoverThreshold`: queen/king 70%, rook 65%, bishop/knight 60%), so it does
not walk back out the instant it crosses the trigger. Only a volley that would
kill it this tick forces a local dodge first, and a critically wounded piece
safe-holds until fully healed. It judges the escape
against **every** shooter covering it (not just the last one), and a damaged
piece already inside the aura holds there, firing when it can, rather than
chasing. Valuable pieces
(queen/rook/bishop/knight) watch for crossfire every moment and back off before
they are hit once they are outgunned or focused
by two or more attackers; cheaper pieces only react once they are hurt. Costlier
pieces bail earlier (queen/king at 50% health, rook 45%, bishop/knight 40%). Pawns
never retreat: they can only step forward, so a "flee" would walk them into the
enemy and drop the shot, so they hold and fire instead. A persisted
**auto-preserve** checkbox in the toolbar turns the behaviour off.

**Insta-kill.** The one thing that outranks self-preservation is an **immediate
chess kill** (`chess kills` rule on, human-only, victim already in the ordered
piece's capture pattern). It is parked at order-issue time and lands on the next
tick as direct lethal damage, so a badly wounded piece still presses — a suicide
kill is allowed. Only an order that starts/replaces the active order can park
one (a queued attack step never does). A standing attack order is the opposite:
chasing over several moves and yielding to safety. See `src/game/instaKill.ts`.

**Attack leash.** Autonomous Attack only acquires targets within `ATTACK_LEASH`
(8 squares) instead of a slider's board-wide vision, so pieces fight locally
rather than wandering across the map to an out-of-range enemy. An attack order on
a **positionally impossible** target (e.g. a bishop ordered onto the opposite
colour square) is still approached best-effort: the route ends on the closest
reachable square and the overlay draws it followed by the dashed "unreachable"
firing line, both recomputed each move. Self-preservation runs first, so a hurt
piece breaks off to heal and resumes the approach once recovered; a piece already
standing on a closest square parks there rather than hopping between equidistant
cells. Only automatically acquired targets are
leashed — an explicit order is followed.

**Capture advance.** A persisted **capture advance** checkbox in the toolbar
(default on) makes a piece that lands a kill step onto the victim's square, like
a chess capture. It only applies to an **idle** killer (no active order, queue,
path or hop; the attack order that just killed this victim does not count), steps
along the firing ray it killed with (re-checked for a clear line), and is a free
move — it does not spend the piece's turn move or the AI move budget. This rewards kills with territorial pressure instead of everyone standing
still and sniping. For a pawn this is its chess capture: it marches straight but
steps diagonally onto a piece it shot down.

**Promotion.** A persisted **promotion** checkbox (default on) turns a pawn that
reaches the enemy back rank into a queen: it keeps its current HP, gains the
queen's maximum and weapon, and its orders are cleared so it replans as a queen.
This gives a won pawn endgame a way to convert instead of standing on the last
rank forever.

**Endgame targeting.** An AI piece with no target advances on the **enemy king's
current square** rather than a fixed map midpoint, so the army converges on the
win condition once the field clears. Range-1 weapons acquire by Chebyshev
distance, so a pawn or king notices the diagonal squares its weapon actually
covers. Once the enemy is down to its king alone, the attacker skips
self-preservation and bodyguard duty to press the finish, and a lone king stops
kiting and holds its post (it is faster than every attacker, so dodging forever
used to turn material wins into turn-cap draws).

**Finishing safely.** Pursuit avoids the 3×3 around an enemy king, where the
king's guard hits for 80% of max HP: `attackPlan`/`previewFiringCell` prefer a
firing cell outside that ring and fall back to an adjacent one only when no safe
line exists. A hurt piece that is outside its king's aura now walks home to heal
even when nothing is currently shooting it, and a low-HP piece with no actual
threats keeps fighting rather than parking in place — the two paths that used to
strand surviving rooks and queens.

**Draws.** A stopped study game with no living non-king piece on either side is
recorded as a draw rather than a timeout. Kings can still be marched in by a
player, so this is a study label, not an automatic game end.

## Overlays: seeing what is going on

Scope: the **selection** always shows full detail; `my orders` (`o`) and
`enemy plans` (`e`) extend a summary to each army.

- **Move cells** — blue filled squares (legal one-square moves).
- **Attack cells** — red outlined squares (what the weapon can hit now; outlined
  so it stays visible where it overlaps blue).
- **Range arc** — nominal weapon reach for the selected piece: directional bands
  along each firing line (rook/bishop/queen/king), forward half-disc for pawn,
  8 dots for knight. **Off by default** (enable with the `range` toggle) so
  targeting circles don't clutter the board.
- **Health + recharge bars** (BAR-style): a damaged piece shows a thin health
  bar that fills left-to-right with remaining HP and interpolates
  **green→red (solid red at ≤40%)**; a long-cooldown weapon that has fired shows a **teal**
  recharge bar filling left-to-right. Both vanish when effectively full (so an
  undamaged piece, a ready weapon, and the whole opening position show nothing),
  stack top-down, and are tile-relative so they stay inside the square. Both are
  toggleable (`health`, and `firing recharge` for the recharge bar) and the
  choices persist.
  All pieces render at a uniform size. Projectiles are small and distinct per piece (dot / shell /
  lance / tumbling bomb) and travel and rotate in flight.
- A wide **turn bar** under the toolbar fills as a turn (gold) or replay
  (violet) progresses. It tracks real remaining move work (not a time guess),
  sweeps smoothly, reaches and **holds 100%** on completion, and reads READY
  when the next turn can be taken.
- Pawns fire the **two forward diagonals** (chess capture). A piece directly
  ahead blocks a pawn, exactly as in chess, and is not a target.
- **Path** — dashed gold route; **destination** a hollow diamond (orange and
  dashed if blocked), so it never reads as a target reticle.
- **Target** — an ordered attack draws a red firing line + reticle and rings the
  victim red; an auto-acquired or retaliation target (Attack stance / return
  fire) draws the same indicator in **amber**, so you can see what a piece is
  engaging on its own.

Army scope shows paths/goals/targets; reach, attack and range are reserved for
selected pieces to keep the board readable.

Mouse: **left-click** to select (shift-click adds), **drag** to box-select,
**shift-drag** or middle-drag to pan, **wheel** to zoom, **right-click** to
order (goto on an empty square, attack on an enemy; repeat or Shift to queue).
**`m`/`a` then left-click** forces a move/attack command (Shift keeps the prefix
armed to queue more). Hover shows a per-piece order preview (faint ghosts) and
the square name. The board is labelled with chess coordinates; the control hints
and legends live in the right rail's **info** tab, and the **piece panel**
(properties + stance buttons) in its **piece** tab (both always visible, even
with the HUD hidden). A **Copy position JSON** button in the left rail's
games tab captures the full situation.

Keyboard summary: `m`/`a` arm move/attack, `space` turn / pause play,
`shift+space` play, `p` play/pause, `s` step, `u`/`r` undo/redo, `y` replay,
`c`/`Backspace` clear orders, `o` my orders, `e` enemy plans, `h` HUD, `Esc`
cancel/clear selection. Every kind of playback — live turns, free play and
replays — follows the 0.5×/1×/2×/4× speed setting. The wide
**turn bar** under the toolbar sweeps the full width to 100% and holds it (same
colour for both), pulsing while playing.

## Roadmap

- [x] **Phase 0 — Scaffold & port.** Vite/Vue/TS project, ECS core, timed
      pipeline, camera, terrain, snapshot UI, 8–64 boards, hideable HUD.
- [x] **Phase 1 — Occupancy, movement, intents.** One piece per square,
      geometry-driven A*, move cooldowns, Move/Attack, immediate order paths.
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
- [x] **Phase 6.7 — Combat audio.** Procedural WebAudio SFX (per-weapon fire,
      target-scaled hits, blasts, miss fizzles) driven by the event bus, with a
      persisted, off-by-default toolbar toggle and a **Sound** config tab that
      catalogs every cue (fire / hit-from-each-attacker / death / miss) with a
      play button plus each piece's combat stats.
- [x] **Phase 6.8 — Synth editor & resizable HUD.** Voices are data
      (`VoiceSpec` in `src/audio/voices.ts`, overridable via `VOICE_OVERRIDES`);
      the Sound tab opens a per-cue synth editor (waveform picker, oscillator/
      envelope/filter knobs, live JSON, Play/Copy) so sounds can be tweaked and
      the JSON pasted back into code. The HUD bottom panel gained a draggable
      splitter (persisted as `bottomFraction`).
- [x] **Phase 6.9 — Live sound overrides.** Editor edits accumulate in
      `localStorage` (`src/audio/overrides.ts`), apply to the game immediately,
      and reload into the editor (with a badge + panel markers). The editor adds
      per-layer `×`, a **loop** preview, and **Copy entry / Copy all** that emit
      valid `VOICE_OVERRIDES` TypeScript for a one-shot commit.
- [ ] **Phase 7 — AI controllers & observer.** Intent-based AI, human-vs-AI,
      AI-vs-AI, camera follow, auto-pause triggers.
- [ ] **Phase 8 — Strategy overlays.** LOS, threat/influence, projected movement,
      projected projectile paths.
- [ ] **Phase 9 — Map maker.** Obstacles, entry lanes, formation placement,
      import/export.
  - [x] **Phase 9a — Piece placement & templates.** Map editor overlay (`Editor`
        toggle) with click/drag piece brushes and an eraser on the main board,
        sandbox mid-game drops from the rosters, `SavedMap` templates in
        IndexedDB with a thumbnail browser (`New from template…`), and
        template-exact replay via a `GameRecord` baseline.
  - [ ] **Phase 9b — Terrain & spawn editing.** Paint the five terrain types and
        edit spawn rectangles / entry lanes; currently maps carry terrain
        read-only.
- [ ] **Phase 10 — Replay (stretch).** Record seed + ordered commands; re-sim.

## Rule bank (planned)

Rules are named, serializable flags/numbers read by systems. Examples:
`kingAura { hpMult, rangeBonus, radius }`, `pawnShield`, `fireWhileMoving`,
`knightFlanking`, `rookCover`, alternate `cooldownModel`. Presets such as
_Classic_, _Experimental_, _Siege_, _Chaos_ bundle rule combinations and persist
to `localStorage`.

## Known rough edges

- **AI king pre-emptive evasion (deferred):** the king reacts to shooters that
  cover it now, its recent attacker, and nearby enemies. It does not yet avoid an
  enemy that is one move away from a firing position — a cheap approximation
  would intersect the enemy's `attackApproachCells` with its one-step
  `moveDestinations`, capped by a scan radius to bound the per-tick cost.
- A piece ordered to a cell its geometry can never reach (e.g. a bishop to the
  opposite square colour) now walks its best partial route and shows a dashed
  orange destination diamond.
- Reinforcement is an instant lane deploy; the production queue is Phase 4.
- Overlay rendering recomputes geometry every frame; fine at current unit counts
  but worth caching if piece counts grow.

## Conventions (see also ARCHITECTURE.md)

- TypeScript strict with `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `noUnusedLocals`, `noUnusedParameters`. No `enum`/`namespace`/constructor
  parameter properties. Type-only imports must use `import type`.
- Only runtime dependency is Vue. Gates: `npm run build` (`vue-tsc -b && vite build`),
  `npm run test:run` (Vitest unit/render), and `npm run test:e2e` (Playwright). No linter.
- Testing: pure logic lives in headless modules and is unit-tested directly
  (`tests/unit`). Overlay visuals are pure data — `src/render/overlays.ts`
  (`firingLine`, `routePolyline`) returns styled segments the renderer just
  strokes — so routing/firing-line drawing is tested by asserting coordinates and
  line styles (`tests/render`), plus a mock 2D context for the renderer's stroke
  order. `Game.runTicks(n)` drives turns/replay deterministically without the rAF
  loop. Playwright (`tests/e2e`) covers real canvas interaction and a pixel probe
  of the rendered firing line. Component stores are module-level singletons, so
  tests that build multiple worlds must `clearComponents()` between cases.
- No comments unless asked.
- Determinism: all randomness through `Rng` (seeded `mulberry32`); never
  `Math.random()` in `src/ecs` or `src/game`.
