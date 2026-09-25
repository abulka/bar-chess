<script setup lang="ts">
import { SPEEDS } from '../game/constants'
import type { GameMode, GameSnapshot, OverlayFlags } from '../game/game'

const props = defineProps<{
  snapshot: GameSnapshot
}>()

const emit = defineEmits<{
  (e: 'select-size', size: number): void
  (e: 'set-game-mode', mode: GameMode): void
  (e: 'toggle-pause'): void
  (e: 'step'): void
  (e: 'turn'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'replay'): void
  (e: 'fork'): void
  (e: 'set-speed', speed: number): void
  (e: 'toggle-overlay', key: keyof OverlayFlags): void
  (e: 'toggle-sound'): void
  (e: 'reset'): void
  (e: 'open-maps'): void
  (e: 'toggle-editor'): void
  (e: 'toggle-hud'): void
  (e: 'toggle-auto-preserve'): void
  (e: 'toggle-capture-advance'): void
  (e: 'toggle-chess-kills'): void
  (e: 'toggle-promotion'): void
}>()

const speeds = SPEEDS
const overlayKeys: Array<{ key: keyof OverlayFlags; label: string }> = [
  { key: 'myOrders', label: 'my orders (o)' },
  { key: 'enemyPlans', label: 'enemy plans' },
  { key: 'moveCells', label: 'move' },
  { key: 'attackCells', label: 'attack' },
  { key: 'rangeArcs', label: 'range' },
  { key: 'grid', label: 'grid' },
  { key: 'health', label: 'health' },
  { key: 'reload', label: 'firing recharge' },
  { key: 'healing', label: 'show healing' },
  { key: 'advantage', label: "who's winning" },
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

function onSoundChange(event: Event): void {
  emit('toggle-sound')
  ;(event.target as HTMLInputElement).blur()
}
</script>

<template>
  <header class="toolbar">
    <div class="brand">Bar Chess</div>

    <button class="ctl" @click="emit('reset')">New game</button>
    <button class="ctl" @click="emit('open-maps')">New from template…</button>
    <button
      class="ctl"
      :class="{ active: props.snapshot.editorMode }"
      :disabled="!props.snapshot.editorMode && !props.snapshot.canEdit"
      title="place pieces and set up starting positions"
      @click="emit('toggle-editor')"
    >
      {{ props.snapshot.editorMode ? '✓ Editor' : 'Editor' }}
    </button>

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

    <span
      class="turn-badge"
      :class="{ active: props.snapshot.turnActive, mega: props.snapshot.megaTurn }"
      :title="
        props.snapshot.megaTurn
          ? 'current mega turn (continuous play burst) · u/r to undo/redo'
          : 'current turn (u/r to undo/redo)'
      "
    >
      {{ props.snapshot.megaTurn ? 'Mega' : 'Turn' }} <b>{{ props.snapshot.turn }}</b>
    </span>

    <button class="ctl" :class="{ active: props.snapshot.turnActive }" :disabled="!!props.snapshot.winner" @click="emit('turn')" title="next turn — or replay forward while viewing an earlier turn (space)">
      {{ props.snapshot.turnActive ? '⏵ Turn…' : '⏵ Turn' }}
    </button>
    <button
      class="ctl"
      :class="{ active: props.snapshot.playing }"
      :disabled="!!props.snapshot.winner"
      @click="emit('toggle-pause')"
      title="play forward through history, then continuously — a mega turn (shift+space)"
    >
      {{ props.snapshot.paused ? '▶ Play' : '⏸ Pause' }}
    </button>
    <button class="ctl" :disabled="!!props.snapshot.winner" @click="emit('step')">⏭ Step</button>
    <button class="ctl" :disabled="!props.snapshot.canUndo" @click="emit('undo')">↶ Undo</button>
    <button class="ctl" :disabled="!props.snapshot.canRedo" @click="emit('redo')">↷ Redo</button>
    <button class="ctl" :disabled="!props.snapshot.canReplay" @click="emit('replay')">↺ Replay</button>
    <button
      class="ctl"
      :disabled="!props.snapshot.canRedo || props.snapshot.turnActive || props.snapshot.replaying"
      @click="emit('fork')"
      title="start a new path from here — discards the redone turns (f)"
    >
      ⑂ Fork
    </button>

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

    <div class="spacer"></div>

    <label class="toggle sound-toggle">
      <input
        type="checkbox"
        :checked="props.snapshot.soundEnabled"
        @change="onSoundChange"
      />
      sound
    </label>

    <label v-for="o in overlayKeys" :key="o.key" class="toggle">
      <input
        type="checkbox"
        :checked="props.snapshot.overlays[o.key]"
        @change="onOverlayChange(o.key, $event)"
      />
      {{ o.label }}
    </label>

    <label class="toggle" title="Hurt pieces step out of fire on their own, even without orders">
      <input type="checkbox" :checked="props.snapshot.autoPreserve" @change="emit('toggle-auto-preserve')" />
      auto-preserve
    </label>

    <label class="toggle" title="An idle killer steps onto the square of the piece it just killed (chess capture)">
      <input type="checkbox" :checked="props.snapshot.captureAdvance" @change="emit('toggle-capture-advance')" />
      capture advance
    </label>

    <label class="toggle" title="Insta-kill: ordering a move or attack kills instantly (next tick, pressed even when wounded) when the target is already within chess capture range">
      <input type="checkbox" :checked="props.snapshot.chessKills" @change="emit('toggle-chess-kills')" />
      chess kills
    </label>

    <label class="toggle" title="A pawn that reaches the enemy back rank becomes a queen">
      <input type="checkbox" :checked="props.snapshot.promotion" @change="emit('toggle-promotion')" />
      promotion
    </label>

    <button class="ctl" @click="emit('toggle-hud')">{{ props.snapshot.hudVisible ? 'Hide HUD' : 'Show HUD' }}</button>
  </header>
</template>
