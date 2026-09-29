# Plan v2: per-order "no-preserve" override (insist for 1–2 turns)

(v1 → v2: incorporates the DeepSeek review. Changes flagged **[v2]** below.)

## Verified diagnosis (unchanged)

- The preservation decision is pass 0 of the orders system: `src/ecs/systems/orders.ts:289-330`
  ("a hurt or outgunned piece retreats on its own, even while it is moving or
  pursuing a standing attack order"), gated by `ctx.autoPreserve && !instaKill &&
  !endgame && !lastStandKing && …` at `orders.ts:330`. `preservation.ts` is pure
  helpers only.
- The only existing override is `Order.chessKill` (insta-kill): human-only,
  order-bound, replay-safe. Pattern to imitate (`src/game/instaKill.ts`).
- `OrderData` (`src/ecs/components.ts:47-73`) already carries turn-index fields
  (`resumeTurn`) and an order log; `Stance` is persistent policy, the wrong
  home for a 1–2 turn override.
- **Replay mechanism (verified for v2):** replays do **not** restore state —
  they re-apply recorded `GameCommandIntent`s. `src/game/record.ts:22` records
  `{ t: 'order'; from; to; command? }` and `applyIntents` (`record.ts` ~303)
  re-issues via `game.orderAt(intent.to, intent.command)`. Rules ride along
  because `TurnRecord.settings` (`SimSettings`) is restored per turn in
  `replayRecord` (`record.ts` ~258-262). **Therefore an Alt press is currently
  lost on replay — the v1 plan missed this.**
- **Second retreat path (verified for v2):** `orders.ts:643-658` (`targetValid
  && hpRatio < preserveThreshold` → `escapeGoal`, intent `'preserve'`) sits in
  the *"3. Autonomous stance"* section, which is only reached when
  `order.kind === 'none'` (passes 1 and 2 handle attack/goto and `continue`).
  A piece with an active order — the only kind that can carry the flag — never
  reaches line 643.
- Turn index: `ctx.turn` (monotonic, `SimContext` in `src/ecs/types.ts`),
  incremented at turn end (`game.ts:900,1014`).
- UI: BAR prefixes `m`/`a` (`App.vue:959,962`), Shift = queue more
  (`BoardView.vue:110`) — Alt is free. Preserve paths already render cyan
  (`renderer.ts:257-306`); preserve episodes already log start/end
  (`orders.ts:446-456`).

## Design (decisions locked)

Flag **on the order**, bounded by **both** the order's lifetime and a hard cap
of N turns (default 2, configurable 1–2):

- `OrderData.noPreserveUntil: number` — absolute turn index, `-1` = off.
  Set by the order-issue path to `ctx.turn + N`. Cleared when the order is
  replaced, completed, or cleared; **not** carried onto promoted queued steps
  (`promoteNext` promotes an `OrderStep`, not the flag) — document in the
  field comment, same style as `resumeTurn`.
- **Turn arithmetic [v2, pinned]:** override is ACTIVE while
  `ctx.turn < noPreserveUntil`; the preserve gate additionally requires
  `order.noPreserveUntil <= ctx.turn`. Worked example, N = 2, ordered during
  turn T: `noPreserveUntil = T+2`; active on turns **T and T+1**; preservation
  resumes at **T+2**. Effective window = `min(N turns, order lifetime)`.
- **Gate both paths [v2]:**
  - main pass `orders.ts:330`: add `&& order.noPreserveUntil <= ctx.turn`
    (helper `orderInsists(order, turn)` next to `hasInstaKill` — keep the name).
  - stance pass `orders.ts:643`: not reachable for an ordered piece today,
    but `order` is in scope — add the same condition **defensively, with a
    comment explaining it is unreachable for orders** so a future refactor
    can't silently re-expose it.
- **Release the latch:** while active, clear `motion.holdUntilHp` (else an
  already-latched safe-hold vetoes the order anyway); the heal trip (`heal !==
  null` branch, `orders.ts` ~380) is inside the skipped pass, so it stops too —
  "insist" = execute my order, full stop.
- **Log:** `order.log` note on set ("no-preserve until turn T") and on expiry;
  the existing episode logger then stays quiet for the covered window, which
  is itself visible feedback.

## Replay correctness [v2 — the big fix]

The flag must survive the re-apply path, not "ride the order serialization":

- `src/game/record.ts:22` — add optional field to the intent:
  `{ t: 'order'; from; to; command?; force?: boolean }` (`force` = Alt was
  held). Optional ⇒ old records replay unchanged ⇒ **no `RECORD_VERSION` bump**.
- `src/game/game.ts:2055` — emit it in the `onCommand` payload (the recorder
  captures `onCommand` verbatim, `record.ts:91`).
- `game.orderAt(to, command?, opts?: { force?: boolean })` — new optional
  parameter; when `force`, set `noPreserveUntil = this.turn + N`.
- `record.ts` `applyIntents` (~303) — pass through:
  `game.orderAt(intent.to, intent.command, { force: intent.force })`.
- **Duration N lives in `SimSettings`**, not on the intent: new optional
  `noPreserveTurns?: number` (absent ⇒ 2) in `src/game/settings.ts:16-26`;
  restored per turn in `replayRecord` (~262, alongside `autoPreserve`) and in
  `simSettings()` (`game.ts:1288+`). Storing the *boolean* on the intent plus
  the *duration in rules* keeps the intent minimal and the rule replayable.
- Undo/redo: turn-start command cloning (`game.ts:261`) clones the same intent
  objects — `force` comes along for free.

## UI (as chosen; v1 extras demoted)

1. **Alt+click while a command prefix is armed** (`m`/`a`) = no-preserve for
   N turns. Banner (`App.vue:1050-1054`) gains the hint; plain click unchanged.
2. **PiecePanel readout (feedback only, kept):** while the active order carries
   the flag, show `no-preserve · N turn(s) left` next to the order line, styled
   like the `regrouping` readout (`game.ts:2936`). No new segmented control.
   **[v2: the OFF/1t/2t chip from v1 is dropped; a stretch item at most.]**
3. **Options:** "No-preserve duration: 1 / 2 turns" beside *Auto-preserve*
   (`OptionsPanel.vue`, `StudyPanel.vue`) — this is the source of N.
4. **Render:** small marker on the route of a pressed piece (gold "!" over the
   normal order gold) via the intent-colour path at `renderer.ts:282-306`;
   intent stays `'order'`.

## Snapshot

`PieceInfo`/`PieceSnapshot` mapping (`game.ts` ~2880-2940): expose
`noPreserveUntil` (and the snapshot already carries the turn) so the panel can
render the countdown; renderer reads the same field.

## Files touched

- `src/ecs/components.ts` — `OrderData.noPreserveUntil` + default at creation.
- `src/ecs/systems/orders.ts` — main gate (~:330), defensive gate (:643),
  hold release (~:297-300), expiry note, `orderInsists` helper (or in a small
  module next to `instaKill.ts`).
- `src/game/game.ts` — `orderAt` opts, `onCommand` payload (:2055),
  `simSettings()`/restore, `PieceInfo` mapping.
- `src/game/record.ts` — intent field (:22), `applyIntents` pass-through (~:303),
  settings restore (~:262).
- `src/game/settings.ts` — `noPreserveTurns?`.
- `src/App.vue` — Alt through the click handler, banner hint.
- `src/components/BoardView.vue` — pass `event.altKey` into `orderAt`.
- `src/components/PiecePanel.vue` — countdown readout.
- `src/components/OptionsPanel.vue`, `src/components/StudyPanel.vue` — duration.
- `src/render/renderer.ts` — pressed-order marker.
- `src/game/shorthand.ts` — notation/rules note (documents `autoPreserve`).

## Tests (run `npm test` for baseline first)

1. Wounded ordered piece under fire: no flag → intent `'preserve'` (today's
   behaviour); flag set → intent `'order'`, path unchanged, heal trip gone.
2. **Turn window [v2]:** N=2, ordered at turn T → override active T, T+1;
   piece preserving again at T+2 (pin the off-by-one in a test).
3. **Replay [v2]:** record a forced order → `replayRecord` → same intent on the
   piece, same turns active as live. Unforced orders unchanged; a v1-format
   record (no `force`) still replays.
4. Re-issue without Alt clears the flag; `clearOrders` clears it; a promoted
   queued step does **not** inherit it; order completion clears it.
5. Snapshot round-trip keeps `noPreserveUntil`; panel countdown decreases.

## Resolved open questions

- Modifier: **Alt** (Shift is the queue key). ✓ (both reviews agreed)
- Heal trip suppressed while active: **yes** (whole pass skipped). ✓
- Lifetime: **min(2 turns, order lifetime)** — user approved both the 2-turn
  cap and ending with the order. ✓
- `orderInsists` helper name kept. ✓
