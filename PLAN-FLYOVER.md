# PLAN-FLYOVER.md — projectile "fly-over" over non-target pieces

Status: **parked**. A full implementation exists on the `flyover-experiment`
branch but was deliberately reverted off `main` because it changed simulation
timing. This document records what was learned and the recommended way to do it
next time.

---

## 1. The effect

A projectile is fired down a clear lane. A piece that is **not the intended
target** (either team — friend or foe) steps into the lane before the shot
arrives. The shot ignores it for damage (correct — no friendly fire, and only
the target cell can be hit), but visually it *passes through* the piece, which
looks wrong.

Desired: draw the shot **arcing over** the piece with a ground shadow so the
crossing reads as a hop, for any non-target piece regardless of team.

An earlier wish was also a **subtle slowdown** before and after the hop. That is
what turned into a rabbit hole — see §4.

---

## 2. Where the work lives

- `main` was reset to **`0ab0cb5` "red explosions"** (the last clean commit
  before this feature). Build + 486 unit + 32 e2e tests are green there.
- Everything is preserved on branch **`flyover-experiment`**, tip **`8ad5415`**:

  ```sh
  git checkout flyover-experiment
  git log --oneline 0ab0cb5..flyover-experiment
  # 8ad5415 flyover experiment: path-aware slowdown and curved brake
  # dc33ca0 avoid friendly fire
  git diff 0ab0cb5..flyover-experiment
  ```

Files touched on the branch:

| File | Purpose |
| --- | --- |
| `src/game/flyover.ts` (new) | pure `flyoverCue(...) -> { lift, slow }` |
| `src/game/constants.ts` | `PROJECTILE_HOP_*`, `PROJECTILE_CROSS_SLOW`, `PROJECTILE_HOP_BRAKE_CURVE` |
| `src/ecs/systems/projectile.ts` | **sim** uses `slow` to reduce projectile speed |
| `src/render/renderer.ts` | uses `lift` for the arc + ground shadow |
| `tests/unit/flyover.spec.ts` (new) | pure helper tests |
| `tests/unit/projectile-crossing.spec.ts` (new) | sim-timing regression tests |
| `tests/render/renderer.spec.ts` | smoke test for the shadow |
| `ARCHITECTURE.md` | §6 / §8 notes |

Branch constants (final tuned values):

```ts
PROJECTILE_HOP_TILES = 0.9            // arc height, tiles
PROJECTILE_HOP_LOOKAHEAD_TILES = 1.5  // falloff behind the piece, tiles
PROJECTILE_HOP_BRAKE_TILES = 1.5      // falloff ahead of the piece, tiles
PROJECTILE_HOP_MARGIN_TILES = 0.2     // lateral tolerance beyond body radius
PROJECTILE_CROSS_SLOW = 0.6           // peak speed reduction (sim)
PROJECTILE_HOP_BRAKE_CURVE = 0.8      // approach-slow curve (sim)
```

---

## 3. What the branch implemented

`flyoverCue` is a pure function that, for a projectile at `(px,py)` heading
`(dirX,dirY)`, scans nearby pieces and returns two 0..1 strengths:

- **`lift`** — max tent over non-target pieces in the forward tunnel. Fed the
  renderer: `altitude = PROJECTILE_HOP_TILES * tile * lift`, plus a ground
  shadow ellipse; the projectile body is translated up by `altitude`.
- **`slow`** — sim speed factor: `step = speed * dt * (1 - CROSS_SLOW * slow)`.
  The approach side is curved (`(1 - along/brake) ** CURVE`) so the brake is
  visible before the piece; the departure side is linear.

A piece only counts if it is on the shot's actual path:

- lateral distance `<= piece.radius + margin`, and
- not **behind the origin** (where the shot was fired from), and
- not **past the path end** (`along > remaining`), e.g. the square beyond the
  target.

The origin is the owner's live `Position` (fallback: the projectile's own
position, which disables trailing behaviour rather than misfiring). `remaining`
is the distance from the projectile to its current waypoint.

Collision note: `Cell` updates only when a hop **arrives**; `Position` is
interpolated during a hop. Use `Position`, so a piece mid-hop into the lane is
detected.

---

## 4. Findings — why it was reverted

### 4.1 A genuine slowdown cannot be render-only

The first attempts offset the **rendered** position (hold the shot back along
its heading) instead of changing sim speed. That gives a nice deceleration on
approach but, to stay in sync, the offset must be released later — a **speed-up**
after the piece. When the target is the very next square behind the blocker
(the motivating case: queen d1 → pawn d7 with a bishop on d6), the release is
crammed into one square and reads as "stop, wiggle, then jump". A slowdown that
extends all the way to an adjacent target without a catch-up is not possible
with a drawing offset.

### 4.2 The sim slowdown works visually but is a gameplay change

Moving the slowdown into `projectile.ts` gave exactly the right feel (real slow,
no catch-up). But it changes **when damage lands**:

- Reference batch test `tests/unit/study-batch.spec.ts` changed:
  `kingShotsWhileAlone` dropped from `>= 3` to `1` (all other batch stats stayed
  in range). That test exists to catch simulation-behaviour drift.
- Replays recorded under the old timing replay differently.
- The project convention would bump `SIM_VERSION`, but bumping makes saves load
  **position-only** (turn history cleared) — which is exactly how the user lost
  the ability to replay their game. `SIM_VERSION` was therefore left at `2` on
  the branch, which is inconsistent with a real sim change.

### 4.3 Bug found and fixed: pieces behind the firer

The departure ("glide") half of the cue counted **any** piece behind the
projectile within lookahead — including pieces behind where the shot was fired.
Symptom: rook h6 firing down the h-file at h2 slowed for no visible reason,
because the friendly pawn on **h7** and rook on **h8** sit directly behind the
shooter. Fixed by the origin/remaining path filter in §3. **Keep that filter in
any reimplementation** — use `lift` only, but still ignore pieces behind the
origin or past the target.

---

## 5. Recommendation

Do the **render-only arc + shadow**, and **do not change projectile speed**:

- Keeps the sim, replays, `SIM_VERSION`, and the study reference batch untouched.
- Covers the visual problem (no more passing through) for friend and foe.
- Gives up the slowdown. A real slowdown is a gameplay change; if ever wanted,
  treat it as such: bump `SIM_VERSION`, update the reference batch, accept replay
  drift — and expect the offset/catch-up problem of §4.1 if done in the renderer.

An **optional, purely-visual** middle ground (not required): a symmetric
ease-in/ease-out hold-back so it *looks* like it slows approaching and
accelerates away, accepting an imperceptible catch-up on long approaches and a
small snap when the target is adjacent. The branch's history shows how; it is
fiddly and was the source of the "wiggle" complaint.

---

## 6. Concrete implementation sketch (recommended)

All render-only; no `projectile.ts`, no sim constants, no `SIM_VERSION` bump.

1. **Pure helper** — e.g. `src/render/projectilePath.ts` (or put `lift` back in
   `src/game/flyover.ts`; either is fine since it is not used by the sim):

   ```ts
   export interface FlyoverPiece { x: number; y: number; radius: number; skip: boolean }
   export interface FlyoverPath { originX: number; originY: number; remaining: number }

   export function flyoverLift(
     px: number, py: number, dirX: number, dirY: number,
     path: FlyoverPath, pieces: readonly FlyoverPiece[],
     lookahead: number, margin: number,
   ): number
   ```

   Logic per piece: skip if `skip`; compute `lateral = |rx*ny - ry*nx|`, skip if
   `> radius + margin`; `along = rx*nx + ry*ny`; skip if `along > path.remaining`
   or if the piece is behind the origin (`(piece-origin)·n < 0`); otherwise
   `tent = 1 - |along| / lookahead`, return the max.

2. **Constants** (`src/game/constants.ts`): `PROJECTILE_HOP_TILES = 0.9`,
   `PROJECTILE_HOP_LOOKAHEAD_TILES = 1.5`, `PROJECTILE_HOP_MARGIN_TILES = 0.2`.
   (No `CROSS_SLOW`, no `BRAKE_CURVE`.)

3. **Renderer** (`Renderer.drawProjectiles`, `src/render/renderer.ts`): build
   bodies from `world.query(Position, PieceType)` using `PIECES[kind].radius *
   tile`; for each projectile compute heading (already there), `lift`, then
   `altitude = HOP_TILES * tile * lift`; draw the shadow ellipse at the ground
   position and `ctx.translate(0, -altitude)` around the shape drawing. Keep the
   `jump` guide line on the ground.

4. **Skip** `proj.owner` and `proj.target` (owner or every shot launches lifted;
   target or the hit is lifted). Build the origin from the owner's `Position`.

`flyover-experiment` already contains working code for all of this; the
render-only version is the same minus the `slow` half and the `projectile.ts`
call, plus the constants trimmed back.

---

## 7. Tests to add / keep

- Pure helper: peak overhead; falloff with distance; lateral miss; `skip`;
  **ignored when behind the origin**; **ignored when past the path end**; max
  over multiple pieces; independent of heading magnitude.
- Renderer smoke test: a friendly **or enemy** piece in the lane draws the
  shadow; an empty lane does not. `RecordingContext.ellipse` records the
  `fillStyle`; the fly-over shadow is `rgba(0,0,0,<0.28)`, distinct from the
  piece shadow at `rgba(0,0,0,0.35)`.
- Keep `tests/unit/study-batch.spec.ts` passing — it will, because nothing in
  the sim changes. Do **not** add projectile-timing tests.

Build gates: `npm run build`, `npm run test:run`, `npm run test:e2e`.

---

## 8. Gotchas recap

- Detect pieces by live `Position` (interpolated mid-hop), not `Cell`.
- Always skip owner and target.
- Filter to the shot's path (origin + remaining) — the h6→h2/h7 false-positive.
- A piece "enters the lane" mid-flight precisely because `Cell` updates only on
  arrival, so `fireCells` saw a clear line at fire time.
- Renderer draws projectiles **after** pieces, so the arc lifts over the glyph.
- Don't put speed changes in the sim casually: it is a gameplay change
  (reference batch + replays), not a cosmetic one.

---

## 9. How to resume this with an LLM

> "Read `PLAN-FLYOVER.md`. Implement §6 (render-only fly-over) on `main`. The
> working reference is branch `flyover-experiment` (`git diff 0ab0cb5..flyover-experiment`),
> but do **not** copy the sim slowdown or the `projectile.ts` changes."
