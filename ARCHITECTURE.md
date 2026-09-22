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
| `Order` | `{ kind, dest, target, reachable, resumeTarget, resumeTurn, queue }` | active step is one-shot `none` / `goto` / `attack`; `reachable` marks an attack target that is positionally attainable; `resumeTarget`/`resumeTurn` park an attack while a goto suspends it; `queue` holds queued `OrderStep`s (`goto`/`attack` with a pre-planned display path) that promote into the active step in sequence |
| `Target` | `{ entity, retargetAt, lastAttacker, underFireUntil }` | current engagement + retaliation bookkeeping |
| `Weapon` | `{ left }` | seconds until next shot |
| `Motion` | `{ goal, reserved, path, from/to, travel, elapsed, moving, cooldown, arrived, replanAt, blocked, steps, movedThisTurn }` | grid movement + render interpolation; `reserved` is the cell being entered |
| `Projectile` | `{ team, damage, ttl, trajectory, splash, radius, size, shape, spin, color, target, owner, waypoints, waypointIndex }` | |
| `Fx` | `{ ttl, maxTtl, radius, color }` | render-only impact/explosion |
| `Dead` | `true` | marker processed by the death system |

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
- `undoTurn()` (key `u`) and `redoTurn()` (key `r`) step backwards/forwards
  through that history, restoring whole turn-boundary states; beginning a new
  turn replaces any undone branch. `replayTurn()` (key `y`) restores the last
  completed turn's start snapshot and re-runs the recorded ticks at 0.5× speed
  (moves read one by one), returning to the exact same end state. Live turns run
  at 0.5× too.
  `World.capture()/restore()` does a deep `structuredClone` of every component
  store; `Rng.getState()/setState()` restores the PRNG. During replay
  `ctx.turnActive` is forced true so the one-move-per-turn gate matches the
  original turn — otherwise the replay would diverge.
- `togglePause()` cancels an active turn; `stepOnce()` cancels turn/replay.
- **Victory** is chess-style: a team is defeated the moment it has no living
  king (`updateWinner`). When a king falls during a live turn the turn is closed
  (so the history boundary is the pre-fatal state), a `win` event is emitted and
  the sim freezes: `beginTurn`/`stepOnce`/`togglePause`/`replayTurn` become
  no-ops and the toolbar disables those controls. `undo` stays enabled and
  restores the `winner` (part of `TurnState`) back to `null`, reopening play;
  `redo` replays the fatal turn. If both kings fall on the same tick it is a
  draw and play continues.

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
`occupancy`, `pathBudget`, `verbosePhases`, `turnActive`.

System order (`createPipeline()` in `src/ecs/systems/index.ts`):

```
spawn → targeting → orders → pathfinding → movement → combat
      → projectile → damage → death → cleanup
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
`resolveGeometry`.

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
  nearest enemy already in firing geometry; `attack` auto-acquires the nearest
  enemy within `weaponVision`, biased toward damaged ones; `move` only targets
  its `lastAttacker` while `underFire`. AI-controlled teams always behave as
  `attack`. When an attack order ends (target gone) the order clears; the stance
  is never changed by orders, so the piece reverts to its explicit policy.
- **orders** — turns stance/order into `Motion.goal` for every piece (human or
  AI): an `attack` order pursues the target (or stops to fire when in geometry);
  a `goto` order advances toward the objective (best effort); autonomous `attack`
  pursues in a leash, and rallies only for AI teams; a low-HP attacker keeps its
  shot — it holds when it can already hit the target and is safe, steps to the
  nearest firing cell that escapes the current threats' fire geometry (the target
  and its last attacker) when that reduces incoming damage, and only retreats
  outright when the target is out of range. Anything other than `attack` clears
  the goal. Pursuit picks a goal with the
  same chain as `Game.planAttack` (`previewFiringCell` → `closestEmptyCell` →
  target) so the executed route cannot diverge from the preview; a firing position
  beats piling onto the occupied target, and a positionally unreachable target
  (e.g. a bishop on the other colour) still routes to the closest reachable square
  instead of a straight line to the target.
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
  threatened king become **bodyguards** and `pursue` the top-ranked threat; the
  rest of the army keeps rallying.
  A `goto` that carries a `resumeTarget` is a suspended attack: on arrival (or
  once stalled) it arms `resumeTurn = ctx.turn + 2` and **regroups** — holding, or
  kiting one step back while under fire (`kiteCell`, which raises distance while
  keeping the threat in firing geometry). It resumes the attack once the window
  has elapsed *and* it is no longer under fire, or clears the order if the parked
  target is gone. `ctx.turn` is a monotonic turn index captured in `TurnState` so
  undo/redo/replay stay deterministic.
  When the active step finishes — a goto arrival, an attack target's death, or a
  goto whose destination the piece's movement geometry can *never* reach
  (`destReachable` via `reachableCells`) — `promoteNext` (`src/game/queue.ts`)
  shifts the first queued step into the active slot instead of clearing, and
  `rechainQueue` re-plans the remaining steps from the piece's new cell. A
  waypoint merely blocked by pieces is reachable and therefore **waits**, exactly
  like a single goto order, so a queue is never lost to a temporary jam; an
  unreachable waypoint is skipped with a `warn` event. A promoted goto keeps any
  `resumeTarget`, so a suspended attack resumes only after the whole queue has
  drained; a promoted attack clears it.
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
  opponent's cumulative `movesMade`, so it cannot out-move the player. A
  player-issued order (`Order.kind !== 'none'`) bypasses the budget; only pieces
  whose team is under human control can be commanded (your own team in
  Human-vs-AI, both teams in Human-vs-Human, none in AI-vs-AI).
- **combat** — ticks `Weapon.left`; when ready, fires at `Target.entity` if it is
  inside `fireCells`. Because targeting decides whether a target exists at all,
  combat inherits the stance/order fire policy automatically.
- **projectile** — advances waypoints at `speed`; applies splash/direct damage on
  impact via `cmds.damage`; `line` shots are stopped by walls; jump/arc ignore
  blockers.
- **damage** — applies damage with ±10% seeded variance, marks `Dead`, and
  credits kills.
- **death** — spawns an `Fx`, updates losses, queues destruction.
- **cleanup** — destroys queued entities and ages FX.

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
it and is not a target.

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
reaches that floor it snaps `x/y` back to the board centre, so a panned board
always re-fits cleanly. `resize()` calls `updateLimits` to recompute the floor
and clamp the current zoom. `maxZoom = 8` gives comfortable close-up range on
large displays. `zoomAt` is cursor-anchored; wheel zoom is exponential on
`deltaY` (`exp(-delta * 0.0008)`, clamped 0.7–1.4) for a gentle trackpad feel.

---

## 9. Vue UI and snapshot contract

`App.vue` constructs one `Game` (which starts **paused**), starts the frame loop,
and copies `game.snapshot()` into a `shallowRef` every
`SNAPSHOT_INTERVAL_MS = 120`. The simulation never depends on Vue reactivity.
Control hints + the piece panel + hover readout live in always-visible side rails
(left/right), independent of the HUD toggle, so they never cover the board. The
HUD starts hidden; `h` toggles it.

`GameSnapshot` fields (`src/game/game.ts`): `running paused tick fps tps speed
boardId boardSize boardSizes teams timings events eventCount shots kills
warnings selected selectedLines counts winner overlays hudVisible playerTeam
turnActive canReplay canUndo canRedo replaying turnProgress replayProgress
pendingCommand selectionCount stanceSummary pieceInfo terrainVersion`.

| Component | Responsibility |
| --------- | -------------- |
| `Toolbar.vue` | board size, turn/pause/step/undo/redo/replay, speed, overlay toggles, HUD toggle, reset |
| `BoardView.vue` | canvas + Renderer; left-click/box-select, shift-click adds, `m`/`a` prefix commands, context right-click order, shift/middle-drag pan, wheel zoom; draws the selection rectangle |
| `PiecePanel.vue` | focused piece properties (health, reload, stance, target, order, queue, movement) with selection-wide stance buttons and clear-orders |
| `ReinforcementBar.vue` | per-team piece icons; click deploys from an entry lane |
| `StatsBar.vue` | tick/fps/tps/pieces/shots/kills/entities/selected/winner |
| `EventLog.vue` | Event stream (filter chips), Systems timings, Inspector for the selection |

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
  target reticle (circle + cross).
- **Target** — an ordered attack (`order.kind === 'attack'`) draws a red firing
  line + reticle and rings the victim red; an auto-acquired or retaliation target
  (`Target.entity` under Attack stance / return fire) draws the same indicator in
  **amber**, so an autonomous engagement is as legible as an ordered one while
  staying distinct.
- Army scope shows paths, destinations and targets; reach/attack shading and
  range arcs are reserved for selected pieces so the board stays readable.

`overlays` flags: `grid`, `health`, `myOrders`, `enemyPlans`, `moveCells`,
`attackCells`, `rangeArcs`, `reload` (firing-recharge bars over pieces).
`rangeArcs` is off by default; movement cells, attack cells and range arcs are
drawn for selected pieces only; the health and recharge bars are drawn for every
piece (each gated by its toggle), and army scopes show paths/goals/targets.

Ordering is BAR-style and **context-sensitive** — there is no global order mode:

- **Left-click** selects; shift-click adds; a drag box-selects (`Game.selectRect`).
- **Right-click** issues an order for every selected commandable piece:
  enemy square → attack, empty square → goto, friendly square → no-op. A repeat
  click (or Shift+right-click) **appends** a queued step (`Game.appendStep`), so
  `move, move, attack` can be planned with repeated right-clicks; only the first
  click on an unplanned piece replaces/creates the active order, and `c` clears
  the whole plan. A move on an un-queued attacker still suspends/regroups rather
  than queueing behind the attack.
- **`m` / `a` + left-click** arms a transient **pending command**
  (`Game.pendingCommand`) to force a move/attack: `Game.orderAt(cell, command)`.
  The prefix is consumed by the click unless **Shift** is held (kept armed to
  queue several); a plain left-click selects and clears it. `a` on an empty or
  friendly square is a no-op (a warning is emitted).
- The queued remainder is drawn by the renderer as a dim dashed chain with
  numbered waypoint markers (`queueMarkers`), and a queued attack shows a dim
  threat line to its target.
- Pieces start with no stance and show no badge; only an explicit stance or an
  active attack order draws one. Toolbar selects/checkboxes blur after use so the
  global shortcuts always reach the window.
- Hovering computes a per-selected-piece order preview (`Game.setHover`, drawn as
  faint ghosts) and a cell readout.
Chess coordinates (`coordName`) label the board margins.

### Position save / load / export

The right rail's **position** section saves and restores whole battles. The unit
of transfer is `SavedPosition` (`src/game/position.ts`): terrain, every component
store (via `World.capture`, so entity ids and references survive), RNG state,
tick/turn, teams, mode and overlays. It is plain JSON and versioned
(`POSITION_VERSION`); `validatePosition` rejects unknown versions/stores before
anything is mutated.

- `Game.exportPosition()` / `Game.importPosition(data)` build and apply it.
  Import rebuilds the `Board`, restores the world (mapping serialized store names
  back through a registry), resets all transient turn/replay/selection state,
  pauses and rebuilds `ctx`.
- **Save/Load**: named slots in `localStorage` (`src/game/storage.ts`), keys
  `bar-chess.positions.index` and `bar-chess.positions.<id>`; a same-named save
  overwrites. Load/Delete confirm first.
- **Copy / Export / Import**: the **Copy position JSON** button and **Export
  JSON** emit the same `SavedPosition` (so copied/exported JSON can be
  re-imported); **Import JSON** reads a file. `Game.toDebugJson()` remains the
  terse debug view.

`Rng.getState()` is canonicalized to 32 bits so a save/restore produces a
byte-identical stream (see §10).

### Settings persistence

UI/session preferences survive a reload (and a dev-server restart) via
`src/game/settings.ts`: `Game.settings()` snapshots them and `Game.applySettings`
applies a validated patch. Stored under `bar-chess.settings`:
`overlays` (all flags), `hudVisible`, `speed` and `gameMode` (per-piece stance
lives in the world, not here). `loadSettings` drops malformed or out-of-range fields (unknown
overlay keys, non-boolean flags, speeds outside `SPEEDS`, unknown modes), and
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

- **Copy shorthand** copies the position plus a one-line `# fmt:` legend.
- **Copy for LLM** prepends `LLM_PREAMBLE`, a constant explaining the game,
  geometry, turn model and every field, for the first message of a conversation.
- Both go through `Game.shorthand()` / `Game.llmShorthand()`, available on
  `window.game` in dev. The shorthand is read-only — `SavedPosition` JSON stays
  the import/round-trip format.

Keyboard: `m`/`a` arm a move/attack command (then left-click; Shift keeps it
armed), `space` turn, `p` pause, `s` step, `u`/`r` undo/redo, `y` replay,
`c`/`Backspace` clear orders, `o` my orders, `e` enemy plans, `h` HUD, `Esc`
cancel the pending command else clear the selection. `Game.orderAt(cell,
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
selection. `space` is ignored while a turn/replay is running; `u`/`r` undo/redo
completed turns.

Team colour is Orange vs Blue; **red marks an ordered attack**: the firing chain,
the Attack stance badge, and the ring around a piece targeted by an explicit
attack order. **Amber marks autonomous engagement**: the ring/line around an
auto-acquired or retaliation target (Attack stance, return fire, or a suspended
attack's parked target). Pieces no longer draw a default ring. Target rings/chains
are computed from **scoped** pieces only (selection + `my orders` / `enemy plans`),
so they never float permanently. Every piece draws a thin health
bar and a **plain red** reload bar, each hideable via its `health` / `reload`
overlay toggle (tile-relative so the bars stay inside the cell); all pieces render
at a uniform size.

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
  speed ×1 a healthy game shows `tps ≈ 30`; during a turn/replay (0.5×) it is
  ~15. `tps = 0` simply means paused.
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

## 11. File index

```
src/
  main.ts                      createApp bootstrap
  App.vue                      owns Game, snapshot polling, layout, HUD, hotkeys
  style.css                    all UI styling
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
    Toolbar.vue BoardView.vue PiecePanel.vue ReinforcementBar.vue StatsBar.vue EventLog.vue
tests/
  unit/                        logic, systems, Game integration, perf guards
  render/                      overlays + mock-2D-context renderer strokes
  e2e/                         Playwright interaction + canvas pixel probes
```
