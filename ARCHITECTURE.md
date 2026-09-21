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
        StatsBar.vue        BoardView.vue ──renders──▶ canvas
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
| `Intent` | `{ mode, dest, player }` | `move` / `fight` / `hold` |
| `Target` | `{ entity, retargetAt }` | current acquisition |
| `Weapon` | `{ left }` | seconds until next shot |
| `Motion` | `{ goal, reserved, path, from/to, travel, elapsed, moving, cooldown, arrived, replanAt, blocked, steps, movedThisTurn }` | grid movement + render interpolation; `reserved` is the cell being entered |
| `Projectile` | `{ team, damage, ttl, trajectory, splash, radius, color, target, owner, waypoints, waypointIndex }` | |
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
  already moved, and either has no goal or no route. In-flight moves are awaited,
  so turns settle on squares; `TURN_MAX_TICKS = 60` is the ceiling, after which
  `snapMoves()` lands stragglers. `finishTurn()` then pauses and stores the start
  snapshot + tick count.
- `replayTurn()` restores that snapshot and re-runs the recorded number of ticks.
  Because the simulation is deterministic, replay returns to the exact same end
  state. `World.capture()/restore()` does a deep `structuredClone` of every
  component store; `Rng.getState()/setState()` restores the PRNG.
- `togglePause()` cancels an active turn; `stepOnce()` cancels turn/replay.

### Team control & game modes

`TeamRuntime.controller` is `'human'` or `'ai'`, set from `gameMode`
(`human-vs-ai`, `ai-vs-ai`, `human-vs-human`) and `playerTeam`. The `ai` system
only auto-manages AI teams (rally/engage). Human pieces default to `hold` and
act solely on player `Intent`s, while still firing autonomously via combat.
The toolbar shows the mode and a `You: Blue · Red ai` badge.

`SimContext` (`src/ecs/types.ts`) is the shared mutable context passed to every
system: `world`, `bus`, `board`, `rng`, `tick`, `dt`, `cmds`, `teams`,
`occupancy`, `pathBudget`, `verbosePhases`.

System order (`createPipeline()` in `src/ecs/systems/index.ts`):

```
spawn → targeting → ai → pathfinding → movement → combat
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

### Pathfinding — `src/game/pathfind.ts`

A* over the graph induced by a piece's **movement geometry**, with terrain move
costs and a Chebyshev heuristic. Occupancy is ignored during planning; the
movement system waits and re-plans if a step is actually blocked. If the goal is
unreachable it returns the best-effort partial route to the closest reached cell.

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
- **targeting** — rebuilds occupancy, then acquires the nearest enemy within the
  piece's `weaponVision` (independent of LOS) and re-acquires periodically.
- **ai** — translates `Intent` into `Motion.goal`: `hold` clears the goal,
  `move` uses `intent.dest`, `fight` advances on the current target (rallying to
  `intent.dest` or the enemy lane when no target is in sight).
- **pathfinding** — budgeted A* (`PATH_BUDGET_PER_TICK`) over the piece's
  movement geometry, with other pieces passed in as blockers (excluding the
  piece itself). Unreachable goals fall back to the nearest reachable cell.
- **movement** — consumes `Motion`. `Cell` stays at the **origin** and
  `Motion.reserved` claims the destination while the piece animates into it;
  the origin is only released on arrival. Before each step it re-validates that
  the next route cell is a legal one-move destination for the piece's geometry
  given live occupancy, so slides stop at the first piece/wall and only leaps
  pass over blockers. Two pieces can never share a cell, and there is no visual
  cross-through. During a turn, a piece is skipped once `movedThisTurn` is set
  (one move per turn); travel time scales with the slide length so a rook's
  multi-cell move reads clearly.
- **combat** — ticks `Weapon.left`; when ready, checks the target is inside
  `fireCells` and spawns a projectile, then resets the cooldown.
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
`splash`, `color`.

Shipped chess set: pawn, knight, bishop, rook, queen, king. `weaponVision`
derives target-acquisition radius from the weapon geometry. The pawn fires both
forward diagonals at range 1.

---

## 8. Rendering — `src/render/`

The renderer is a read-only view. `Game.onFrame` is set by `BoardView.vue` to
call `renderer.draw(game)` each animation frame.

Draw order: clear → baked terrain (`terrain.ts`, keyed by
`boardId:WxH:terrainVersion:grid`) → camera transform → spawn zones → whole-board
overlays (intentions / ranges / targets) → selected-piece overlays (move cells,
firing cells, dashed path, destination marker) → pieces (shadow, tinted glyph,
health bar, selection ring) → target lines → projectiles (dot, glow, remaining
waypoint polyline) → FX rings → border.

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
Control hints render as a vertical list in a strip below the board (`.hints`),
not over the canvas.

`GameSnapshot` fields (`src/game/game.ts`): `running paused tick fps tps speed
boardId boardSize boardSizes teams timings events eventCount shots kills
warnings selected selectedLines counts winner overlays hudVisible playerTeam
turnActive canReplay replaying terrainVersion`.

| Component | Responsibility |
| --------- | -------------- |
| `Toolbar.vue` | board size, turn/pause/step/replay, speed, order mode, overlay toggles, HUD toggle, reset |
| `BoardView.vue` | canvas + Renderer; drag box-select (ctrl/cmd-click adds), shift/middle-drag pan, wheel zoom, right-click order; draws the selection rectangle |
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
  for rook (files/ranks) and bishop (diagonals), a circle for queen/king, a
  forward half-disc for the pawn, and 8 dots for the knight.
- **Path** — dashed gold route; **destination** crosshair (red when blocked);
  **target** thin line + reticle.
- Army scope shows paths, destinations and targets; reach/attack shading and
  range arcs are reserved for selected pieces so the board stays readable.

`overlays` flags: `grid`, `health`, `myOrders`, `enemyPlans`, `moveCells`,
`attackCells`, `rangeArcs`.

Keyboard: `1`/`2`/`3` order mode, `space` turn, `p` pause, `s` step, `r` replay,
`o` my orders, `e` enemy plans, `h` HUD, `Esc` clear selection.

---

## 10. Determinism & performance

- All randomness goes through `Rng` (`mulberry32`). The event stream is a
  repeatable trace for a given board and input timeline.
- Performance levers: occupancy map for O(1) cell lookups, budgeted A*,
  baked terrain, shallow refs + 120ms snapshots, a single rAF loop.
- Avoid: `Math.random()` in sim code, mutating the world from the renderer or
  Vue, putting wall-clock time into gameplay.

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
      ai.ts                    Intent -> Motion.goal
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
    board.ts                   terrain defs, Board, MapData
    boards.ts                  board generation, initial armies, sizes
    geometry.ts                moveDestinations, fireCells, lineClear
    occupancy.ts               Cell -> entity map
    pathfind.ts                geometry A*
    pieces.ts                  Piece/Weapon/Projectile defs, weaponVision
    factory.ts                 createPiece
    game.ts                    Game facade + loop + GameSnapshot
  render/
    camera.ts                  centre-based camera with fit floor
    terrain.ts                 bakeTerrain
    renderer.ts                canvas draw pipeline + overlays
  components/
    Toolbar.vue BoardView.vue ReinforcementBar.vue StatsBar.vue EventLog.vue
```
