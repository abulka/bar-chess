# Bar Chess

[![Play Now](https://img.shields.io/badge/Play_Now-bar--chess.netlify.app-brightgreen?style=for-the-badge&logo=netlify&logoColor=white)](https://bar-chess.netlify.app/)

**Bar Chess is chess with bullets** — a chess-derived battlefield where pieces move by chess geometry and shoot visible projectiles at each other, inspired by [BAR (Beyond All Reason)](https://www.beyondallreason.info/), the open-source RTS game.

![Bar Chess main screenshot](docs/screenshots/screenshot-main-01.png)

You command your pieces by giving them **intentions** (a destination or a target), then watch autonomous movement, firing, projectile flight and destruction play out. It is not chess: there are no turns, check or checkmate — chess only supplies the movement language, the piece identities and the firing geometry.

## Features

- **Chess movement, RTS combat.** Rooks slide along ranks/files, bishops along diagonals, knights leap, pawns advance and fire their forward diagonals. Every piece fires visible, travelling projectiles that can miss, be blocked or arrive late.
- **Command, don't micromanage.** Right-click to set goals; pieces work toward them and fight opportunistically. Set a persistent **stance** (Move / Attack / None) and let them engage.
- **Real-time with pause as a strategy tool.** The battle starts paused. Issue orders, take a turn, or let it run at 0.5×/1×/2×/4× speed.
- **Turns, undo, redo and deterministic replay.** `space` advances one turn (one move per piece, then auto-pause); `u`/`r` step through turn history; `y` replays the turn that produced the state you are viewing — at any point in the history, keeping your selection and place.
- **Readable overlays.** Move cells, attack cells, range arcs, paths, firing lines, health and firing-recharge bars, target rings and per-army order summaries. Automatic self-preservation retreats are drawn in bright yellow, and the piece panel labels every goal's source (manual, unreachable, self-preservation, rally, …). A committed engagement (AI, or Attack stance) draws the amber reticle; a stationary None/Move piece taking an in-range "pot shot" draws a muted grey dashed line instead, and the panel says so.
- **Game modes.** Human vs AI, AI vs AI and Human vs Human.
- **Procedural audio.** WebAudio SFX driven by the event bus, with a synth editor to tweak every cue.
- **Self-preservation, bodyguards and capture-advance** make fights feel tactical rather than static.
- **King healing aura.** Pieces within two squares of their king slowly regenerate health (3× faster for human-controlled teams), drawn with a green aura and wavy healing lines (`show healing` overlay). The king is the source of the aura and does not heal itself. Badly wounded pieces walk back into the aura on their own to recover.

## Demo

<figure>
	<img src="docs/screenshots/screen-recording-01.gif" alt="Demo video">
	<figcaption><em>Animated GIF of a demo battle, showing the UI and gameplay.</em></figcaption>
</figure>

## Installation

You don't need to install anything to play — the game is hosted at [bar-chess.netlify.app](https://bar-chess.netlify.app/). The steps below are only for running it locally from source.

Requires [Node.js](https://nodejs.org/) 20+.

```sh
npm install
```

## Running

Start the development server:

```sh
npm run dev
```

Then open the printed URL (usually http://localhost:5173) in your browser.

Production build and local preview:

```sh
npm run build
npm run preview
```

## Basic usage

The battle starts **paused**. Your team is blue (vs orange AI by default).

- **Left-click** a piece to select it; **shift-click** to add to the selection; **drag** to box-select.
- **Right-click an empty square** to order a move there (no need to micromanage the exact path — each piece advances as far as its geometry allows).
- **Right-click an enemy** to order an attack (sticky target, shown with a red ring).
- **Right-click again** (or shift-right-click) to append a step to the piece's order queue.
- A piece best-efforts orders even to squares it cannot reach; once it is as close as it can get, your next order replaces the spent one instead of hiding behind it. Explicit orders also take priority over the automatic low-health retreat — except a move order whose destination is inside your king's healing aura, which a badly wounded piece will still walk to so it can recover.
- **`m` / `a` then left-click** forces a move / attack command; hold **Shift** to queue several.
- Set a piece's persistent **stance** from the left panel: `M` Move (travel and return fire), `A` Attack (seek and engage nearby targets), or none (stand and fire in range only).
- Press **`space`** to take a turn, **`p`** to pause/resume, **`s`** to step one tick.
- **Shift-drag** or **middle-drag** to pan, **wheel** to zoom. Toggle overlays in the toolbar.

The toolbar also has speed controls (0.5×–4×), sound, and `my orders` / `enemy plans` overlay scopes. The left rail shows control hints and the selected piece panel; the right rail shows the stance/legend and position export buttons.

Keyboard summary: `m`/`a` arm move/attack · `space` turn · `p` pause · `s` step · `u`/`r` undo/redo · `y` replay · `c`/`Backspace` clear orders · `o` my orders · `e` enemy plans · `h` HUD · `Esc` cancel.

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check (`vue-tsc`) and build |
| `npm run preview` | Preview the production build |
| `npm run test` | Vitest in watch mode |
| `npm run test:run` | Run unit/render tests once |
| `npm run test:cov` | Tests with coverage |
| `npm run test:e2e` | Playwright end-to-end tests |

The design, simulation internals and roadmap are documented in [ARCHITECTURE.md](ARCHITECTURE.md) and [PLAN.md](PLAN.md).

## License

[MIT](LICENSE) © Andy Bulka
