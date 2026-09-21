<script setup lang="ts">
import type { GameMode, GameSnapshot, OverlayFlags } from '../game/game'
import type { IntentMode } from '../game/types'

const props = defineProps<{
  snapshot: GameSnapshot
  orderMode: IntentMode
}>()

const emit = defineEmits<{
  (e: 'select-size', size: number): void
  (e: 'set-game-mode', mode: GameMode): void
  (e: 'toggle-pause'): void
  (e: 'step'): void
  (e: 'turn'): void
  (e: 'replay'): void
  (e: 'set-speed', speed: number): void
  (e: 'set-order-mode', mode: IntentMode): void
  (e: 'toggle-overlay', key: keyof OverlayFlags): void
  (e: 'reset'): void
  (e: 'toggle-hud'): void
}>()

const speeds = [0.5, 1, 2, 4]
const orderModes: Array<{ id: IntentMode; label: string }> = [
  { id: 'move', label: 'Move' },
  { id: 'fight', label: 'Fight' },
  { id: 'hold', label: 'Hold' },
]
const overlayKeys: Array<{ key: keyof OverlayFlags; label: string }> = [
  { key: 'myOrders', label: 'my orders (o)' },
  { key: 'enemyPlans', label: 'enemy plans' },
  { key: 'moveCells', label: 'move' },
  { key: 'attackCells', label: 'attack' },
  { key: 'rangeArcs', label: 'range' },
  { key: 'grid', label: 'grid' },
  { key: 'health', label: 'health' },
]
</script>

<template>
  <header class="toolbar">
    <div class="brand">Bar Chess</div>

    <select
      class="ctl"
      :value="props.snapshot.boardSize"
      @change="emit('select-size', Number(($event.target as HTMLSelectElement).value))"
    >
      <option v-for="s in props.snapshot.boardSizes" :key="s" :value="s">{{ s }}×{{ s }}</option>
    </select>

    <select
      class="ctl mode-select"
      :value="props.snapshot.gameMode"
      @change="emit('set-game-mode', ($event.target as HTMLSelectElement).value as GameMode)"
    >
      <option v-for="m in props.snapshot.gameModes" :key="m.id" :value="m.id">{{ m.label }}</option>
    </select>

    <span class="vs-badge">
      <b :style="{ color: props.snapshot.teams[props.snapshot.playerTeam].color }">
        {{ props.snapshot.teams[props.snapshot.playerTeam].name }}
      </b>
      you ·
      <b :style="{ color: props.snapshot.teams[props.snapshot.playerTeam === 'blue' ? 'red' : 'blue'].color }">
        {{ props.snapshot.teams[props.snapshot.playerTeam === 'blue' ? 'red' : 'blue'].name }}
      </b>
      {{ props.snapshot.teams[props.snapshot.playerTeam === 'blue' ? 'red' : 'blue'].controller }}
    </span>

    <button class="ctl" :class="{ active: props.snapshot.turnActive }" @click="emit('turn')">
      {{ props.snapshot.turnActive ? '⏵ Turn…' : '⏵ Turn' }}
    </button>
    <button class="ctl" @click="emit('toggle-pause')">{{ props.snapshot.paused ? '▶ Play' : '⏸ Pause' }}</button>
    <button class="ctl" @click="emit('step')">⏭ Step</button>
    <button class="ctl" :disabled="!props.snapshot.canReplay" @click="emit('replay')">↺ Replay</button>

    <div class="speed-group">
      <button
        v-for="s in speeds"
        :key="s"
        class="ctl small"
        :class="{ active: props.snapshot.speed === s }"
        @click="emit('set-speed', s)"
      >
        {{ s }}x
      </button>
    </div>

    <div class="speed-group order-modes" title="right-click issues this order">
      <button
        v-for="m in orderModes"
        :key="m.id"
        class="ctl small"
        :class="{ active: props.orderMode === m.id }"
        @click="emit('set-order-mode', m.id)"
      >
        {{ m.label }}
      </button>
    </div>

    <button class="ctl" @click="emit('reset')">Reset</button>

    <div class="spacer"></div>

    <label v-for="o in overlayKeys" :key="o.key" class="toggle">
      <input
        type="checkbox"
        :checked="props.snapshot.overlays[o.key]"
        @change="emit('toggle-overlay', o.key)"
      />
      {{ o.label }}
    </label>

    <button class="ctl" @click="emit('toggle-hud')">{{ props.snapshot.hudVisible ? 'Hide HUD' : 'Show HUD' }}</button>
  </header>
</template>
