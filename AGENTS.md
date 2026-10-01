# AGENTS.md

Guidance for AI coding agents working in the Bar Chess repository.

## Project overview

Bar Chess is a real-time, chess-derived battle simulation built as a Vite + Vue 3
+ TypeScript single-page app. Chess supplies the movement and firing geometry;
there are no turns, check or checkmate. The simulation is a hand-rolled
Entity-Component-System on a fixed timestep, separate from the Canvas 2D renderer
and the Vue UI. Vue is the only runtime dependency.

Before changing behaviour, read the design and architecture documents:

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the code is structured: runtime data
  flow, ECS core, components, fixed-timestep loop, turn/replay model, systems
  reference, rendering, Vue UI snapshot contract, audio, and a full file index
  (`ARCHITECTURE.md` §12).
- [PLAN.md](PLAN.md) — design principles, approved decisions, orders, turn flow,
  game modes, overlays, roadmap and the rule bank.
- [PLAN-FLYOVER.md](PLAN-FLYOVER.md) — a parked feature ("projectile fly-over")
  with findings and a recommended render-only approach. Read it before touching
  projectile rendering or simulation timing.
- [plans/](plans/) — longer, per-feature implementation plans (for example
  `plans/001-order-preserve-override.md`).
- [README.md](README.md) — user-facing feature list and basic usage.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server (usually http://localhost:5173) |
| `npm run build` | Type-check with `vue-tsc -b`, then `vite build` |
| `npm run preview` | Preview the production build |
| `npm test` | Vitest in watch mode |
| `npm run test:run` | Run unit/render tests once |
| `npm run test:cov` | Tests with coverage |
| `npm run test:e2e` | Playwright end-to-end tests |

Build gates: `npm run build`, `npm run test:run` and `npm run test:e2e`. There is
no linter or formatter configured.

## Conventions

- TypeScript strict mode, with `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `noUnusedLocals` and `noUnusedParameters` enabled (see the `tsconfig` files).
- Do not use `enum`, `namespace`, or constructor parameter properties.
- Type-only imports must use `import type`.
- Vue is the only runtime dependency. Do not add another without discussing it.
- **No comments unless the user asks for them.**
- Determinism: all randomness must go through `Rng` (a seeded `mulberry32`).
  Never call `Math.random()` in `src/ecs` or `src/game`.

## Architecture rules to preserve

- The UI never touches ECS internals. It reads `GameSnapshot` (a plain object)
  and calls `Game` methods.
- The renderer only reads; it never mutates the world.
- Audio is a read-only `EventBus` observer and never reads or mutates the world.
- Events on the `EventBus` exist for the log, auto-pause triggers and debugging.
  They never drive simulation logic.
- Systems run in array order via `Pipeline`. Keep systems focused and add new
  systems to `src/ecs/systems/index.ts`.
- The simulation must remain replayable from `(board + seed + ordered inputs)`;
  `Recorder`/`replayRecord` (`src/game/record.ts`) rely on this. A change to
  simulation timing or outcomes is a gameplay change, not a cosmetic one — bump
  `SIM_VERSION` deliberately and expect replay drift (see `PLAN-FLYOVER.md` §4).

## Testing

- Pure logic lives in headless modules and is unit-tested directly in
  `tests/unit`.
- Overlay visuals are pure data (`src/render/overlays.ts` returns styled
  segments), so routing and firing-line drawing is tested by asserting
  coordinates and line styles in `tests/render`, using a mock 2D context for
  the renderer's stroke order.
- `Game.runTicks(n)` drives turns and replay deterministically without the
  requestAnimationFrame loop; use it for integration tests.
- Playwright tests in `tests/e2e` cover real canvas interaction and pixel probes.
- Component stores are module-level singletons, so tests that build multiple
  worlds must call `clearComponents()` between cases.
- `tests/unit/study-batch.spec.ts` is a reference-batch guard for simulation
  behaviour drift. Keep it passing; do not casually update its expectations.

## Communication style

After each response to me add a summary section: Use concise, plain English in
all communication with me. Avoid telegraphic coding jargon and fragments such as
"inspect caller", "stale state", or "propagate change". Use complete, natural
sentences. Keep explanations brief but readable. Technical terminology is fine
when necessary; do not replace normal English with compressed developer
shorthand.
