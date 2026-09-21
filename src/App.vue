<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import BoardView from './components/BoardView.vue'
import EventLog from './components/EventLog.vue'
import ReinforcementBar from './components/ReinforcementBar.vue'
import StatsBar from './components/StatsBar.vue'
import Toolbar from './components/Toolbar.vue'
import type { BoardSize } from './game/boards'
import { SNAPSHOT_INTERVAL_MS } from './game/constants'
import { Game } from './game/game'
import type { GameMode, GameSnapshot, OverlayFlags } from './game/game'
import type { StanceMode, TeamId } from './game/types'

const game = new Game(8)
const snapshot = shallowRef<GameSnapshot>(game.snapshot())
const stance = ref<StanceMode>('none')
const copied = ref(false)
const boardView = ref<InstanceType<typeof BoardView> | null>(null)

let timer = 0

function refresh(): void {
  snapshot.value = game.snapshot()
}

function onDeploy(team: TeamId, key: string): void {
  game.deploy(team, key)
  refresh()
}

function onSelectSize(size: number): void {
  game.loadSize(size as BoardSize)
  boardView.value?.fit()
  refresh()
}

function onSetGameMode(mode: GameMode): void {
  game.setGameMode(mode)
  refresh()
}

function onSetStance(mode: StanceMode): void {
  if (game.selected.length > 0) game.setStance(mode)
  stance.value = mode
  refresh()
}

function onOrdered(): void {
  refresh()
}

function onToggleOverlay(key: keyof OverlayFlags): void {
  game.overlays[key] = !game.overlays[key]
  refresh()
}

function onToggleHud(): void {
  game.hudVisible = !game.hudVisible
  refresh()
  nextTick(() => boardView.value?.fit())
}

function onReset(): void {
  game.reset()
  boardView.value?.fit()
  refresh()
}

function onTurn(): void {
  // Ignore during an active turn/replay so space always starts the next turn
  // rather than cancelling the current one.
  if (game.turnActive || snapshot.value.replaying) return
  game.beginTurn()
  refresh()
}

function onReplay(): void {
  game.replayTurn()
  refresh()
}

async function copyJson(): Promise<void> {
  const json = JSON.stringify(game.toDebugJson(), null, 2)
  try {
    await navigator.clipboard.writeText(json)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1200)
  } catch {
    console.log(json)
  }
}

function onKey(event: KeyboardEvent): void {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
  if (event.key === 'h') onToggleHud()
  else if (event.key === 'p') {
    game.togglePause()
    refresh()
  } else if (event.key === ' ') {
    event.preventDefault()
    onTurn()
  } else if (event.key === 's') {
    game.stepOnce()
    refresh()
  } else if (event.key === 'r') {
    onReplay()
  } else if (event.key === 'b') {
    game.rewindTurn()
    refresh()
  } else if (event.key === 'c' || event.key === 'Backspace') {
    event.preventDefault()
    game.clearOrders()
    refresh()
  } else if (event.key === 'o') {
    onToggleOverlay('myOrders')
  } else if (event.key === 'e') {
    onToggleOverlay('enemyPlans')
  } else if (event.key === 'Escape') {
    game.clearSelection()
    refresh()
  } else if (event.key === '1' || event.key === 'm') onSetStance('move')
  else if (event.key === '2' || event.key === 'a') onSetStance('attack')
}

onMounted(() => {
  game.start()
  timer = window.setInterval(refresh, SNAPSHOT_INTERVAL_MS)
  window.addEventListener('keydown', onKey)
  if (import.meta.env.DEV) {
    ;(window as unknown as { game: Game }).game = game
  }
})

onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.removeEventListener('keydown', onKey)
  game.stop()
})
</script>

<template>
  <div class="app" :class="{ 'hud-hidden': !snapshot.hudVisible }">
    <Toolbar
      :snapshot="snapshot"
      :stance="stance"
      @select-size="onSelectSize"
      @set-game-mode="onSetGameMode"
      @toggle-pause="game.togglePause(); refresh()"
      @step="game.stepOnce(); refresh()"
      @turn="onTurn"
      @replay="onReplay"
      @set-speed="game.setSpeed($event); refresh()"
      @set-stance="onSetStance"
      @toggle-overlay="onToggleOverlay"
      @reset="onReset"
      @toggle-hud="onToggleHud"
    />

    <div
      class="turnbar"
      :class="{ active: snapshot.turnActive, replay: snapshot.replaying }"
      :title="snapshot.turnActive ? 'turn in progress (space)' : 'press space for a turn, r to replay'"
    >
      <div
        class="turnbar-fill"
        :style="{ width: (snapshot.turnActive ? snapshot.turnProgress : snapshot.replaying ? snapshot.replayProgress : 0) * 100 + '%' }"
      ></div>
      <span class="turnbar-label">
        {{
          snapshot.turnActive
            ? 'TURN'
            : snapshot.replaying
              ? 'REPLAY'
              : snapshot.canReplay
                ? 'READY — space for next turn'
                : 'press space for a turn'
        }}
      </span>
    </div>

    <div class="stage" :class="{ 'no-rosters': !snapshot.hudVisible }">
      <aside class="rail left">
        <div class="rail-title">controls</div>
        <ul class="hints">
          <li><b>drag</b> select box · <b>shift-click</b> add</li>
          <li><b>shift-drag</b>/middle pan · <b>wheel</b> zoom</li>
          <li><b>right-click</b> empty → move</li>
          <li><b>right-click</b> enemy → attack (Attack stance)</li>
          <li><b>1</b>/<b>m</b> Move · <b>2</b>/<b>a</b> Attack stance</li>
          <li><b>space</b> turn · <b>p</b> pause · <b>s</b> step</li>
          <li><b>r</b> replay · <b>b</b> rewind · <b>c</b>/<b>Backspace</b> clear orders</li>
          <li><b>o</b> my orders · <b>e</b> enemy · <b>h</b> HUD</li>
        </ul>
      </aside>

      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.red"
        side="left"
        @deploy="onDeploy('red', $event)"
      />

      <div class="center">
        <div class="board-area">
          <BoardView ref="boardView" :game="game" @changed="refresh" @ordered="onOrdered" />
        </div>
      </div>

      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.blue"
        side="right"
        @deploy="onDeploy('blue', $event)"
      />

      <aside class="rail right">
        <div class="rail-title">stance</div>
        <ul class="legend">
          <li><span class="dot" style="background: #4ad991"></span><b>M</b> Move — travel, return fire only</li>
          <li><span class="dot" style="background: #ff3b30"></span><b>A</b> Attack — engage nearby, flee when low</li>
          <li><b>no badge</b> — no order (stand &amp; fire in range)</li>
          <li><span class="dot" style="background: #ff2d20"></span><b>red ring</b> target of an attack</li>
          <li><span class="dot" style="background: #b9c2cc"></span><b>&#9678;</b> tracking an enemy</li>
        </ul>
        <div class="rail-title">hover</div>
        <div class="hover-readout">
          <span>{{ snapshot.hoverName ?? '—' }}</span>
          <span v-if="snapshot.hoverKind" class="muted">· {{ snapshot.hoverKind }}</span>
        </div>
        <div class="rail-title">legend</div>
        <ul class="legend">
          <li><span class="sw sw-move"></span> move cells</li>
          <li><span class="sw sw-attack"></span> attack cells</li>
          <li><span class="sw sw-path"></span> path / objective</li>
          <li><span class="sw sw-bar"></span> health · <span class="sw sw-reload"></span> reload (red)</li>
        </ul>
        <button class="ctl copy-btn" @click="copyJson">{{ copied ? 'Copied!' : 'Copy position JSON' }}</button>
      </aside>
    </div>

    <div v-if="snapshot.hudVisible" class="bottom">
      <StatsBar :snapshot="snapshot" />
      <EventLog :snapshot="snapshot" />
    </div>
  </div>
</template>
