<script setup lang="ts">
import type { TeamSnapshot } from '../game/game'

const props = defineProps<{ team: TeamSnapshot; side: 'left' | 'right' }>()
const emit = defineEmits<{ (e: 'deploy', key: string): void }>()

function blocked(key: string): boolean {
  const p = props.team.pieces.find((x) => x.key === key)
  if (!p) return true
  return p.alive >= p.cap
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
      :disabled="blocked(p.key)"
      @click="emit('deploy', p.key)"
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
