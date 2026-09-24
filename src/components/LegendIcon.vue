<script setup lang="ts">
import {
  BAR_BG,
  ENGAGE_COLOR,
  POTSHOT_COLOR,
  PRESERVE_COLOR,
  RELOAD_FILL,
  ROUTE_COLOR,
  SELECT_COLOR,
  STANCE_ATTACK_COLOR,
  STANCE_MOVE_COLOR,
  TRACK_COLOR,
  UNREACHABLE_COLOR,
  healthColor,
} from '../render/palette'

defineProps<{ kind: string }>()

const HEALTH_FILL = healthColor(0.75)
const MOVE_CELL = 'rgba(90,176,255,0.28)'
const MOVE_CELL_EDGE = 'rgba(90,176,255,0.8)'
const ATTACK_CELL = 'rgba(255,90,70,0.9)'
const RANGE_ARC = 'rgba(90,176,255,0.65)'
const NONE_COLOR = '#7d8794'
</script>

<template>
  <svg class="legend-icon" viewBox="0 0 18 14" width="18" height="14" aria-hidden="true">
    <!-- movement / attack cells -->
    <template v-if="kind === 'move-cell'">
      <rect x="2" y="2" width="14" height="10" :fill="MOVE_CELL" :stroke="MOVE_CELL_EDGE" />
    </template>
    <template v-else-if="kind === 'attack-cell'">
      <rect x="2" y="2" width="14" height="10" fill="none" :stroke="ATTACK_CELL" stroke-width="2" />
    </template>
    <template v-else-if="kind === 'range-arc'">
      <path d="M2 11 A9 9 0 0 1 16 11" fill="none" :stroke="RANGE_ARC" stroke-width="2" stroke-dasharray="3 2" />
    </template>

    <!-- routes / objectives -->
    <template v-else-if="kind === 'route'">
      <line x1="2" y1="7" x2="16" y2="7" :stroke="ROUTE_COLOR" stroke-width="2" stroke-dasharray="4 3" />
    </template>
    <template v-else-if="kind === 'objective'">
      <path d="M9 2 L16 7 L9 12 L2 7 Z" fill="none" :stroke="ROUTE_COLOR" stroke-width="2" />
    </template>
    <template v-else-if="kind === 'preserve'">
      <line x1="2" y1="7" x2="16" y2="7" :stroke="PRESERVE_COLOR" stroke-width="2" stroke-dasharray="4 3" />
    </template>
    <template v-else-if="kind === 'waypoint'">
      <circle cx="9" cy="7" r="6" :fill="ROUTE_COLOR" />
      <text x="9" y="10" text-anchor="middle" font-size="8" font-family="ui-monospace, monospace" fill="#0b0f16">1</text>
    </template>
    <template v-else-if="kind === 'select-ring'">
      <circle cx="9" cy="7" r="5" fill="none" :stroke="SELECT_COLOR" stroke-width="2" />
    </template>

    <!-- bars -->
    <template v-else-if="kind === 'bar-health'">
      <rect x="1" y="5" width="16" height="4" :fill="BAR_BG" />
      <rect x="1" y="5" width="11" height="4" :fill="HEALTH_FILL" />
    </template>
    <template v-else-if="kind === 'bar-reload'">
      <rect x="1" y="5" width="16" height="4" :fill="BAR_BG" />
      <rect x="1" y="5" width="8" height="4" :fill="RELOAD_FILL" />
    </template>

    <!-- firing lines -->
    <template v-else-if="kind === 'line-clear'">
      <line x1="1" y1="7" x2="11" y2="7" :stroke="TRACK_COLOR" stroke-width="2" />
      <circle cx="14" cy="7" r="3" fill="none" :stroke="TRACK_COLOR" stroke-width="2" />
    </template>
    <template v-else-if="kind === 'line-blocked'">
      <line x1="1" y1="7" x2="17" y2="7" :stroke="TRACK_COLOR" stroke-width="2" stroke-dasharray="3 3" />
    </template>
    <template v-else-if="kind === 'line-unreachable'">
      <line x1="1" y1="7" x2="17" y2="7" :stroke="UNREACHABLE_COLOR" stroke-width="2" stroke-dasharray="3 3" />
    </template>
    <template v-else-if="kind === 'line-engage'">
      <line x1="1" y1="7" x2="11" y2="7" :stroke="ENGAGE_COLOR" stroke-width="2" />
      <circle cx="14" cy="7" r="3" fill="none" :stroke="ENGAGE_COLOR" stroke-width="2" />
    </template>
    <template v-else-if="kind === 'line-potshot'">
      <line x1="1" y1="7" x2="17" y2="7" :stroke="POTSHOT_COLOR" stroke-width="2" stroke-dasharray="3 3" />
    </template>

    <!-- stance badges -->
    <template v-else-if="kind === 'badge-m'">
      <circle cx="9" cy="7" r="6" :fill="STANCE_MOVE_COLOR" />
      <text x="9" y="10" text-anchor="middle" font-size="8" font-weight="bold" font-family="ui-monospace, monospace" fill="#0b0f16">M</text>
    </template>
    <template v-else-if="kind === 'badge-a'">
      <circle cx="9" cy="7" r="6" :fill="STANCE_ATTACK_COLOR" />
      <text x="9" y="10" text-anchor="middle" font-size="8" font-weight="bold" font-family="ui-monospace, monospace" fill="#0b0f16">A</text>
    </template>
    <template v-else-if="kind === 'badge-none'">
      <circle cx="9" cy="7" r="6" fill="none" :stroke="NONE_COLOR" stroke-width="2" stroke-dasharray="3 3" />
    </template>

    <!-- target rings (reticle: circle + cross) -->
    <template v-else-if="kind === 'ring-red'">
      <circle cx="9" cy="7" r="5" fill="none" :stroke="TRACK_COLOR" stroke-width="2" />
      <line x1="2.5" y1="7" x2="15.5" y2="7" :stroke="TRACK_COLOR" stroke-width="1.5" />
      <line x1="9" y1="0.5" x2="9" y2="13.5" :stroke="TRACK_COLOR" stroke-width="1.5" />
    </template>
    <template v-else-if="kind === 'ring-amber'">
      <circle cx="9" cy="7" r="5" fill="none" :stroke="ENGAGE_COLOR" stroke-width="2" />
      <line x1="2.5" y1="7" x2="15.5" y2="7" :stroke="ENGAGE_COLOR" stroke-width="1.5" />
      <line x1="9" y1="0.5" x2="9" y2="13.5" :stroke="ENGAGE_COLOR" stroke-width="1.5" />
    </template>
  </svg>
</template>

<style scoped>
.legend-icon {
  display: inline-block;
  vertical-align: middle;
  margin-right: 6px;
}
</style>
