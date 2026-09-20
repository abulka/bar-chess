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
import type { GameSnapshot, OverlayFlags } from './game/game'
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

function onKey(event: KeyboardEvent): void {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
  if (event.key === 'h') onToggleHud()
  else if (event.key === ' ') {
    event.preventDefault()
    game.togglePause()
    refresh()
  } else if (event.key === 'Escape') {
    game.clearSelection()
    refresh()
  } else if (event.key === 'm') orderMode.value = 'move'
  else if (event.key === 'f') orderMode.value = 'fight'
  else if (event.key === 'o') orderMode.value = 'hold'
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
      @toggle-pause="game.togglePause(); refresh()"
      @step="game.stepOnce(); refresh()"
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
        <BoardView ref="boardView" :game="game" :order-mode="orderMode" @changed="refresh" />
        <div class="board-hint">
          left-click select · shift-click multi-select · right-click order · drag pan · wheel zoom
        </div>
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
