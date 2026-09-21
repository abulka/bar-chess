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
import type { IntentMode, TeamId } from './game/types'

const game = new Game(16)
const snapshot = shallowRef<GameSnapshot>(game.snapshot())
const orderMode = ref<IntentMode>('move')
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
  if (game.turnActive) game.togglePause()
  else game.beginTurn()
  refresh()
}

function onReplay(): void {
  game.replayTurn()
  refresh()
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
  } else if (event.key === 'o') {
    onToggleOverlay('myOrders')
  } else if (event.key === 'e') {
    onToggleOverlay('enemyPlans')
  } else if (event.key === 'Escape') {
    game.clearSelection()
    refresh()
  } else if (event.key === '1') orderMode.value = 'move'
  else if (event.key === '2') orderMode.value = 'fight'
  else if (event.key === '3') orderMode.value = 'hold'
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
      :order-mode="orderMode"
      @select-size="onSelectSize"
      @set-game-mode="onSetGameMode"
      @toggle-pause="game.togglePause(); refresh()"
      @step="game.stepOnce(); refresh()"
      @turn="onTurn"
      @replay="onReplay"
      @set-speed="game.setSpeed($event); refresh()"
      @set-order-mode="orderMode = $event"
      @toggle-overlay="onToggleOverlay"
      @reset="onReset"
      @toggle-hud="onToggleHud"
    />

    <div class="stage" :class="{ 'no-rosters': !snapshot.hudVisible }">
      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.red"
        side="left"
        @deploy="onDeploy('red', $event)"
      />
      <div class="center">
        <div class="board-area">
          <BoardView ref="boardView" :game="game" :order-mode="orderMode" @changed="refresh" />
        </div>
        <ul v-if="snapshot.hudVisible" class="hints">
          <li><b>drag</b> — select a box of pieces</li>
          <li><b>shift-drag</b> or middle-drag — pan · <b>wheel</b> — zoom</li>
          <li>
            <b>right-click</b> — order
            <b :style="{ color: orderMode === 'move' ? '#5ab0ff' : orderMode === 'fight' ? '#ff6b5a' : '#ffd166' }">
              {{ orderMode.toUpperCase() }}
            </b>
            (<b>1</b>/<b>2</b>/<b>3</b> to change)
          </li>
          <li><b>space</b> — turn (each piece moves once) · <b>p</b> pause · <b>s</b> step · <b>r</b> replay</li>
          <li><b>o</b> my orders · <b>e</b> enemy plans · <b>h</b> HUD · <b>Esc</b> clear</li>
        </ul>
      </div>
      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.blue"
        side="right"
        @deploy="onDeploy('blue', $event)"
      />
    </div>

    <div v-if="snapshot.hudVisible" class="bottom">
      <StatsBar :snapshot="snapshot" />
      <EventLog :snapshot="snapshot" />
    </div>
  </div>
</template>
