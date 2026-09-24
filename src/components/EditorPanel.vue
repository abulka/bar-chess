<script setup lang="ts">
import { ref } from 'vue'
import { BOARD_SIZES } from '../game/boards'
import type { BoardSize } from '../game/boards'
import type { EditorBrushSnapshot } from '../game/game'

const props = withDefaults(
  defineProps<{
    mapName: string
    size: number
    brush: EditorBrushSnapshot | null
    dirty: boolean
    docked?: boolean
  }>(),
  { docked: false },
)

const emit = defineEmits<{
  (e: 'update:mapName', name: string): void
  (e: 'save'): void
  (e: 'done'): void
  (e: 'cancel'): void
  (e: 'new-map', size: BoardSize): void
  (e: 'open-maps'): void
  (e: 'toggle-erase'): void
}>()

const newSize = ref<BoardSize>(BOARD_SIZES.includes(props.size as BoardSize) ? (props.size as BoardSize) : 8)

function onName(event: Event): void {
  emit('update:mapName', (event.target as HTMLInputElement).value)
}

function onNewSize(event: Event): void {
  newSize.value = Number((event.target as HTMLSelectElement).value) as BoardSize
}

function onNewMap(): void {
  if (window.confirm('start a blank map? unsaved changes are lost')) emit('new-map', newSize.value)
}
</script>

<template>
  <div class="editor-panel" :class="{ docked: props.docked }">
    <div class="editor-head">
      <span class="editor-title">map editor</span>
      <span v-if="props.dirty" class="editor-dirty">unsaved changes</span>
    </div>

    <div class="editor-row">
      <input class="slot-input" :value="props.mapName" placeholder="map name" @input="onName" />
      <button class="ctl" @click="emit('save')">Save map</button>
    </div>

    <div class="editor-row">
      <span class="editor-brush">
        <template v-if="props.brush?.kind === 'erase'"><b>eraser</b> — click pieces to remove</template>
        <template v-else-if="props.brush"><b>{{ props.brush.name }}</b> — click the board to place</template>
        <span v-else class="muted">pick a piece from the side panels</span>
      </span>
      <button
        class="ctl small"
        :class="{ active: props.brush?.kind === 'erase' }"
        @click="emit('toggle-erase')"
      >
        Eraser
      </button>
    </div>

    <div class="editor-row">
      <select class="ctl" :value="newSize" title="blank board size" @change="onNewSize">
        <option v-for="s in BOARD_SIZES" :key="s" :value="s">blank {{ s }}×{{ s }}</option>
      </select>
      <button class="ctl small" @click="onNewMap">New</button>
      <button class="ctl small" @click="emit('open-maps')">Maps…</button>
      <button class="ctl small" @click="emit('cancel')">Cancel</button>
      <button class="ctl small primary" @click="emit('done')">Done</button>
    </div>

    <p class="editor-hint">
      click or drag a piece from the side panels onto the board · right-click erases
    </p>
  </div>
</template>
