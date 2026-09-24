<script setup lang="ts">
import type { TeamSnapshot } from '../game/game'

const props = defineProps<{ team: TeamSnapshot; side: 'left' | 'right' }>()
const emit = defineEmits<{
  (e: 'deploy', key: string): void
  (e: 'grab', payload: { key: string; x: number; y: number }): void
}>()

function blocked(key: string): boolean {
  const p = props.team.pieces.find((x) => x.key === key)
  if (!p) return true
  return p.alive >= p.cap
}

function onGrab(key: string, event: PointerEvent): void {
  emit('grab', { key, x: event.clientX, y: event.clientY })
}

function onClick(key: string): void {
  if (!blocked(key)) emit('deploy', key)
}
</script>

<template>
  <aside class="roster" :class="side">
    <header class="roster-head" :style="{ borderColor: team.color }">
      <span class="roster-name" :style="{ color: team.color }">{{ team.name }}</span>
      <span class="roster-stat">{{ team.alive }} alive · {{ team.kills }} kills</span>
    </header>
    <button
      v-for="p in team.pieces"
      :key="p.key"
      class="unit-card"
      :class="{ blocked: blocked(p.key) }"
      :style="{ '--team': team.color }"
      :aria-disabled="blocked(p.key)"
      :title="blocked(p.key) ? 'at population cap — drag to place anyway' : 'click to deploy · drag onto a square to place'"
      @pointerdown="onGrab(p.key, $event)"
      @click="onClick(p.key)"
    >
      <span class="card-glyph" :style="{ color: team.color }">{{ p.glyph }}</span>
      <span class="card-body">
        <span class="card-title">
          <strong>{{ p.name }}</strong>
          <em>{{ p.supply }} supply</em>
        </span>
        <span class="card-meta">build {{ p.cost }}s · {{ p.alive }}/{{ p.cap }}</span>
      </span>
    </button>
  </aside>
</template>
