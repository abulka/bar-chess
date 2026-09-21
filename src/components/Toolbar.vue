<script setup lang="ts">
import { SPEEDS } from '../game/constants'
import type { GameMode, GameSnapshot, OverlayFlags } from '../game/game'
import type { StanceMode } from '../game/types'

const props = defineProps<{
  snapshot: GameSnapshot
  stance: StanceMode
}>()

const emit = defineEmits<{
  (e: 'select-size', size: number): void
  (e: 'set-game-mode', mode: GameMode): void
  (e: 'toggle-pause'): void
  (e: 'step'): void
  (e: 'turn'): void
  (e: 'replay'): void
  (e: 'set-speed', speed: number): void
  (e: 'set-stance', mode: StanceMode): void
  (e: 'toggle-overlay', key: keyof OverlayFlags): void
  (e: 'reset'): void
  (e: 'toggle-hud'): void
}>()

const speeds = SPEEDS
const stances: Array<{ id: StanceMode; label: string; keys: string; title: string }> = [
  { id: 'move', label: 'Move', keys: '1/m', title: 'Move stance: travel, only return fire' },
  { id: 'attack', label: 'Attack', keys: '2/a', title: 'Attack stance: engage nearby, flee when low' },
]
const overlayKeys: Array<{ key: keyof OverlayFlags; label: string }> = [
  { key: 'myOrders', label: 'my orders (o)' },
  { key: 'enemyPlans', label: 'enemy plans' },
  { key: 'moveCells', label: 'move' },
  { key: 'attackCells', label: 'attack' },
  { key: 'rangeArcs', label: 'range' },
  { key: 'grid', label: 'grid' },
  { key: 'health', label: 'health' },
  { key: 'reload', label: 'firing recharge' },
]

// Blur after change so global hotkeys keep working when a toolbar control was
// the last thing clicked.
function onSizeChange(event: Event): void {
  const el = event.target as HTMLSelectElement
  emit('select-size', Number(el.value))
  el.blur()
}

function onModeChange(event: Event): void {
  const el = event.target as HTMLSelectElement
  emit('set-game-mode', el.value as GameMode)
  el.blur()
}

function onOverlayChange(key: keyof OverlayFlags, event: Event): void {
  emit('toggle-overlay', key)
  ;(event.target as HTMLInputElement).blur()
}
</script>

<template>
  <header class="toolbar">
    <div class="brand">Bar Chess</div>

    <button class="ctl" @click="emit('reset')">Reset</button>

    <select
      class="ctl"
      :value="props.snapshot.boardSize"
      @change="onSizeChange"
    >
      <option v-for="s in props.snapshot.boardSizes" :key="s" :value="s">{{ s }}×{{ s }}</option>
    </select>

    <select
      class="ctl mode-select"
      :value="props.snapshot.gameMode"
      @change="onModeChange"
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

    <div class="speed-group order-modes" title="stance for the selected pieces">
      <span class="stance-label">stance</span>
      <button
        v-for="m in stances"
        :key="m.id"
        class="ctl small"
        :class="{ active: props.stance === m.id }"
        :title="m.title"
        @click="emit('set-stance', m.id)"
      >
        {{ m.label }} <span class="key">{{ m.keys }}</span>
      </button>
    </div>

    <div class="spacer"></div>

    <label v-for="o in overlayKeys" :key="o.key" class="toggle">
      <input
        type="checkbox"
        :checked="props.snapshot.overlays[o.key]"
        @change="onOverlayChange(o.key, $event)"
      />
      {{ o.label }}
    </label>

    <button class="ctl" @click="emit('toggle-hud')">{{ props.snapshot.hudVisible ? 'Hide HUD' : 'Show HUD' }}</button>
  </header>
</template>
