<script setup lang="ts">
import { ref } from 'vue'
import { BOARD_SIZES } from '../game/boards'
import type { BoardSize } from '../game/boards'
import { mapPieceCounts } from '../game/map'
import type { SavedMap } from '../game/map'
import MapThumbnail from './MapThumbnail.vue'

const props = defineProps<{ maps: SavedMap[]; currentId: string | null }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'play', id: string): void
  (e: 'edit', id: string): void
  (e: 'rename', id: string): void
  (e: 'delete', id: string): void
  (e: 'export', map: SavedMap): void
  (e: 'import'): void
  (e: 'new-map', size: BoardSize): void
}>()

const newSize = ref<BoardSize>(8)

function onNewSize(event: Event): void {
  newSize.value = Number((event.target as HTMLSelectElement).value) as BoardSize
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <div class="modal-backdrop" @pointerdown.self="emit('close')">
    <div class="modal maps-modal">
      <header class="modal-head">
        <span class="modal-title">maps</span>
        <div class="maps-new">
          <select class="ctl" :value="newSize" @change="onNewSize">
            <option v-for="s in BOARD_SIZES" :key="s" :value="s">blank {{ s }}×{{ s }}</option>
          </select>
          <button class="ctl" @click="emit('new-map', newSize)">New map</button>
          <button class="ctl" @click="emit('import')">Import JSON</button>
        </div>
        <button class="ctl small modal-close" title="close" @click="emit('close')">✕</button>
      </header>

      <p v-if="!props.maps.length" class="maps-empty">
        No saved maps yet. Open the editor, place pieces, then save one here.
      </p>

      <ul v-else class="map-grid">
        <li
          v-for="m in props.maps"
          :key="m.id"
          class="map-card"
          :class="{ current: m.id === props.currentId }"
        >
          <MapThumbnail :map="m" />
          <div class="map-info">
            <strong class="map-name">{{ m.name }}</strong>
            <span class="map-meta">
              {{ m.board.width }}×{{ m.board.height }} ·
              {{ mapPieceCounts(m).red }} v {{ mapPieceCounts(m).blue }} ·
              {{ fmt(m.savedAt) }}
            </span>
          </div>
          <div class="map-actions">
            <button class="ctl small primary" @click="emit('play', m.id)">Play</button>
            <button class="ctl small" @click="emit('edit', m.id)">Edit</button>
            <button class="ctl small" @click="emit('rename', m.id)">Rename</button>
            <button class="ctl small" @click="emit('export', m)">Export</button>
            <button class="ctl small danger" @click="emit('delete', m.id)">Delete</button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
