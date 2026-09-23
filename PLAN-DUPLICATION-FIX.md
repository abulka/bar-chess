# Bar Chess — Duplication Fix Plan

Handoff plan for a future session. Goal: collapse the duplicated movement /
attack-rule logic into single sources of truth **without changing behaviour**.
Every phase is a pure refactor behind the existing test suite.

## Context

An architecture review found the chess-rule primitives are already well
centralised in `src/game/`:

- `types.ts` — `Geometry` union + `resolveGeometry` (team mirroring, one place)
- `pieces.ts` — declarative `PIECES` / `WEAPONS` / `PROJECTILES` tables
- `geometry.ts` — `moveDestinations`, `fireCells`, `lineClear`, `attackApproachCells`
- `pathfind.ts` — A* + memoized `reachableCells`, built on `moveDestinations`
- `approach.ts` — `firingPositionExists`, `previewFiringCell`, `closestEmptyCell`

Humans and AI both funnel through these. That part is healthy.

The problem is a handful of **copied algorithms** that must be kept in sync by
convention. The comments in the code even admit it ("mirrors ... exactly so the
executed route never diverges", "kept here so the renderer need not depend on an
ECS system module"). These are the drift risks.

Nothing here is user-visible. The value is: one place to change a rule, and no
"forgot to update the copy" bugs.

## Constraints

- **Behaviour-preserving.** No rule changes. Existing 242 unit/render + 19 e2e
  tests are the gate; add characterisation tests where coverage is thin.
- **Strict TS**, single runtime dep (Vue). Match surrounding code style
  (the codebase is heavily commented — mirror the local file's style).
- Keep `src/game/` free of ECS dependencies (it only knows `World` via a type
  import in `healing.ts`; do not deepen that).
- Preserve performance characteristics called out in `ARCHITECTURE.md` §10/§13:
  the reachability flood fill is intentionally allocation-free, and pathfinding
  is budgeted. Do not regress these.

## Verification gate (run after every phase)

```
npm run test:run      # unit + render
npm run build         # vue-tsc typecheck + vite build
npm run test:e2e      # playwright
```

Baseline must be green **before** starting. Record counts so a stall is obvious.

---

## Phase 1 — Attack goal selection is duplicated 4×

**Severity: high.** This is the biggest and most likely-to-drift copy.

The same policy is spelled out four times:

| Site | File:line | Uses |
| - | - | - |
| `Game.planAttack` | `src/game/game.ts:1415-1446` | live `blocked` for goal, `planOccupied` (target only) for path |
| `Game.orderSettled` | `src/game/game.ts:1027-1034` | `never` |
| `pursue` (AI) | `src/ecs/systems/orders.ts:82-95` | live `occupied` |
| `planStep` (queue preview) | `src/game/queue.ts:60-66` | `NEVER` |

Each computes, in this order:

1. `reachable = firingPositionExists(board, from, targetCell, moveGeom, weaponGeom, team)`
2. if the target is already in weapon geometry → hold / no goal
3. else `goal = previewFiringCell(...) ?? closestEmptyCell(...) ?? targetCell`

The "already in geometry" test is also repeated as `containsCell(fireCells(...))`
(`game.ts:1427`, `orders.ts:71`, and the implicit holds in the other two).

### Refactor

Add to `src/game/approach.ts` (it already owns `previewFiringCell` /
`closestEmptyCell` and depends on `geometry` + `pathfind`):

```ts
/** True when `targetCell` is inside the weapon geometry fired from `from`. */
export function inFiringGeometry(
  board: Board, from: Vec2, targetCell: Vec2,
  weaponGeom: Geometry, team: TeamId, occupied: OccupiedFn,
): boolean

export interface AttackPlan {
  /** Positionally reachable at all (ignores other pieces). */
  reachable: boolean
  /** Target is already hittable from `from` — caller should hold and fire. */
  inRange: boolean
  /** Goal cell to walk to; equals `targetCell` when nothing better exists. */
  cell: Vec2
}

/**
 * The single attack-navigation policy. Goal selection only: the caller keeps
 * its own occupancy for pathfinding (live vs theoretical), which legitimately
 * differs between preview and execution.
 */
export function attackPlan(
  board: Board, from: Vec2, targetCell: Vec2,
  moveGeom: Geometry, weaponGeom: Geometry, team: TeamId, occupied: OccupiedFn,
): AttackPlan
```

Then rewrite each call site to consume it:

- `pursue` (`orders.ts`): `const p = attackPlan(...); return p.inRange ? null : p.cell`.
  Delete local `inFiringGeometry` (`orders.ts:63-72`) if no other caller.
- `orderSettled` (`game.ts:1027-1034`): use `attackPlan(..., never)`; keep the
  "reachable → not settled" early return using `plan.reachable`.
- `planAttack` (`game.ts:1415-1446`): use `attackPlan(..., blocked)`; keep its
  own `planOccupied` path call and the live `fireCells` hold check replaced by
  `plan.inRange`.
- `planStep` (`queue.ts:60-66`): use `attackPlan(..., NEVER)`; keep the
  `if (!targetCell)` guard.

### Notes / gotchas

- `previewFiringCell` and `closestEmptyCell` take an `occupied` fn; pass the
  caller's through. Do **not** unify the pathfinding occupancy — the live vs
  theoretical split is deliberate (`ARCHITECTURE.md` §5/§6).
- `attackPlan` returns a `Vec2`; `game.ts` stores plain `{x,y}` goals already.
- Avoid new per-call allocations beyond what the existing three helpers do.

### Tests

- New `tests/unit/approach.spec.ts` cases for `attackPlan`: in-range hold,
  firing-cell goal, unreachable fallback to closest-empty, last-resort target.
- Existing `orders-system.spec.ts`, `game.integration.spec.ts`, `queue.spec.ts`
  cover the four call sites end-to-end — they must stay green untouched.

---

## Phase 2 — `computeReachable` re-implements movement stepping

**Severity: medium** (correctness drift risk + the pawn rule in two places).

`pathfind.ts:129-188` (`computeReachable`) hand-rolls the slide / leap / pawn
neighbour expansion instead of using `moveDestinations`. The pawn home-rank rule
therefore exists twice:

- `geometry.ts:63` — `const advance = from.y === pawnHomeRank(board, team) ? g.forward : 1`
- `pathfind.ts:180` — `const advance = cy === pawnHomeRank(board, team) ? g.forward : 1`

Also `pathfind.ts` imports `moveDestinations` (`:2`, used by `findPath`) yet
`computeReachable` bypasses it.

### Refactor

Add an allocation-free core to `src/game/geometry.ts`, then express both
`moveDestinations` and `computeReachable` on it:

```ts
/**
 * Visit every legal one-move destination of `from` without allocating. Shared
 * by the collecting `moveDestinations` and the reachability flood fill so the
 * slide/leap/pawn rules (incl. pawnHomeRank) live in exactly one place.
 */
export function forEachMoveDestination(
  board: Board, from: Vec2, geom: Geometry, team: TeamId,
  occupied: OccupiedFn, ignoreOccupancy: boolean,
  visit: (x: number, y: number) => void,
): void
```

- `moveDestinations` becomes a thin wrapper that pushes to `Vec2[]`.
- `computeReachable` calls it with `occupied = NEVER`, `ignoreOccupancy = true`,
  and its `visit` marks `seen` + enqueues. This removes the duplicated
  slide/leap/pawn block (`pathfind.ts:157-185`).
- Drop the now-unused `pawnHomeRank` / `resolveGeometry` imports from
  `pathfind.ts` if applicable.

### Risk: performance

`ARCHITECTURE.md` §10/§13 promise an allocation-free flood fill and a small LRU
reach cache. `forEachMoveDestination` allocates nothing per call (callback
only), so this holds — but **profile it**:

- `tests/unit/perf.spec.ts` is the guard; run `npm run test:run` and compare.
- If the callback indirection regresses the flood fill materially, fall back to
  keeping the flood fill hand-rolled but extract only a tiny shared helper for
  the pawn advance decision / step legality. The goal is one pawn rule, not
  necessarily one loop.

### Optional (same phase, only if cheap)

`fireCells` (`geometry.ts:76-118`) mirrors the same slide/leap/pawn shape with
different termination (`blocksVision`, first blocker *included*, `pawnFireDirs`).
A parallel `forEachFireCell` core would remove a second copy, but the semantics
differ enough to be a separate change. Defer unless the diff is obvious.

### Tests

- Existing `tests/unit/pathfind.spec.ts` caching/invalidations + `geometry.spec.ts`
  are the safety net. Add a parity test if needed: reachable set from
  `computeReachable` equals the transitive closure of `moveDestinations` on a
  few boards.

---

## Phase 3 — Small consolidations (low risk, do together)

### 3a. `kingOf` duplicated

- `src/game/healing.ts:27` — `kingOf(world, team)`, comment admits it
  "Mirrors the lookup in the king-defense system, kept here so the renderer need
  not depend on an ECS system module."
- `src/ecs/systems/kingDefense.ts:22` — `kingOf(ctx, team)`, identical body.

Fix: pick one canonical `kingOf(world: World, team: TeamId)` in `src/game/`
(e.g. a small `src/game/army.ts`, or keep in `healing.ts` and have
`kingDefense` import it — the latter is smaller but makes defense depend on
healing). `kingDefense` callers pass `ctx.world`. Remove the duplicate.

### 3b. Back-rank lane midpoint duplicated

- `preservation.ts:124 homeCell` — middle of the team's *own* lanes.
- `orders.ts:137 rally` — middle of the *enemy* lanes.
- `spawn.ts:7` also walks `lanes[team]`.

Fix: one `laneMidpoint(board, team): Vec2 | null` helper (in `board.ts` next to
`lanesFor`, or `geometry.ts`); `rally` = `laneMidpoint(board, enemyTeam)`,
`homeCell` = `laneMidpoint(board, team)`.

---

## Phase 4 — Optional / accept-as-is

- **Pawn orientation re-derived in the renderer.** `renderer.ts:593-605` computes
  the pawn's half-plane arc from `resolveGeometry`. It is read-only presentation
  and depends on `def.move`, so leaving it is defensible. Only worth touching if
  the resolved-pawn `dy` is exposed as a tiny `pawnForward(board, team)` /
  `resolved.dy` helper from `geometry.ts`.
- **AI policy constants scattered** (`preserveThreshold` `orders.ts:20`,
  `isValuable` `preservation.ts:119`, `KING_GUARD_RADIUS` / `KING_THREAT_RADIUS`
  in `kingDefense.ts`). These are *policy*, not rules, and are cohesive per
  system. **Out of scope** for this plan; a rules-bank refactor (see `PLAN.md`
  "Rules are experiments") would address them separately.
- `orders.ts` is a 383-line decision tree — a readability hotspot, but not a
  duplication bug. Leave unless a separate refactor is scheduled.

---

## Additional scan results (fallow 2.96.0)

Beyond the four phases above, a full static scan was run. Reproduce with:

```
npx fallow dead-code --format json --quiet   # unused exports/types/members
npx fallow dupes --format json --quiet       # clone groups (4.7% of src lines)
npx fallow health --format json --quiet      # complexity hotspots
```

Headline numbers: **23 unused exports, 1 unused type, 9 unused class members;
25 clone groups (787 duplicated lines, 4.7%); top hotspots in `game.ts`,
`orders.ts`, `renderer.ts`.** The new phases below are ordered by
value/effort — 5, 6, 8 and 10 are cheap and high value; 7 and 9 are medium;
11 is a separate larger effort.

---

## Phase 5 — Dead exports and surface area (low effort, high confidence)

Delete or wire up. Each item was manually verified with `rg`; entries marked
"un-export" are used *inside* their own file but never imported.

**Delete (zero references):**

| Symbol | Location | Note |
| - | - | - |
| `cellKey` | `src/game/geometry.ts:17` | superseded by `cellIndex` (Phase 6) |
| `boardConfigFromData`, `defaultBoard`, `boardSizeOf` | `src/game/boards.ts:69,73,78` | no callers |
| `weaponDef` | `src/game/pieces.ts:210` | callers use `WEAPONS[key]` directly |
| `hasOverrides` | `src/audio/overrides.ts:129` | no callers |
| `EventBus.unsubscribe` | `src/ecs/events.ts:100` | `subscribe()` already returns a disposer |
| `EventBus.clear` | `src/ecs/events.ts:114` | no callers |
| `Rng.pick` | `src/game/rng.ts:30` | no callers |
| `AudioEngine.isEnabled` | `src/audio/audio.ts:58` | no callers |
| `AudioEngine.setVolume` | `src/audio/audio.ts:86` | no callers |
| `StudyController.buildPrompt` | `src/game/study.ts:225` | `StudyPanel.vue:36` calls `buildStudyPrompt` directly |

**Un-export (used in-file only):** `allOverrides` (`audio/overrides.ts:140`),
`describeGeometry` (`audio/catalog.ts:51`), `projectileShape`
(`audio/sounds.ts:48`), `MissCause` (`audio/sounds.ts:20`), `stepEnd`
(`game/queue.ts:14`), `STUDY_PREAMBLE` (`game/studyPrompt.ts:15`),
`POSITION_VERSION` (`game/position.ts:10`), `RECORD_VERSION`
(`game/record.ts:9`), `advancePolicy` / `focusFirePolicy` / `turtlePolicy`
(`game/study.ts:39,51,80`).

**Wire up instead of deleting:** `TEAM_IDS` (`game/constants.ts:3`) — replace
the six `['red', 'blue']` literals (`game.ts:389,675,1506`;
`renderer.ts:146,879`; `systems/healing.ts:6`) with it.

**False positives — do not delete.** fallow's class-member pass flagged
`Game.selectAt`/`setHover` (`BoardView.vue:92,148`) and
`Board.blocksProjectile` (`projectile.ts:109`). All three are live; class
member findings need manual verification.

---

## Phase 6 — Cell / vector primitive consolidation (low effort, high value)

The same tiny primitives are re-spelled everywhere; `math.ts` is 67% dead and
the rest is reimplemented inline.

**6a. `NEVER` occupied fn — 5 copies.**
`geometry.ts:7`, `pathfind.ts:7`, `queue.ts:11`, `overlays.ts:6`, and a local
`never` at `game.ts:1016`. Export one from `geometry.ts` (it already owns
`OccupiedFn`) and import it.

**6b. Cell index — one helper, ~20 raw expressions.**
Canonical `cellIndex(board, x, y)` (`occupancy.ts:8`) but raw
`y * width + x` is written at `game.ts:1054,1249,1438-39,1468,1484`;
`pathfind.ts:140,145,212-13,248`; `approach.ts:24,48,77`; `targeting.ts:25`;
`orders.ts:59,112`; `spawn.ts:9`; `kingDefense.ts:65`; `shorthand.ts:144`;
`transcript.ts:25`. Replace all with `cellIndex`, then delete the dead
`cellKey` (geometry) and `tileKey` (`math.ts:25`). Consider moving
`cellIndex` next to `Board` since that is the only thing it needs.

**6c. Vector equality — three copies + ~12 inline.**
`math.ts:21 vecEquals` is unused while `analysis.ts:52` and `transcript.ts:19`
each define `sameCell`, and inline `a.x === b.x && a.y === b.y` appears in
`game.ts:1194-95,1241`, `movement.ts:83`, `kingDefense.ts:68,74`,
`advance.ts:49`, `pathfinding.ts:32`, `renderer.ts:278,284`. Adopt `vecEquals`.

**6d. Distance — `dist2`/`dist` unused, reimplemented inline.**
`(dx)**2 + (dy)**2` at `targeting.ts:28,59`, `approach.ts:51,79`,
`study.ts:66`, `pathfind.ts:224,240`, `kingDefense.ts:75`, `game.ts:917`;
`Math.hypot` at `orders.ts:117,122`, `preservation.ts:89,180`,
`kingDefense.ts:156,170`. Adopt `dist2` (comparisons) / `dist` (magnitudes).

**6e. Health ratio.**
`hp.max > 0 ? hp.cur / hp.max : 1` appears at `targeting.ts:62` and
`orders.ts:169`; the `: 0` variant at `game.ts:1611,1650`; raw division at
`renderer.ts:712`. Add one `healthRatio(health, fallback)` helper (mind the
different missing-HP defaults: `1` for AI scoring, `0` for display).

---

## Phase 7 — AI threat scoring duplicated (medium; fallow clone evidence)

fallow clone groups `dup:3c6d9712` (20 lines) and `dup:f1f6430a` (11 lines):

- `kingDefense.ts:132-151` ≈ `preservation.ts:158-175` — the `coverages` map
  over threats (`fireCells` per threat, damage as weight) and `dangerAt`.
- `kingDefense.ts:150-160` ≈ `preservation.ts:174-184` — `minThreatDist`.

`escapeGoal` (`preservation.ts:146-222`) and `aiKingGoal`
(`kingDefense.ts:119-194`) are the same algorithm with different constants:

1. build per-threat firing coverage,
2. `dangerAt(x,y)` = total weight covering the square (+ step-in penalties),
3. `minThreatDist(x,y)`,
4. iterate `moveDestinations`, pick lowest danger / then farthest,
5. decide whether the step actually improves things, else hold.

Differences to preserve: `ADJACENT_PENALTY = 5` + optional `keepsShot` +
cover-seeking in `escapeGoal`; `30` / radius gradient + home bias + standoff in
`aiKingGoal`. `kiteCell` (`orders.ts:103-135`) is a third variant of steps 4-5.

Suggested shape: a new `src/ecs/systems/threatField.ts` exporting
`buildCoverage(ctx, threats, occupied)`, `dangerAt(coverages, threats, x, y,
penalty)`, `minThreatDist(threats, x, y)`, and a `bestSafeStep(options, score,
tiebreak)` used by all three. Start with the two verified clones; leave
`kiteCell` alone unless it drops in cleanly.

Safety net: `orders-system.spec.ts` asserts exact goal cells for escape/kite
scenarios. Run it after every step of this refactor.

---

## Phase 8 — Order / motion lifecycle helpers (low effort, high value)

**8a. Clearing an order is a 4-field block repeated ~11×.**
`game.ts:1086-88,1122-23,1148-50,1213-17`; `targeting.ts:118-121`;
`orders.ts:231-234,267-270,278-280,303-313`; `queue.ts:101-102,109-110`.
Add `clearOrder(order, { keepStance? })` and `clearMotion(motion)` (queue.ts is
the natural home — it already owns `promoteNext`/`rechainQueue`). Watch the two
variants: some clear `dest` too, some keep `resumeTarget`.

**8b. `isAlive(e) && has(e, Cell)` repeated 7×.**
`orders.ts:178,214,284,287`; `targeting.ts:107,138`; `renderer.ts:658`. Add
`hasLiveCell(world, entity)` and use it (the renderer one only checks alive, so
leave it or rename the helper).

**8c. Per-kind policy as data (optional, medium).**
`preserveThreshold(kind)` (`orders.ts:20-33`) and `isValuable(kind)`
(`preservation.ts:119-121`) are kind switches that could be `PieceDef` fields
(`fleeAt`, `valuable`) in `pieces.ts`, matching how movement/weapon already live
as data. Behaviour must stay byte-identical; `orders-system.spec.ts` covers the
thresholds.

---

## Phase 9 — Geometry ray / Bresenham helpers (medium; companion to Phase 2)

fallow found three in-file clones in `geometry.ts`:

- `dup:6995ff0c` — `moveDestinations` slide loop (`37-44`) ≈ `fireCells` slide
  loop (`84-91`).
- `dup:af147570` — `fireCells` slide loop (`88-96`) ≈ pawn loop (`109-117`).
- `dup:63d3b5c7` — `lineClear` (`138-148`) ≈ `cellsBetween` (`174-184`): two
  hand-rolled Bresenhams.

Add `walkRay(board, from, dir, range, blockedAt, visit)` and
`bresenham(a, b, visit)` so ray/line semantics exist once. `moveDestinations`
and `fireCells` then differ only in their stop predicate (`passable` +
occupancy vs `blocksVision` + include-first-blocker). Pair this with the
`forEachMoveDestination` core from Phase 2 rather than doing both twice.

---

## Phase 10 — Test helper extraction (low effort, immediate payoff)

fallow's top duplication families are test setup, not logic:

- `runtime()` + `makeContext()` copied 5×: `advance-system.spec.ts:16-49`,
  `healing.spec.ts:14-45`, `orders-system.spec.ts:14-49`,
  `pathfinding-system.spec.ts:14-49`, `targeting-system.spec.ts:13-44`
  (~98 duplicated lines across the families).
- The `new Game(8)` + `placePiece('queen', …)` + `placePiece('king', …)` duel
  setup is copied across `game.integration.spec.ts:70,243,283`,
  `position.spec.ts:21,49`, `queue.spec.ts:32`.

Move `teamRuntime()` / `makeContext()` into the existing `tests/helpers.ts`, and
add a `duelSetup()` helper (or similar) for the queen-vs-king fixture. Only the
setup changes — leave every assertion in place so the tests keep testing.

---

## Phase 11 — Complexity hotspots (larger, not low-hanging; schedule separately)

Evidence from `fallow health`. These are readability/maintainability risks, not
duplication bugs; do them as separate behaviour-preserving refactors with
characterization tests first.

| Location | Metric | Note |
| - | - | - |
| `orders.ts:145 update` | cognitive **151** | the single biggest; the 5 numbered policy blocks (self-preservation, attack, goto/regroup, autonomous stance, king defense) are natural function boundaries |
| `game.ts` (`orderAt:1051`, 1703 LOC, fan-in 25) | cognitive 47 | extract `orderAt`'s occupant triage and the order-settled branch; consider splitting view code (`snapshot`/`pieceInfo`) into a `gameView.ts` |
| `renderer.ts:158 drawPieceOverlay` | cognitive 90 | plus `drawPieces` 46 |
| `shorthand.ts:96 formatShorthand` | cognitive 88 | shares grid/sort code with `transcript.ts` — see below |
| `targeting.ts:89 update` | cognitive 40 | |
| `movement.ts:10 update` | cognitive 46 | |
| `pathfinding.ts:14 update` | cognitive 45 | |
| `pathfind.ts:129 computeReachable` | cognitive 40 | Phase 2 shrinks this substantially |
| `analysis.ts:57 summarizePieces` / `:167 analyzeGame` | 49 / 41 | |
| `transcript.ts:51 formatTranscript` | 34 | |

**Also worth pairing with these:** `renderer.ts:262-270` and `319-326` are an
identical firing-segment stroke loop → `strokeFiringSegments()`. And
`shorthand.ts` (grid at 144/204-218, sort at 223-226, team lowercase at 212)
duplicates `transcript.ts` (grid at 24-43, sort at 107-110, lowercase at 39) —
extract `teamLetter(team, kind)` and `compareByTeamThenCell` into `trace.ts`.

---

## Suggested commit sequence

1. `refactor: single attack-navigation policy (attackPlan/inFiringGeometry)` — Phase 1
2. `refactor: share movement stepping between moveDestinations and reachableCells` — Phase 2
3. `refactor: single kingOf and laneMidpoint helpers` — Phase 3
4. `chore: remove dead exports and un-export internal helpers` — Phase 5
5. `refactor: one home for cell/vector/health primitives` — Phase 6
6. `refactor: order and motion lifecycle helpers` — Phase 8
7. `test: shared context/duel helpers for system specs` — Phase 10
8. `refactor: shared threat-field scoring for escape and king goals` — Phase 7
9. (optional) `refactor: shared ray/bresenham helpers` — Phase 9 / Phase 2 follow-up
10. (separate) complexity hotspot refactors — Phase 11

Each commit should pass the full gate on its own. If Phase 2 perf regresses,
ship Phases 1 + 3 + 5–8 + 10 and document why Phase 2 was deferred.

## Definition of done

- No duplicate spellings of: attack goal chain, movement stepping, pawn
  home-rank rule, `kingOf`, back-rank midpoint, `NEVER`, cell index, vector
  equality, squared distance, health ratio, order clear, threat danger scoring.
- `npx fallow dead-code` reports no verified-dead exports; `npx fallow dupes`
  has no clone group containing `src/` code (test-fixture clones may remain if
  Phase 10 is skipped).
- `npm run test:run`, `npm run build`, `npm run test:e2e` green; perf test not
  regressed.
- Comments that say "mirrors X" / "kept in sync with Y" are deleted because the
  code is now actually shared.
