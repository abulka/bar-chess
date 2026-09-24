# Architecture

Bar Chess is a top-down, real-time chess-derived battle simulation. The
simulation is a hand-rolled Entity-Component-System on a fixed timestep,
decoupled from the Canvas renderer and the Vue UI. The only runtime dependency
is Vue.

See `PLAN.md` for the design intent and roadmap.

---

## 1. Runtime data flow

```
                    ┌────────────────────────────────────────────┐
                    │ App.vue                                    │
                    │  owns Game, polls game.snapshot() every    │
                    │  120ms into a shallowRef                   │
                    └───────────────┬────────────────────────────┘
                                    │ snapshot (plain object)
              ┌─────────────────────┼──────────────────────────┐
              ▼                     ▼                          ▼
        Toolbar.vue         ReinforcementBar.vue          EventLog.vue
        StatsBar.vue        PiecePanel.vue               BoardView.vue ──renders──▶ canvas
                                    │
              user input (pan / zoom / select / order)
                                    ▼
                    ┌────────────────────────────────────────────┐
                    │ Game (src/game/game.ts)                    │
                    │  World + EventBus + Pipeline + Board + Rng │
                    │  command queues + occupancy map            │
                    │  rAF loop ──▶ step() ──▶ Pipeline.run(ctx) │
                    └────────────────────────────────────────────┘
                                    │ onFrame(alpha)
                                    ▼
                    ┌────────────────────────────────────────────┐
                    │ Renderer (src/render/renderer.ts)          │
                    │  draws Board + overlays + pieces + shots   │
                    └────────────────────────────────────────────┘
```

Two rules keep this clean:

1. **The UI never touches ECS internals.** It reads `GameSnapshot` and calls
   `Game` methods.
2. **The renderer only reads.** It never mutates the world.

The only other observer is audio: `App.vue` subscribes to the `EventBus` and
forwards `shot`/`hit`/`explosion`/`miss` to the `AudioEngine`, which synthesizes
combat sounds (§11). Audio never reads or mutates the world.

---

## 2. ECS core

### `World` — `src/ecs/world.ts`

An entity is an integer id. Components live in per-type `Map<Entity, T>` stores
created by `defineComponent<T>(name)`. There is no archetype storage; clarity
wins at this scale.

```ts
const Position = defineComponent<PositionData>('Position')
const e = world.create()
world.add(e, Position, { x, y })
world.require(e, Position)   // throws if absent
world.get(e, Position)       // T | undefined
world.query(Position, Health)
world.destroy(e)             // removes from every store
```

`Game.allStores` / `World.allStores` powers the Inspector.

### `EventBus` — `src/ecs/events.ts`

Ring-buffered (`max = 6000`) observability log. Every meaningful transition is
emitted (`spawn`, `target`, `shot`, `hit`, `miss`, `damage`, `kill`, `explosion`,
`map`, `boot`, `info`, `warn`, `phase`). Events never drive simulation logic —
they exist for the log, for auto-pause triggers, and for debugging.
`bus.subscribe(fn)` gives read-only observers (the audio engine) a low-latency
per-event hook; each listener is called in a `try/catch` so a throwing observer
can never interrupt the sim.

### `Pipeline` — `src/ecs/pipeline.ts`

Runs systems in array order, timing each with `performance.now()` and keeping an
EMA. With `verbose` on it emits a `phase` event per system per tick.

---

## 3. Components — `src/ecs/components.ts`

| Store | Data | Notes |
| ----- | ---- | ----- |
| `Position` | `{ x, y }` | pixels; interpolated for rendering |
| `Cell` | `{ x, y }` | authoritative logical cell (occupancy) |
| `Team` | `'red' \| 'blue'` | |
| `PieceType` | `{ kind }` | keys into `PIECES` |
| `Render` | `{ glyph, tint, size }` | unicode glyph + team tint |
| `Health` | `{ cur, max }` | |
| `Stance` | `{ mode }` | persistent policy: `none` / `move` / `attack` (`none` stands ground and fires in range, with no badge) |
| `Order` | `{ kind, dest, target, targetCell, chessKill, reachable, resumeTarget, resumeTurn, queue, log }` | active step is one-shot `none` / `goto` / `attack`; `targetCell` is the target's last known cell (order-log notes); `chessKill` is a victim selected by the order-time chess-kill rule, consumed on the next tick (kept on the order so it is part of the turn snapshot); `reachable` marks an attack target that is positionally attainable; `queue` holds queued `OrderStep`s (`goto`/`attack` with a pre-planned display path) that promote into the active step in sequence (`resumeTarget`/`resumeTurn` are retained for save compatibility but unused — a move now replaces an attack); `log` is a bounded list of recent order transitions (`noteOrder`) so the panel can explain why an order was issued, replaced, completed or abandoned |
| `Target` | `{ entity, retargetAt, lastAttacker, underFireUntil }` | current engagement + retaliation bookkeeping. `underFireUntil` is a raw ~3 s latch (the AI keeps treating the recent attacker as a threat); **reporting** goes through `underFireAttacker` (`src/game/underFire.ts`), which also requires the attacker to still cover the square |
| `Weapon` | `{ left }` | seconds until next shot |
| `Motion` | `{ goal, intent, holdUntilHp, reserved, path, from/to, travel, elapsed, moving, cooldown, arrived, replanAt, blocked, steps, movedThisTurn, ease?, freeAdvance? }` | grid movement + render interpolation; `intent` is the goal's source (`order`/`preserve`/`defense`/`engage`/`rally`); `holdUntilHp` is a latched safe-hold until that HP; `reserved` is the cell being entered; `ease`/`freeAdvance` mark a capture-advance glide (eased, no post-arrival cooldown) |
| `Projectile` | `{ team, damage, ttl, trajectory, splash, radius, size, shape, spin, color, target, owner, waypoints, waypointIndex }` | |
| `Fx` | `{ ttl, maxTtl, radius, color, capture? }` | render-only impact/explosion; `capture` selects the small red triple pulse used for chess kills |
| `Dead` | `true` | marker processed by the death system |
| `ChessKill` | `true` | kill delivered by the chess-kill rule; selects the red-pulse FX |

Pieces carry `Cell`; projectiles and FX do not, so occupancy only ever contains
pieces.

---

## 4. Fixed-timestep loop — `src/game/game.ts`

```
requestAnimationFrame(frame):
  delta = now - last
  fps/tps counters (1s window)
  if (!paused):
    accumulator += delta * speed
    while accumulator >= FIXED_DT and steps < MAX_STEPS_PER_FRAME:
      step(); accumulator -= FIXED_DT; steps++
  onFrame(alpha)   // renderer draws current state
```

- `FIXED_DT = 1/30`, `MAX_STEPS_PER_FRAME = 6` (`src/game/constants.ts`).
- `speed` (0.5–4×) scales the accumulator only, so the sim stays deterministic.
- `stepOnce()` runs exactly one tick (used by the Step button while paused).

### Turn model & replay

`Game` also exposes a coarse "turn" layer on top of the tick loop:

- The game starts **paused**. `beginTurn()` snapshots the world, RNG, tick,
  teams and winner, clears every piece's move cooldown, sets `movedThisTurn` for
  any piece already animating, then unpauses. Each piece may make **one move**
  (the movement system skips a piece once `movedThisTurn` is set).
- `advanceTurn()` ends the turn when no piece is *pending* — not mid-move, not
  already moved, and either has no goal or no route — and at least
  `MIN_TURN_TICKS = 30` ticks (~1s) have elapsed, so reloads and fire advance
  even when nobody moves. A stall guard also ends the turn if no move has started
  for 45 ticks (blocked pieces can otherwise keep reporting a route forever).
  `TURN_MAX_TICKS = 240` is the final ceiling, after which `snapMoves()` lands
  stragglers. `finishTurn()` pauses and stores the snapshot + tick count, then
  appends the resulting state to a bounded undo/redo history.
- Rapid `space` presses are buffered rather than dropped: `Game.queueTurn()`
  starts a turn when idle, else increments `queuedTurns` (capped at
  `MAX_QUEUED_TURNS = 3`). `finishTurn()` — and the end of a replay — starts the
  next queued turn immediately, so two presses play two turns back-to-back.
  Cancelling (`p`), stepping (`s`), undo/redo/replay, and load/import clear the
  buffer. The turnbar shows the pending count (`TURN · +2 queued`), and the
  toolbar's **Turn badge** keeps the current turn number visible even after the
  bar fades (mirrored in the stats bar).
- `undoTurn()` (key `u`) and `redoTurn()` (key `r`) step backwards/forwards
  through that history, restoring whole turn-boundary states; beginning a new
  turn replaces any undone branch. Each history entry is a `HistoryEntry`: the
  end-of-turn boundary `state` (used by undo/redo), the exact turn-start
  snapshot `start` (used by replay), the producing turn's `ticks`, commands
  pending at its start (`pending`), and `continuous` (true for a mega turn).
- `state` and `start` are deliberately both kept. They are different points in
  time: orders/stances issued while paused mutate the live world but create no
  boundary, so `start` has them and `state` does not; and `beginTurn` clears
  every cooldown and sets `movedThisTurn`, overwriting values that only `state`
  retains. Neither can be derived from the other.
- **Mega turns** unify continuous Play with the turn history. `beginMegaTurn()`
  (shift+space, or the Play button via `togglePause()`) increments `turn`,
  captures a start snapshot, then unpauses real-time play (`ctx.turnActive`
  stays false, so movement is cooldown-driven and parallel). `endMegaTurn()`
  (space/Play again, a king death, or an undo/replay request) pushes a
  `continuous` entry with its exact start and tick count and emits the same
  `phase`/`turn end` boundary a normal turn does. While playing, a player
  command or rule toggle goes through `liveEdit()`, which closes the pre-command
  mega turn, applies the change, and opens a new mega turn from the mutated
  state — so the command lives in a replayable start snapshot. Because `turn`
  advances once per beat, `Recorder`, `GameLog`/transcripts and save slots treat
  mega turns exactly like turns.
- `replayTurn()` (key `y`) works at **any** cursor: it replays the turn that
  produced `history[cursor]` and returns to exactly that boundary, leaving the
  cursor and redo branch untouched, so a turn can be re-watched after undoing.
  It restores the recorded `start` snapshot (which already includes the paused
  orders/stances and the turn's rules) and re-applies the recorded `pending`
  commands so deferred work (e.g. a reinforcement deploy) is not lost. All
  playback — live turns, free play and replays — runs at the selected speed
  (`speed` scales the accumulator only, so the sim stays deterministic).
  `World.capture()/restore()` does a deep `structuredClone` of every component
  store; `Rng.getState()/setState()` restores the PRNG. `TurnState` also carries
  the sim-affecting rules in force (`autoPreserve`/`captureAdvance`/`chessKills`),
  restored on undo/redo/replay so a turn always re-runs under its original rules.
  During a normal replay `ctx.turnActive` is forced true so the one-move-per-turn
  gate matches the original turn; a `continuous` mega replay leaves it false so
  its parallel movement is reproduced.
  `Game.step()`
  sets `bus.replaying`, so replayed events are tagged and excluded from the HUD
  event stream and shot/kill counters (they are duplicates) while still reaching
  observers such as audio; the transcript log ignores them too. The selection is
  preserved across replay (pieces absent from the restored start are pruned).
- `togglePause()` starts a mega turn when idle (Play) and closes the running one
  on pause; it cancels an active turn, and aborts a replay back to its boundary.
  `stepOnce()` closes any turn/replay/mega turn first, then advances one tick.
- **Victory** is chess-style: a team is defeated the moment it has no living
  king (`updateWinner`). When a king falls during a live turn or mega turn the
  beat is closed (so the history boundary is the pre-fatal state and the fatal
  burst replays), a `win` event is emitted and the sim freezes:
  `beginTurn`/`stepOnce`/`togglePause` become no-ops and the toolbar disables
  turn/pause/step. `undo` stays enabled and restores the `winner` (part of
  `TurnState`) back to `null`, reopening play; `redo` jumps forward to it again.
  `replay` also stays enabled: it rewinds to the fatal beat's recorded start
  (pre-death) and re-runs it, so the winning beat can be watched without undoing
  first. If both kings fall on the same tick it is a draw and play continues.

### Team control & game modes

`TeamRuntime.controller` is `'human'` or `'ai'`, set from `gameMode`
(`human-vs-ai`, `ai-vs-ai`, `human-vs-human`) and `playerTeam`. The `orders`
system turns stance/orders into movement for **every** piece; for AI teams it
also auto-manages behaviour (rally/engage). Human pieces start with no stance
(`none`, no badge) and act solely on player orders, while still
firing autonomously via combat. A piece's stance is changed only from the piece
panel (`setPieceStance`), never implicitly by an order. A piece is commandable
only when its team's controller is `human`. The toolbar shows the mode drop-down
and a `You: Blue · Red ai` badge.

`SimContext` (`src/ecs/types.ts`) is the shared mutable context passed to every
system: `world`, `bus`, `board`, `rng`, `tick`, `turn`, `dt`, `cmds`, `teams`,
`occupancy`, `pathBudget`, `verbosePhases`, `turnActive`, `autoPreserve`,
`captureAdvance`.

System order (`createPipeline()` in `src/ecs/systems/index.ts`):

```
spawn → targeting → orders → pathfinding → movement → combat
      → projectile → damage → death → cleanup → advance
```

---

## 5. Board & geometry

### `Board` — `src/game/board.ts`

Wraps `MapData` with a `Uint8Array` of terrain ids and helpers. Terrain:

| id | name | passable | blocks vision | blocks projectile | cost |
| -- | ---- | -------- | ------------- | ----------------- | ---- |
| 0 | floor | ✓ | | | 1 |
| 1 | road | ✓ | | | 0.7 |
| 2 | sand | ✓ | | | 1.35 |
| 3 | water | | | | — |
| 4 | wall | | ✓ | ✓ | — |

`MapData` also carries `spawns` (per-team rectangles) and `lanes` (ordered entry
cells used by reinforcements). Boards are generated by `createBoardData(size)`
and populated by `initialArmy(size)` in `src/game/boards.ts`.

### Geometry — `src/game/geometry.ts` and `src/game/types.ts`

`Geometry` is `slide { dirs, range }`, `leap { offsets }` or `pawn { forward }`,
defined from blue's perspective (forward = −y); red negates `dy` in
`resolveGeometry`. A pawn's `forward` is its maximum advance: it may move two
squares only from its home rank (`pawnHomeRank` — rank 2 for blue, rank 7 for
red, matching `initialArmy`), otherwise one square, and the first blocker stops
the advance.

- `moveDestinations(board, from, geom, team, occupied, ignoreOccupancy)` — cells
  reachable in one move. Slides stop at terrain or a piece; leaps ignore
  intervening cells; `ignoreOccupancy` is used by path planning.
- `fireCells(board, from, geom, team, occupied)` — cells a weapon covers. Slides
  stop at walls and at the first piece (which is included as a hittable target);
  leaps cover their offsets regardless of blockers.
- `lineClear(...)` — Bresenham sight line used for validation.
- `attackApproachCells(board, targetCell, geom, team, occupied)` — empty cells
  from which the target sits inside the geometry (computed as `target − dir`, so
  asymmetric pawn patterns approach from the correct side). Used to pick a place
  to shoot from.

### Pathfinding — `src/game/pathfind.ts`

A* over the graph induced by a piece's **movement geometry**, with terrain move
costs and a Chebyshev heuristic. Unreachable goals return a best-effort partial
route to the closest reached cell, chosen by **Euclidean** distance so a step
that reduces only one axis still counts as progress (a pawn ordered to an
off-file square marches up its own file). Occupancy is passed in as blockers;
the movement system waits and re-plans if a step becomes blocked.

### Occupancy — `src/game/occupancy.ts`

`buildOccupancy(world, board)` maps cell index → entity from each piece's `Cell`
**and** its `Motion.reserved` cell, so a destination is claimed for the whole
duration of a move. The targeting system rebuilds it each tick into
`ctx.occupancy`; `makeOccupied` adapts it to the `OccupiedFn` used by geometry
queries, and `occupiedExcept(board, occupancy, self)` excludes a piece's own
cell/reservation during movement validation and path planning.

---

## 6. Systems reference

- **spawn** — drains `cmds.deploy`, finds a free passable entry lane for the team
  and `createPiece`s there; updates `TeamRuntime.alive` / `deployed`.
- **targeting** — rebuilds occupancy, then sets the engagement target from
  stance + order: an `attack` order is sticky on its enemy; `none` picks the
  nearest enemy already in firing geometry; `attack` auto-acquires within
  `min(weaponVision, ATTACK_LEASH)` (so sliders fight locally instead of chasing
  board-wide), strongly preferring an enemy it can actually shoot this instant,
  then the `lastAttacker` firing on it, then damaged and nearer ones; `move` only
  targets its `lastAttacker` while `underFire`. AI-controlled teams always behave
  as `attack`.
  When an attack order ends (target gone) the order clears; the stance is never
  changed by orders, so the piece reverts to its explicit policy. The `orders`
  leash guard also holds a piece that drifts beyond `ATTACK_LEASH` and is not in
  firing geometry.
- **orders** — turns stance/order into `Motion.goal` for every piece (human or
  AI): an `attack` order pursues the target (or stops to fire when in geometry).
  A **positionally unreachable** target (`order.reachable === false`, e.g. a bishop
  ordered onto the opposite colour) is still approached best-effort — the route
  ends on the closest reachable empty square, and the overlay draws that route
  followed by a dashed "unreachable" firing line, both recomputed each tick as the
  piece and target move (the `reachable` flag only classifies the firing line; it
  no longer freezes the piece);
  a `goto` order advances toward the objective (best effort); autonomous `attack`
  pursues in a leash, and rallies only for AI teams; a low-HP piece retreats via
  `preservation.ts` (escape the shooters that actually cover it, else seek nearby
  cover — see the self-preservation note below). Anything other than
  `attack` clears the goal. Pursuit picks a goal with the
  same chain as `Game.planAttack` (`previewFiringCell` → `closestEmptyCell` →
  target) so the executed route cannot diverge from the preview; a firing position
  beats piling onto the occupied target, and a positionally unreachable target
  (e.g. a bishop on the other colour) still routes to the closest reachable square
  instead of a straight line to the target. `previewFiringCell` picks the approach
  square by **actual movement hops** (`moveDistances`, a BFS alongside
  `reachableCells`), not Euclidean distance — so a knight heads for the firing
  square it can reach in the fewest moves instead of a "nearer-looking" one four
  hops away. Euclidean total is only the tie-break among equally-reachable squares.
  **AI king defense** (`kingDefense.ts`) never rallies. `kingThreats` ranks every
  enemy that can currently hit the king (its weapon's `fireCells` cover the
  king's square, at any range), anyone who hit it while it is still `underFire`,
  and anyone within `KING_THREAT_RADIUS = 3` — scored can-hit-now → adjacent →
  damage → closeness, and memoized per team per tick. `aiKingGoal` then steps to
  the legal square that lowers exposure to those firing lines (ties: greater
  threat distance, then nearer home), backing off only while a threat is inside
  `KING_STANDOFF = 5`; it holds rather than shuffling, and returns to the middle
  of its own back rank once the board is clear. It still fires at adjacent
  enemies via combat. Nearby AI pieces within `KING_GUARD_RADIUS = 4` of a
  threatened king become **bodyguards**: they first try to `screenPlan` — step
  onto a passable square on the Bresenham line between attacker and king
  (`cellsBetween`) so a slide shot stops on them — and otherwise `pursue` the
  top-ranked threat; the rest of the army keeps rallying. `isScreening` keeps a
  guard planted while it is the reason a nearby enemy cannot shoot the king
  (removing it would open the line), so it does not wander off once the attacker
  drops out of the threat list. (Knights leap, so they cannot be screened.) A
  per-update `claimed` set spreads guards across squares.
  A separate **self-preservation** pass runs first for any piece (human or AI).
  `preservation.ts` supplies the shared core: `coverageThreats` (every enemy
  whose `fireCells` cover the piece, plus its recent attacker; the king widens
  this with `KING_THREAT_RADIUS`), `outgunned` (one-volley damage ≥ remaining
  HP), and `escapeGoal`, which scores each legal step by the **total** damage
  covering it (every threat's firing geometry counts — including a nearby enemy
  that cannot hit the piece yet but can hit the square it is about to enter — plus
  a small adjacency penalty, below the weakest weapon's damage), then whether it
  keeps the current target in range, then distance — so a piece dodges *all*
  shooters, not just the last one, and otherwise picks the lowest-exposure square
  that still fires. It triggers when the piece is below a
  per-kind HP threshold (`preserveThreshold`: queen/king 0.5, rook 0.45,
  bishop/knight 0.4, else 0.3) **or** outgunned **or** — for queen/rook/bishop/
  knight/king — covered by two or more shooters, even above the HP gate. Pawns are
  exempt from the retreat: they can only step forward, so an "escape" would march
  them into the enemy and give up the shot, so they hold and fire instead. Valuable
  pieces run this scan every tick so they can bail before taking damage; cheap
  pieces only scan once hurt or actually under fire, and `coverageThreats` skips
  any enemy beyond its weapon's reach, keeping the cost bounded. It runs for
  **every piece** — idle, moving, or pursuing an attack order. It repositions only
  for **real, current danger** — an enemy covering the piece's square now
  (`shooters > 0`) or a recent attacker still under fire — so a piece with only
  distant, non-shooting enemies nearby holds instead of drifting. An explicit
  **attack (kill) order takes priority**: the piece presses the kill and never
  self-preserves, while a move order still yields to safety. A
  **medium wound** retreats only while the danger is present and then resumes the
  interrupted order (move continues, attack resumes). A **badly wounded** piece
  (below `CRITICAL_WOUND = 0.2`) latches a safe-hold (`Motion.holdUntilHp = max`)
  and will not advance its order until it is **fully healed** — a new player order
  clears the hold. Because healing only happens inside the aura, the hold is
  **healing-aware**: a latched piece outside its king's aura walks to the nearest
  reachable square inside it (`nearestHealingCell`) instead of parking where it can
  never recover, breaking off only to dodge a volley that would kill it this tick;
  an explicit move order whose destination already lies inside the aura is left to
  run (only the hold is relaxed, so a pawn can still advance onto a healing
  square). The same fallback covers any wounded piece that is merely below its
  `preserveThreshold`: when `escapeGoal` finds no strictly safer step (e.g. it is
  boxed in by ranged fire while its own square is only "safe" by the adjacency
  term), it heads for the aura instead of standing in the fire. The king's
  **healing aura** is a
  strong sanctuary: a piece inside it holds unless the volley it currently faces
  would **kill** it (`outgunned`) — a mere shooter or a stale "recent attacker" is
  not enough — so it recovers instead of being nudged out of range. When
  hurt, the scan widens to `COVER_RADIUS = 6` so nearby enemies count even before
  they can shoot; it then steps to the least-exposed nearby square (keeping its
  shot as a tie-break) and holds there rather than chasing or trekking home. Gated by
  `ctx.autoPreserve`, the persisted **auto-preserve** toolbar toggle; with it off
  the same coverage-based retreat still runs for a low-HP Attack-stance piece
  (there is no longer a single-target `fleeCell` path). A `none`/`move` piece
  never pursues or capture-advances — its only self-directed move is this
  necessary dodge, so it otherwise goes exactly where it is ordered and holds.
  Every goal records a `Motion.intent` (`order` / `preserve` /
  `defense` / `engage` / `rally`), so the renderer can colour a self-preservation
  retreat bright yellow and the properties panel can label each goal's source;
  the shorthand export carries it as `intent=<kind>` (and `hold=<hp>` while a
  safe-hold is latched).
  A self-preservation retreat is also written to the piece's `Order.log` as one
  **episode**: a single `self-preservation: retreating → <cell>` when it starts and
  a single close-out when it ends (`self-preservation: safe — holding` /
  `… safe — resuming order` for the safe branch, `… no safer step — holding` when
  it is still covered but every step is no safer, `… no longer needed — holding` /
  `… no longer needed — resuming order` when the gate simply stops acting). So the
  autonomous move shows up in the panel history, the shorthand `note=` and the
  transcript's `order:` tokens instead of leaving the last player-order note stale.
  Intra-episode goal re-evaluations are not logged, so a goal that is abandoned
  before it is ever pursued cannot leave a false "retreat" as the newest entry,
  and a held goal does not spam the bounded log.
  The **reported** under-fire status (panel `under fire from`, shorthand `fire=`,
  the per-turn trace/analysis) is stricter than the AI latch: `underFireAttacker`
  returns the last attacker only while it still has line of sight, so a piece that
  has stepped off the firing line is no longer reported as under fire.
  A player-issued move **replaces** any active attack — it does not park the
  target to resume later and does not kite the piece back toward the old fight.
  A piece ordered to a healing square therefore stays there and recovers.
  When the active step finishes — a goto arrival, an attack target's death, or a
  goto whose destination the piece's movement geometry can *never* reach
  (`destReachable` via `reachableCells`) — `promoteNext` (`src/game/queue.ts`)
  shifts the first queued step into the active slot instead of clearing, and
  `rechainQueue` re-plans the remaining steps from the piece's new cell. A
  waypoint merely blocked by pieces is reachable and therefore **waits**, exactly
  like a single goto order, so a queue is never lost to a temporary jam; an
  unreachable waypoint is skipped with a `warn` event.
- **pathfinding** — budgeted A* (`PATH_BUDGET_PER_TICK`) over the piece's
  movement geometry, with other pieces passed in as blockers (excluding the
  piece itself). Unreachable goals fall back to the nearest reachable cell.
  A `goto` route is planned against **live** occupancy. An **attack order's
  route is re-derived continuously** rather than settled once: because pieces
  move every turn, a stored route is stale, so on a goal change, an empty or
  blocked route, or a short cadence the system recomputes from the piece's
  current cell, live occupancy first. In order of preference it takes a route
  that reaches the firing goal, else a best-effort partial so the piece still
  creeps toward it, else a fresh *theoretical* route (only walls and the
  target's own square avoided) so the intended line stays visible while boxed
  in. The route is never kept across re-plans.
- **movement** — consumes `Motion`. `Cell` stays at the **origin** and
  `Motion.reserved` claims the destination while the piece animates into it;
  the origin is only released on arrival. Before each step it re-validates that
  the next route cell is a legal one-move destination for the piece's geometry
  given live occupancy, so slides stop at the first piece/wall and only leaps
  pass over blockers. A blocked attack-order piece keeps its path only until the
  next re-plan (which overwrites it, typically a live detour), so the planned
  line stays on screen without ever fossilising behind a friendly that never
  moves. Two pieces can never share a cell, and there is
  no visual cross-through. During a turn, a piece is skipped once `movedThisTurn` is set
  (one move per turn) **and only one piece may be `moving` at a time**, so turns
  (and replays) read as a sequence of individual moves. Travel time scales with
  the slide length. An AI team whose opponent is human is also capped by the
  opponent's per-turn `movesThisTurn`, so it cannot out-move the player within a
  turn (with a floor of one move so a passive player cannot freeze it; nothing
  carries over between turns). A player-issued order (`Order.kind !== 'none'`)
  bypasses the budget; only pieces whose team is under human control can be
  commanded (your own team in Human-vs-AI, both teams in Human-vs-Human, none in
  AI-vs-AI).
- **combat** — ticks `Weapon.left`; when ready, fires at `Target.entity` if it is
  inside `fireCells`. Because targeting decides whether a target exists at all,
  combat inherits the stance/order fire policy automatically.
- **projectile** — advances waypoints at `speed`; applies splash/direct damage on
  impact via `cmds.damage`; `line` shots are stopped by walls; jump/arc ignore
  blockers.
- **damage** — applies damage with ±10% seeded variance (a `lethal` chess-kill
  command drops the target straight to 0 HP), marks `Dead`, credits kills. A kill
  by a direct blow from a still-living enemy of the victim queues an `advance`
  intent (killer → victim cell) when `ctx.captureAdvance` is on.
- **death** — spawns an `Fx`, updates losses, queues destruction. A **chess-rule
  kill** (tagged with the `ChessKill` marker by `damage`) gets its own small,
  quick **red triple pulse** and a quiet two-thump crunch
  (`death.capture.<kind>`); ordinary HP kills keep the standard team-coloured
  blast and boom, even when a capture advance follows.
- **cleanup** — destroys queued entities and ages FX.
- **advance** — drains `cmds.advance`. After cleanup has freed the victim's
  square, an **idle** killer (no active order, queue, path or hop; the attack
  order that just killed this victim does not count) steps along the firing ray
  it killed with onto that square. The step is a slow (~0.75 s), eased **glide**
  driven by the normal `movement` tween: the killer's cell stays at its origin
  until it arrives, the destination is reserved, and the slide starts on the same
  tick as the blast. The move is free (a capture,
  not the piece's turn move), so it ignores the move cooldown after arrival, the
  turn move allowance and the AI move budget. The hop is re-validated against
  live occupancy and geometry (blocked line, occupied destination or a dead
  killer cancels it), capped at one step per killer per tick, and exposed by the
  persisted **capture advance** toolbar toggle (default off). It is an
  **Attack-mode** behaviour only: a passive (`none`/`move`) piece never
  capture-advances, so a kill can never pull it off a safe or healing square.
- **healing** — king aura regeneration: same-team pieces within two Chebyshev
  cells of their living king (excluding the king itself, which is the aura source
  and never regenerates) regain 5% of max HP per second, or 3× that for
  human-controlled teams, clamped at max and never reviving a piece at zero HP.
  Membership comes from `healingTargets` (`src/game/healing.ts`), shared with the
  renderer so the overlay matches the mechanic. Deterministic (advances only by
  `ctx.dt`), so it is captured by turn snapshots and replays like every other
  system.

---

## 7. Pieces, weapons, projectiles — `src/game/pieces.ts`

`PieceDef` carries `hp`, `move` geometry, `moveCooldown`, `weapon` key,
`buildTime`, `supply`, `cap`, `size`, `radius`. `WeaponDef` carries `geometry`,
`damage`, `cooldown`, `projectile`. `ProjectileDef` carries `trajectory`
(`line` / `homing` / `arc` / `jump` / `beam`), `speed`, `ttl`, `radius`,
`splash`, `color`, plus presentation fields `size`, `shape` (`dot` / `shell` /
`lance` / `bomb`) and `spin`. Each piece fires a distinct, small projectile at its
weapon rate; the knight's bomb is slow and tumbles (rotates) in flight.

Shipped chess set: pawn, knight, bishop, rook, queen, king. `weaponVision`
derives target-acquisition radius from the weapon geometry. The pawn fires the
two forward diagonals at range 1 (chess capture); a piece directly ahead blocks
it and is not a target. In movement it advances one square, or two from its home
rank as a single first move (a blocked first square forbids the double step).

---

## 8. Rendering — `src/render/`

The renderer is a read-only view. `Game.onFrame` is set by `BoardView.vue` to
call `renderer.draw(game)` each animation frame.

Draw order: clear → baked terrain (`terrain.ts`, keyed by
`boardId:WxH:terrainVersion:grid`) → camera transform → spawn zones → scoped
overlays (move/attack cells, range arcs, paths, destinations, red tracking
chains) → hover ghosts → pieces (shadow, glyph, health + reload bars, stance
badge, selection/target rings) → projectiles (shape-specific: dot/shell/lance/
tumbling bomb) → FX rings → hover cursor → border → chess coordinates.

### `Camera` — `src/render/camera.ts`

Centre-based: `screen = (world − camera) × zoom + viewport/2`. `fit()` computes
the whole-board zoom and stores it as `fitZoom`; that value is also the
`minZoom`, so the player can never zoom out past the fitted board. When `zoomAt`
reaches that floor it arms a board-centre target rather than snapping `x/y`; the
renderer calls `camera.update(dt)` each frame, which eases toward that centre
(exponential smoothing) so a panned board glides back instead of jumping.
Panning or zooming back in cancels the pending recentre. `resize()` calls
`updateLimits` to recompute the floor and clamp the current zoom — a zoomed-in
view is never reset by a layout change (panel/HUD toggle), only raised if the
new floor demands it. `maxZoom = 8` gives comfortable close-up range on
large displays. `zoomAt` is cursor-anchored; wheel zoom is exponential on
`deltaY` (`exp(-delta * 0.0008)`, clamped 0.7–1.4) for a gentle trackpad feel.

---

## 9. Vue UI and snapshot contract

`App.vue` constructs one `Game` (which starts **paused**), starts the frame loop,
and copies `game.snapshot()` into a `shallowRef` every
`SNAPSHOT_INTERVAL_MS = 120`. The simulation never depends on Vue reactivity.
Control hints + the piece panel + hover readout live in side rails (left/right),
independent of the HUD toggle, so they never cover the board. The HUD starts
hidden; `h` toggles it, and `tab` toggles the side rails (`railsVisible`). The
stage grid adapts to which of the two side stacks (rails, reinforcement rosters)
are shown, giving the board the full width when both are hidden. Toggling either
resizes the canvas and recomputes the fit floor without re-fitting, so a
zoomed-in view keeps its zoom and centre (`BoardView.resize()`).

The HUD bottom panel (stats + event log) is resizable: a draggable
`.splitter.horizontal` row sits between the stage and the panel, its height
driven by `.app`'s inline `grid-template-rows` from a local `bottomHeight` ref
(clamped to a minimum panel and stage size). Dragging sets the height from the
pointer, double-click resets, and the result is persisted as `bottomFraction`
of the viewport.

The side rails are resizable the same way: each rail sits in a `.rail-stack`
flex row with a `.splitter.vertical` on its inner edge, and `.stage`'s inline
`gridTemplateColumns` (from local `leftWidth`/`rightWidth` refs) sizes the
columns. Dragging sets the width from the pointer, double-click resets, and the
widths persist as `leftRailFraction`/`rightRailFraction` of the viewport, clamped
to leave a minimum board width. Within the left rail the **controls** hints list,
and within the right rail the **stance**, **legend**, **firing lines** and
**copy** sections, are wrapped in `CollapsibleSection.vue` — a clickable
rail-title header with a caret that hides its body and persists its state as
`controlsCollapsed`/`stanceCollapsed`/`legendCollapsed`/`firingLinesCollapsed`/
`copyCollapsed`. The **hover** readout sits between the firing-lines and copy
sections and is not collapsible. The right-rail legend draws its swatches with
`LegendIcon.vue` (inline SVG coloured from `src/render/palette.ts`), so the
legend can never drift from what the canvas actually paints.

The hover readout shows the hovered cell's coord and kind, and for an occupied
cell the piece's glyph, name and side plus its **current intent** — its motion
goal provenance (`self-preservation`, `engaging`, `rally`, …), falling back to
its order or stance when idle. An enemy's intent/order/goal is redacted unless
the `enemy plans` overlay is on (the readout shows "intent hidden"), so it cannot
leak a hidden plan.

`GameSnapshot` fields (`src/game/game.ts`): `running paused tick fps tps speed
boardId boardSize boardSizes teams timings events eventCount shots kills
warnings selected selectedLines counts winner overlays hudVisible autoPreserve
captureAdvance soundEnabled railsVisible controlsCollapsed stanceCollapsed
legendCollapsed firingLinesCollapsed copyCollapsed hover
playerTeam turnActive queuedTurns canReplay canUndo canRedo replaying
barProgress pendingCommand selectionCount stanceSummary pieceInfo
terrainVersion`.

| Component | Responsibility |
| --------- | -------------- |
| `Toolbar.vue` | board size, turn/pause/step/undo/redo/replay, speed, overlay toggles, sound toggle, HUD toggle, auto-preserve, capture advance, reset |
| `BoardView.vue` | canvas + Renderer; left-click/box-select, shift-click adds, `m`/`a` prefix commands, context right-click order, shift/middle-drag pan, wheel zoom; draws the selection rectangle |
| `PiecePanel.vue` | focused piece properties (health, reload, stance, target, order, order / auto changes, queue, movement) with order-provenance labels (`manual` / `unreachable` / `auto · self-preservation`) and a target heading (`engaging` when committed, `pot shot` when only firing in range), selection-wide stance buttons and clear-orders. The **order / auto changes** list shows the piece's last few transitions with their tick, so it is clear *why* an order was issued/replaced/completed/abandoned (e.g. `target at e7 lost — attack abandoned`) and includes autonomous self-preservation retreats |
| `ReinforcementBar.vue` | per-team piece icons; click deploys from an entry lane |
| `StatsBar.vue` | turn/tick/fps/tps/pieces/shots/kills/entities/selected/winner |
| `EventLog.vue` | Event stream (filter chips), Systems timings, Sound config panel, Inspector for the selection |
| `CollapsibleSection.vue` | clickable rail-title header with a caret that hides its slot body; state owned/persisted by `App.vue` |
| `LegendIcon.vue` | inline-SVG legend swatches (cells, route/objective, preserve, waypoints, bars, firing lines, stance badges, target rings) coloured from `src/render/palette.ts` |

### Overlay scope and legend

Overlays have a scope model: the **selection** always gets full detail; `my
orders` (`o`) and `enemy plans` (`e`) extend a summary to each army.

- **Move cells** — blue translucent squares: legal one-square destinations.
- **Attack cells** — red outlined squares: cells the weapon can hit now
  (geometry + line of sight). Outlined rather than filled so red remains visible
  where it coincides with blue (rooks/bishops/queens).
- **Range arc** — nominal weapon reach for the selected piece: directional bands
  along each firing line (rook files/ranks, bishop diagonals, queen/king all
  eight), a forward half-disc for the pawn, and 8 dots for the knight.
- **Path** — dashed gold route; **destination** a hollow diamond (orange and
  dashed when blocked). The diamond shape keeps the destination distinct from the
  target reticle (circle + cross). A **self-preservation** retreat
  (`Motion.intent === 'preserve'`) draws the route in bright yellow
  (`PRESERVE_COLOR`) so an automatic dodge is never mistaken for an order. When it
  overrides an ordered attack the ordered-attack branch returns early, so only the
  yellow dashed retreat route is drawn (no destination diamond); a standalone
  preserve goal still draws the yellow diamond. The right-rail legend shows the
  yellow dashed line only, matching the common override case.
- **Target** — an ordered attack (`order.kind === 'attack'`) draws a red firing
  line + reticle and rings the victim red. An auto-acquired target is drawn two
  ways: a **committed** piece (AI controller, or Attack stance) will pursue it, so
  it gets the same line + reticle in **amber** and rings the victim; a stationary
  **None/Move** piece only fires at whatever passes in range and will not follow
  it, so it gets a muted **grey dashed** line with no arrow, reticle or ring — a
  "pot shot", never mistaken for a lock-on. The line runs from the piece's
  **current square** unless it is genuinely moving to a firing position to pursue
  (`Motion.intent === 'engage'` for an autonomous engagement, or `'order'` for an
  ordered attack), in which case it is previewed from the end of the planned path;
  a self-preservation override (`intent === 'preserve'`) therefore never draws the
  line from a retreat square. The piece panel mirrors this: its target heading
  reads `engaging` for a committed piece and `pot shot` otherwise, with an
  "in range only — …" note that adds "holding position" when the piece has no
  goal.
- **Healing** (`show healing`, off by default) — a pulsing green aura around each
  living king, a dashed ring at the two-square boundary, and wavy tendrils to the
  damaged same-team pieces inside it. This toggle is display-only: the
  regeneration itself always runs.
- Army scope shows paths, destinations and targets; reach/attack shading and
  range arcs are reserved for selected pieces so the board stays readable.

`overlays` flags: `grid`, `health`, `myOrders`, `enemyPlans`, `moveCells`,
`attackCells`, `rangeArcs`, `reload` (firing-recharge bars over pieces), `healing`
(king aura + tendrils).
`rangeArcs` is off by default; movement cells, attack cells and range arcs are
drawn for selected pieces only; the health and recharge bars are drawn for every
piece (each gated by its toggle), and army scopes show paths/goals/targets. Bars
are BAR-style: each draws a fixed dark frame full width (`BAR_BG`) with no
outline stroke, and a coloured portion growing inside it — a green→red (solid red at ≤40%)
health fill shown only when damaged, and a teal left-to-right recharge fill shown
only for a long-cooldown weapon that has fired (`Weapon.fired`); both hide when
effectively full and stack top-down.

Ordering is BAR-style and **context-sensitive** — there is no global order mode:

- **Left-click** selects; shift-click adds; a drag box-selects (`Game.selectRect`).
- **Right-click** issues an order for every selected commandable piece:
  enemy square → attack, empty square → goto, friendly square → no-op. A repeat
  click (or Shift+right-click) **appends** a queued step (`Game.appendStep`), so
  `move, move, attack` can be planned with repeated right-clicks; only the first
  click on an unplanned piece replaces/creates the active order, and `c` clears
  the whole plan. A move on an un-queued attacker **replaces** the attack (no
  parked target to resume) rather than queueing behind it. A piece whose active
  order has **settled**
  (arrived, or parked at the closest legal point a best-effort route can reach —
  `Game.orderSettled`) yields to the new command instead of hiding it in the
  queue, so an impossible order can no longer swallow every later click; an order
  that is still progressing, or merely blocked by friends, keeps its queue.
- **`m` / `a` + left-click** arms a transient **pending command**
  (`Game.pendingCommand`) to force a move/attack: `Game.orderAt(cell, command)`.
  The prefix is consumed by the click unless **Shift** is held (kept armed to
  queue several); a plain left-click selects and clears it. `a` on an empty or
  friendly square is a no-op (a warning is emitted).
- **Chess kills** (persisted toolbar toggle, default off): when an order is issued
  against an enemy that already sits inside the ordered piece's chess capture
  pattern — its weapon's `fireCells`, which mirror chess (pawn diagonals only,
  knight leaps, sliders blocked by the first piece) — `orderAt` parks the victim
  on `Order.chessKill`. The `orders` system consumes it on the next tick and
  queues a `lethal` damage command, killing the target at once instead of wearing
  it down with projectiles. Keeping the pending victim on the order (rather than
  in the command queue) makes it part of the turn snapshot, so undo/redo and
  **replay** reproduce the kill and its red pulse exactly. Applies to an explicit
  attack or a move onto the enemy's square; checked only at **order-issue** time
  (a target that walks into range later is fought normally), and only for
  explicitly ordered pieces (AI autonomous stance is unaffected).
- The queued remainder is drawn by the renderer as a dim dashed chain with
  numbered waypoint markers (`queueMarkers`), and a queued attack shows a dim
  threat line to its target.
- Pieces start with no stance and show no badge; only an explicit stance or an
  active attack order draws one. Toolbar selects/checkboxes blur after use so the
  global shortcuts always reach the window.
- Hovering computes a per-selected-piece order preview (`Game.setHover`, drawn as
  faint ghosts) and a cell readout; the on-canvas coordinate label gets a solid
  backing only when a piece occupies the hovered square, so it stays legible
  over a glyph while empty squares remain unobscured.
Chess coordinates (`coordName`) label the board margins.

### Position save / load / export

The right rail's **position** section saves and restores whole battles. The unit
of transfer is `SavedPosition` (`src/game/position.ts`): terrain, every component
store (via `World.capture`, so entity ids and references survive), RNG state,
tick/turn, teams, mode, overlays and sim rules. It is plain JSON and versioned
(`POSITION_VERSION`); `validatePosition` rejects unknown versions/stores (and
malformed history) before anything is mutated.

- `Game.exportPosition({ history: true })` also serializes the full undo/redo
  history (`SavedHistoryEntry[]`) and cursor, so loading restores undo/redo and
  replay exactly. `Game.importPosition(data)` rebuilds the `Board`, restores the
  world (mapping serialized store names back through a registry), reapplies the
  saved sim settings, restores the history/cursor (trimming to `HISTORY_LIMIT`),
  resets all transient turn/replay/selection state, pauses and rebuilds `ctx`.
  A position-only save (no `history`) still loads, starting a fresh history.
- **Save/Load**: named slots in `localStorage` (`src/game/storage.ts`), keys
  `bar-chess.positions.index` and `bar-chess.positions.<id>`; a same-named save
  overwrites. Slots save the full game by default and record a turn count
  (`SlotMeta.turns`); if the storage quota rejects the history, the save falls
  back to position-only and reports it. Load/Delete apply immediately.
- **Copy / Export / Import**: **Copy state (JSON)** emits a position-only
  `SavedPosition` for LLM/debug, while **Export JSON** includes the full history;
  both re-import. `Game.toDebugJson()` remains the terse debug view.

`Rng.getState()` is canonicalized to 32 bits so a save/restore produces a
byte-identical stream (see §10).

### Settings persistence

UI/session preferences survive a reload (and a dev-server restart) via
`src/game/settings.ts`: `Game.settings()` snapshots them and `Game.applySettings`
applies a validated patch. Stored under `bar-chess.settings`:
`overlays` (all flags), `hudVisible`, `railsVisible`, `speed`, `gameMode`,
`soundEnabled`, `bottomFraction` (the HUD splitter height),
`leftRailFraction`/`rightRailFraction` (side-rail widths) and the section
collapse flags `controlsCollapsed`/`stanceCollapsed`/`legendCollapsed`/
`firingLinesCollapsed`/`copyCollapsed` (per-piece stance lives in the world, not
here). `loadSettings`
drops malformed or out-of-range fields (unknown
overlay keys, non-boolean flags, speeds outside `SPEEDS`, unknown modes,
`bottomFraction` outside 0.1–0.9, rail fractions outside 0.08–0.45), and
`saveSettings` swallows storage failures (private mode, quota) so persistence can
never break the game. `App.vue` applies the patch once at startup and re-saves on
every toolbar/hotkey change. This is separate from `SavedPosition`, which still
carries overlays for a specific saved battle.

### Shorthand for reading (LLM / debugging)

The lossless JSON is ~16k tokens for the opening position — wasteful to paste
into an LLM. `formatShorthand(game)` (`src/game/shorthand.ts`) emits a compact,
line-oriented dump instead: a header (map/size/tick/turn/mode/you/winner), team
totals, sparse non-floor terrain, an ASCII grid for boards up to 16×16, one line
per piece with only non-default attributes (`hp`, `@M`/`@A` stance, `goto`/`atk`
orders with `#id(cell)` references, `q` queued steps, `tgt`, `goal`, `path`
hops, `blk`, `moving`, `w` reload, …), selection ids and in-flight projectiles.
Opening 8×8 ≈ 80 tokens; a 16×16 mid-game ≈ 250.

- **Copy history for LLM** is the full-context paste for the first message:
  `buildGamePrompt` (`src/game/studyPrompt.ts`) prepends `LLM_PREAMBLE` and joins
  the compact board, the turn-by-turn **transcript** (a compact board after every
  turn), the flagged **analysis** and the replay record (with a note that it is
  seed+inputs only).
- **Copy snapshot for LLM** is the per-turn paste: `buildSnapshotPrompt` emits the
  current compact board plus the last turn's activity (moves/shots/damage/held and
  `order:` change notes), with no preamble — small enough to paste every turn.
- `Game.shorthand()` / `Game.llmShorthand()` remain available on `window.game` in
  dev. The shorthand is read-only — `SavedPosition` JSON stays the import/round-trip
  format.
- **Live log.** `GameLog` (`src/game/gameLog.ts`) observes the running game: it
  buffers the event stream and samples a per-turn piece trace, then renders the
  transcript + analysis on demand. Sampling is driven by the game's
  `phase`/`turn end` event (emitted in `Game.finishTurn`), so back-to-back queued
  turns are never missed by polling. `begin()` samples the opening. Undo/redo only
  move a `cursorTurn` (via `rewind`) — the full log is retained, so redo restores
  complete detail and a snapshot taken while viewing an earlier turn is accurate;
  a new turn played after an undo truncates the abandoned branch at `turn started`.
  `StudyController` and the live board share it, so both produce the same output.

### Seeds, game records & self-play

- **Seeds.** `Game` takes an optional origin `seed` (`new Game(size, mode, seed)`,
  `loadSize(size, seed)`; `reset()` reuses `this.seed`). `Rng` consumes it for
  damage variance and initial cooldown/reload jitter, so `(board + seed + ordered
  inputs)` fully determines a battle. The seed is exposed on `GameSnapshot.seed`
  and `SavedPosition.seed` (absent on pre-seed saves, defaulted on load).
- **Game record.** `Game.onCommand` reports player commands (order, stance,
  clear, deploy, mode) normalized to board cells. `Recorder`
  (`src/game/record.ts`) groups them by the turn they precede; a `GameRecord` is
  a header (`boardId`, `size`, `mode`, `playerTeam`, `seed`, rule settings) plus
  turns and result. Each turn entry also snapshots the rule settings when its
  first order was issued, so a mid-game toggle replays correctly; the header is
  refreshed from the live game at export and is the fallback for order-free
  turns. AI-vs-AI records carry no intents — the seed alone reproduces
  them. `replayRecord` clears the component stores, rebuilds
  `new Game(size, mode, seed)`, re-applies each turn's intents and re-simulates;
  it is exact (`tests/unit/record.spec.ts`). This is the compact, replayable
  stand-in for a stack of position snapshots. `Recorder.snapshot()` returns a
  detached copy with the current outcome (and `result.partial` while unfinished)
  without mutating the live recorder; the record is a replay format, not a
  narrative, so it is only pasted to an LLM as part of the **Copy history for LLM** bundle.
- **Study mode.** The bottom HUD's **Study** tab (`src/components/StudyPanel.vue`)
  runs a batch of games **on the live board** so they can be watched. A pure
  `StudyController` (`src/game/study.ts`) drives the main `Game`: per game it
  `loadSize`es a new seed, resets the `Recorder`, auto-advances turns with
  `queueTurn()`, and applies an optional scripted "human" policy (`advance`,
  `focus`, `turtle`) before each turn. It samples a per-turn **piece trace**
  (`src/game/trace.ts`) and collects the event stream. `Stop game` keeps the
  current (partial) recording and moves to the next seed; `Cancel all` discards
  everything. The trace makes behaviour that leaves no event — a piece that
  *held* under fire, a piece that never moved — explicit.
- **Transcript & analysis.** `src/game/transcript.ts` renders a compact per-game
  text (header, opening board, per-turn activity, per-piece summary) and
  `src/game/analysis.ts` flags gaps: held-under-fire, never-moved/never-fired,
  no-progress turns, oscillation, focus fire. Per-turn activity also carries
  `order:` notes — why a piece's order/behaviour changed (issued/replaced/
  completed/abandoned, including autonomous self-preservation retreats) — taken
  from the piece's `Order.log` (`src/game/queue.ts`) via the
  per-turn trace, so holds and target losses are explained, not just movement.
  `src/game/studyPrompt.ts` wraps a
  batch's full transcripts in a reusable "analyse these games" prompt; the panel's
  **Copy analysis prompt** button puts it on the clipboard for an LLM session.
  The seed is shown read-only in the stats bar.

Keyboard: `m`/`a` arm a move/attack command (then left-click; Shift keeps it
armed), `space` turn, `p` pause, `s` step, `u`/`r` undo/redo, `y` replay,
`c`/`Backspace` clear orders, `o` my orders, `e` enemy plans, `h` HUD, `tab`
side rails, `Esc` cancel the pending command else clear the selection. `Game.orderAt(cell,
command?)` resolves the intent: an explicit `move` always gotos, an explicit
`attack` requires an enemy occupant, and omitted is context-sensitive
(enemy→attack, friendly→no-op, empty→goto). Re-issuing the same order appends a
queued step (a duplicate of the active or last queued step is ignored), and only
pieces under human control can be commanded. Orders never change stance; the
piece stays whatever the **piece panel** set (red **A** = Attack stance badge).
The attack navigation is re-derived from the current board on every re-plan
(goal change, block, or cadence), live occupancy first: a real route when one
exists, a best-effort partial that creeps toward the goal when it does not, and a
theoretical route (walls and the target's square only) as the boxed-in fallback.
It ends on a genuine firing cell or the closest empty reachable cell. The firing
line from there to the victim is judged against the current board: solid red when
the shot is clear; solid red up to the blocker and dashed red beyond it when
reachable but blocked; dashed grey when positionally out of reach. A lock reticle sits on the victim and
the legend groups these under "firing lines". When the target dies the order
clears (stance unchanged), and `planAttack` routes immediately (visible while
paused) against a fresh occupancy map. Left/right clicks never change the
selection. `space` pressed while a turn/replay is running is buffered (up to 3) and runs
after it rather than being dropped; `u`/`r` undo/redo completed turns.

Team colour is Orange vs Blue; **red marks an ordered attack**: the firing chain,
the Attack stance badge, and the ring around a piece targeted by an explicit
attack order. **Amber marks autonomous engagement**: the ring/line around an
auto-acquired or retaliation target (Attack stance or return fire). Pieces no
longer draw a default ring. Target rings/chains
are computed from **scoped** pieces only (selection + `my orders` / `enemy plans`),
so they never float permanently. A damaged piece draws a thin
green→red (solid red at ≤40%) health bar and a long-cooldown weapon that has fired a **teal**
recharge bar, each hideable via its `health` / `reload` overlay toggle; both hide
when effectively full and are tile-relative so the bars stay inside the cell; all
pieces render at a uniform size.

---

## 10. Determinism & performance

- All randomness goes through `Rng` (`mulberry32`). The event stream is a
  repeatable trace for a given board and input timeline.
- Performance levers: occupancy map for O(1) cell lookups, budgeted A*,
  baked terrain, shallow refs + 120ms snapshots, a single rAF loop.
- Avoid: `Math.random()` in sim code, mutating the world from the renderer or
  Vue, putting wall-clock time into gameplay.

### Reachability and the 64×64 hot spot (fixed)

`attackApproachCells` produces many candidate firing squares (a long slide can
probe ~192). `firingPositionExists` / `previewFiringCell` used to call `findPath`
**once per candidate**, which was catastrophic when the target is positionally
unreachable (e.g. a bishop on the opposite colour): each failed A* exhausted the
piece's whole reachable component, every tick, for every pursuing piece. At 64×64
that was ~50 ms per call and ~80 ms/tick overall (`orders` was ~100% of the
frame).

`reachableCells` (`src/game/pathfind.ts`) replaces the per-candidate searches
with one allocation-free flood fill over the movement geometry (walls block,
pieces are ignored — exactly the reachability `findPath` used with no occupancy).
`approach.ts` now answers reachability in O(1) per candidate. Results are
memoized in a small LRU keyed by geometry id + team + origin cell, invalidated
when the board object changes or `Board.terrainVersion` bumps (terrain is edited
via `setTerrain`). Measured on the 64×64 AI-vs-AI sim: **80.6 → 1.6 ms/tick**,
`orders` 6.6 ms → ~0.04 ms/tick.

`tests/unit/perf.spec.ts` guards this with generous wall-clock bounds (the
unreachable-bishop preview and three 64×64 turns). It is deliberately loose so it
fails on a regression of this magnitude, not on a slow CI machine.

### Reading the stats bar: fps vs tps vs refresh rate

- `tps` is **simulation ticks per second**, not frames. `FIXED_DT = 1/30`, so at
  speed ×1 a healthy game shows `tps ≈ 30`; at ×0.5 (turn, replay or free play)
  it is ~15. `tps = 0` simply means paused.
- `fps` is the **rAF frame rate**, i.e. `1 / frame delta`. It can never exceed the
  display/browser refresh rate. Before blaming the game, confirm the machine is
  not capped at 30 Hz — run this in a **blank** tab:
  `let last=performance.now(),d=[];const f=t=>{d.push(t-last);last=t;d.length<60?requestAnimationFrame(f):console.log((1000/(d.slice(5).reduce((x,y)=>x+y,0)/(d.length-5))).toFixed(1),'fps')};requestAnimationFrame(f)`
  If a blank tab reports 30, the whole browser is 30 Hz (macOS Low Power Mode,
  a 30 Hz external panel, etc.) and the game is already at the cap.
- At 64×64 AI-vs-AI the renderer draws in ~0.2 ms and the sim runs at ~600 fps of
  headroom, so on a 60 Hz display the loop is display-bound, not game-bound. The
  only tooling lever left is capping `devicePixelRatio` in `Renderer.resize()` to
  cut HiDPI canvas compositing — not needed unless profiling shows GPU-bound
  frames.

---

## 11. Audio — `src/audio/`

Combat sound effects are **procedurally synthesized** (no audio assets, no
licensing, works offline) and driven entirely by the event stream. `App.vue`
subscribes to `game.bus` and forwards each record to `AudioEngine.handle`; the
engine reads only `EventRecord.type`/`data`, so determinism is untouched.

- `AudioEngine` (`audio.ts`) owns the `AudioContext` lifecycle: it is created
  lazily and `unlock()`ed from the first user gesture (browser autoplay policy).
  `setEnabled`/`setVolume`/`dispose` are the public controls; every method is a
  safe no-op when Web Audio is unavailable (node/tests/old browsers). A
  0.3 s density window (max 16 voices) plus a per-key minimum gap tames the
  event flood of a 64×64 AI-vs-AI battle.
- `Synth` (`synth.ts`) renders `VoiceSpec`s from oscillators, filtered noise and
  gain envelopes (`play(spec)`); it holds no per-weapon logic.
- `voices.ts` is the pure, serializable voice data: `fireVoice(weapon)`,
  `hitVoice(kind, shape, damage)`, `explosionVoice(kind, radius)` and
  `missVoice(cause)` return a `VoiceSpec` (an ordered list of tone/noise events).
  `VOICE_OVERRIDES: Record<cueId, VoiceSpec>` wins over the built-in voice, so a
  JSON blob copied from the editor can be pasted straight in.

The systems were extended to put the needed context in event `data` (events are
not persisted, so this is additive): `shot` carries `weapon`/`piece`/
`projectileKind`; `hit` carries `kind`/`shape`/`damage`/`weapon` (the attacker's);
`explosion` carries `kind`/`radius`; `miss` carries `cause`
(`ground`/`wall`/`expired`/`target-lost`).

Sound is **off by default** (opt-in), toggled by the toolbar **sound** checkbox,
and persisted as `soundEnabled` in `GameSettings`.

### Cue registry & sound config panel

`sounds.ts` owns the canonical, data-derived cue ids and their synth parameters,
so the live engine and the panel can never drift:

```
shot.<weapon>                 what a piece fires
hit.<targetKind>.<weapon>     a piece taking a hit from an attacker's weapon
death.<kind>                  a piece dying
miss.<cause>                  a shot hitting nothing
```

`cueIdForEvent` maps an `EventRecord` to an id; `AudioEngine.handle` resolves it
through the registry (a `hit` with no known attacker weapon falls back to raw
shape/damage data), and `AudioEngine.audition(id)` plays a single cue on demand —
bypassing the enabled gate and throttle, so sounds can be previewed with sound
off. `AudioEngine.preview(spec)` plays an arbitrary edited spec through a
dedicated preview bus (`stopPreview()` silences it). `catalog.ts` is a pure
view-model (`pieceAudioCatalog`) exposing each piece's combat stats (hp, move
geometry/cooldown, weapon damage/rate/reach/vision, projectile
trajectory/shape/speed/splash/radius) alongside its fire, six hit-from-attacker
and death cue ids.

### Overrides (editing + persistence)

`overrides.ts` is a runtime layer above the committed `VOICE_OVERRIDES` code.
Edits are accumulated there, persisted to `localStorage`
(`bar-chess.soundOverrides`, validated on read), and re-loaded at startup.
`resolveSpec(id, builtin)` picks **local override → code override → built-in**,
and `sounds.ts` resolves the effective spec at play time, so saved edits are
heard in the live game immediately (no code change needed). The store exposes
`get/set/clear/clearAll/all/overrideCount/subscribe/overrideSource`, plus
`formatEntry` / `formatAllOverrides` which emit valid, pasteable TypeScript.

#### Voice override workflow

1. Press **`h`** to show the HUD, then open the bottom panel's **Sound** tab.
2. Expand a piece; each cue row shows `▶` (audition), `∿` (edit) and its **cue id**
   (`shot.<weapon>`, `hit.<target>.<weapon>`, `death.<kind>`, `miss.<cause>`).
3. Click `∿` to open the synth editor and tweak the knobs / JSON. Tick **loop** to
   hear edits continuously. Every change is **saved automatically to
   `localStorage` and applied to the running game immediately** — no code change
   needed. The editor badge reads `override loaded (saved)`, and the cue id gets a
   ◆ marker in the panel.
4. To **commit to code**, copy and paste into `VOICE_OVERRIDES` in
   `src/audio/voices.ts`:
   - **Copy all** → the whole declaration; replace the existing block with it:
     ```ts
     export const VOICE_OVERRIDES: Record<string, VoiceSpec> = {
       "shot.bishopLance": [ { "type": "sawtooth", "from": 1900, /* … */ } ],
       "hit.pawn.rookShell": [ /* … */ ]
     }
     ```
   - **Copy entry** → a single `"cue.id": [ … ],` line to paste **inside** the
     braces.
   The value is always an **array of events**, and the key is a **quoted string**.
   Pasting a bare array (or omitting the `"cue.id":` key) is invalid TypeScript.
5. After committing, reload; the local and code copies match. Optionally click
   **Clear all** in the panel to drop the local copies so the committed code
   becomes authoritative. **Reset** in the editor clears just that cue's override;
   **Clear all** drops every saved override.

### Synth editor

`SoundPanel.vue` (the bottom panel's **Sound** tab, hosted by `EventLog.vue`)
renders the catalog: each cue row has a `▶` audition button, a `∿` button that
opens `SynthEditor.vue`, and its id/description (with a ◆ marker when the id has
an override); a header shows the saved-override count with **Copy all saved** /
**Clear all**, and a miss-cues section lists the four global cues.
`SynthEditor.vue` is a modal laid out like a synth:

- a per-layer tab strip — each layer has **its own `×`**, plus `+ tone` / `+ noise`;
- **oscillator** controls (waveform picker + `from`/`to` knobs), **envelope**
  (`delay`/`attack`/`decay` knobs, level slider, envelope SVG) and **filter**
  (type, cutoff/sweep, Q);
- a live, two-way **JSON** view, a **Play** button with a **loop** checkbox
  (auto-starts, restarts on edit, stops on uncheck/close), and
  **Copy entry** / **Copy all** / **Reset**.

`Knob.vue` is a reusable rotary dial (vertical drag, Shift for fine, wheel,
arrow keys, double-click reset, optional log scale) with a numeric input. Edits
are saved automatically (debounced) and applied live; the header badge shows
`built-in` / `override (code)` / `override loaded (saved)`. **Reset** clears the
local override; **Copy all** yields the whole `VOICE_OVERRIDES` block to commit
in one paste.

---

## 12. File index

```
src/
  main.ts                      createApp bootstrap
  App.vue                      owns Game, snapshot polling, layout, HUD, hotkeys
  style.css                    all UI styling
  audio/
    audio.ts                   AudioEngine: context lifecycle, event dispatch, throttling
    synth.ts                   renders VoiceSpecs to Web Audio nodes
    voices.ts                  VoiceSpec data + fire/hit/explosion/miss voices + VOICE_OVERRIDES
    overrides.ts               runtime override store (localStorage) + resolveSpec + copy formatters
    sounds.ts                  canonical cue ids + registry + event->cue mapping
    catalog.ts                 pure view-model: piece stats + cue ids for the panel
  ecs/
    world.ts                   Entity, defineComponent, World
    components.ts              component interfaces + store handles
    events.ts                  EventType, EventRecord, EventBus
    pipeline.ts                System, Pipeline
    types.ts                   SimContext, Commands, TeamRuntime
    systems/
      index.ts                 createPipeline()
      spawn.ts                 entry-lane deploy
      targeting.ts             occupancy rebuild + acquisition
      orders.ts                Stance/Order -> Motion.goal
      pathfinding.ts           budgeted geometry A*
      movement.ts              cell claim + interpolated motion
      combat.ts                weapon cooldown + fire
      projectile.ts            trajectories + impact
      damage.ts                HP, Dead, kill credit
      death.ts                 FX + bookkeeping
      cleanup.ts               destroy queue + FX ageing
      advance.ts               idle-killer chess capture step
  game/
    types.ts                   TeamId, Vec2, Geometry, dirs, resolveGeometry
    constants.ts               FIXED_DT, budgets, teams, timings
    math.ts / rng.ts           helpers / seeded PRNG
    coords.ts                  chess-style square names (a1, ...)
    board.ts                   terrain defs, Board, MapData
    boards.ts                  board generation, initial armies, sizes
    geometry.ts                moveDestinations, fireCells, lineClear
    occupancy.ts               Cell -> entity map
    pathfind.ts                geometry A* + memoized reachableCells flood fill
    queue.ts                   order queue: anchor/plan/rechain/promote/markers
    pieces.ts                  Piece/Weapon/Projectile defs, weaponVision
    factory.ts                 createPiece
    position.ts                SavedPosition serialize/validate/restore
    record.ts                  seed+inputs GameRecord, Recorder, deterministic replay
    trace.ts                   per-turn piece trace types + labels
    transcript.ts              LLM-readable per-game transcript
    analysis.ts                per-game gap flags + batch summary
    studyPrompt.ts             reusable "analyse these games" clipboard prompt
    study.ts                   StudyController: watchable batch on the live board
    shorthand.ts               compact read-oriented position dump for LLMs
    settings.ts                persisted UI/session preferences (localStorage)
    storage.ts                 localStorage save slots
    game.ts                    Game facade + loop + GameSnapshot + runTicks
  render/
    camera.ts                  centre-based camera with fit floor
    terrain.ts                 bakeTerrain
    overlays.ts                pure firingLine/routePolyline segment data
    renderer.ts                canvas draw pipeline + overlays
  components/
    Toolbar.vue BoardView.vue PiecePanel.vue ReinforcementBar.vue StatsBar.vue EventLog.vue SoundPanel.vue SynthEditor.vue Knob.vue StudyPanel.vue
tests/
  unit/                        logic, systems, Game integration, perf guards,
                               settings/events + audio (fake AudioContext)
  render/                      overlays + mock-2D-context renderer strokes
  e2e/                         Playwright interaction + canvas pixel probes
```
