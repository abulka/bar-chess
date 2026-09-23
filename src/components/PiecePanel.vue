<script setup lang="ts">
import { computed } from 'vue'
import type { GameSnapshot } from '../game/game'
import type { StanceMode } from '../game/types'
import { PRESERVE_COLOR, healthColor } from '../render/palette'

const props = defineProps<{
  snapshot: GameSnapshot
}>()

const emit = defineEmits<{
  (e: 'set-stance', mode: StanceMode): void
  (e: 'clear-orders'): void
}>()

const stances: Array<{ id: StanceMode; label: string; title: string }> = [
  { id: 'none', label: 'None', title: 'None: stand ground, fire only at enemies already in range' },
  { id: 'move', label: 'Move', title: 'Move: travel, return fire only' },
  { id: 'attack', label: 'Attack', title: 'Attack: auto-engage nearby enemies, flee when low' },
]

/** Human labels for the source of the current motion goal. */
const INTENT_LABEL: Record<string, string> = {
  none: '',
  order: 'ordered',
  preserve: 'self-preservation',
  defense: 'AI defense',
  engage: 'engaging',
  rally: 'rally',
}

const info = computed(() => props.snapshot.pieceInfo)
const summary = computed(() => props.snapshot.stanceSummary)
const activeStance = computed<StanceMode | null>(() =>
  info.value && !summary.value.mixed ? info.value.stance : null,
)
const intent = computed(() => info.value?.motion.intent ?? 'none')
const intentLabel = computed(() => INTENT_LABEL[intent.value] ?? intent.value)
/** An autonomous goal (not a player order) — shown as an "auto" pseudo-order. */
const isAuto = computed(() => intent.value !== 'none' && intent.value !== 'order')
const orderIdle = computed(() => !info.value || info.value.order.kind === 'none')
/**
 * A committed piece will pursue its target: an AI controller always does, and a
 * human piece does in Attack stance. A None/Move piece only fires at whatever is
 * already in range and never follows it — a stationary "pot shot".
 */
const committed = computed(() =>
  info.value ? !info.value.commandable || info.value.stance === 'attack' : true,
)
const targetHeading = computed(() =>
  info.value?.target ? (committed.value ? 'engaging' : 'pot shot') : 'target',
)

function pct(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
}

/** Health is a float (aura regen ticks), so round it for display. */
function hp(value: number): number {
  return Math.round(value)
}

/** A weapon that has never fired is simply ready; otherwise show its recharge. */
function reloadRatio(w: { left: number; cooldown: number; fired: boolean }): number {
  if (!w.fired || w.cooldown <= 0) return 1
  return 1 - w.left / w.cooldown
}
</script>

<template>
  <div class="piece-panel">
    <div class="rail-title">piece</div>

    <p v-if="!info" class="line muted">select a piece to inspect it</p>

    <template v-else>
      <div class="head">
        <span class="glyph" :style="{ color: info.color }">{{ info.glyph }}</span>
        <div class="head-text">
          <b>{{ info.name }}</b>
          <span class="muted">{{ info.team }} · {{ info.coord }} · #{{ info.entity }}</span>
        </div>
      </div>

      <div class="stat">
        <span class="stat-label">health</span>
        <div class="bar">
          <div class="fill hp" :style="{ width: pct(info.health.ratio), background: healthColor(info.health.ratio) }"></div>
        </div>
        <span class="num">{{ hp(info.health.cur) }}/{{ hp(info.health.max) }}</span>
      </div>

      <div v-if="info.weapon" class="stat">
        <span class="stat-label">reload</span>
        <div class="bar">
          <div class="fill reload" :style="{ width: pct(reloadRatio(info.weapon)) }"></div>
        </div>
        <span class="num">{{ !info.weapon.fired || info.weapon.ready ? 'ready' : info.weapon.left.toFixed(1) + 's' }}</span>
      </div>

      <div class="sub">stance</div>
      <div class="stance-row">
        <button
          v-for="s in stances"
          :key="s.id"
          class="ctl small"
          :class="{ active: activeStance === s.id }"
          :title="s.title"
          :disabled="!info.commandable"
          @click="emit('set-stance', s.id)"
        >
          {{ s.label }}
        </button>
      </div>
      <p v-if="summary.mixed" class="line muted tiny">
        mixed selection — {{ summary.none }} none · {{ summary.move }} move · {{ summary.attack }} attack
      </p>
      <p v-if="!info.commandable" class="line muted tiny">not under your control</p>

      <div class="sub">{{ targetHeading }}</div>
      <p v-if="info.target" class="line">
        <span :style="{ color: info.target.color }">{{ info.target.glyph }}</span>
        {{ info.target.name }} @ {{ info.target.coord }}
        <span v-if="info.target.health" class="muted">({{ hp(info.target.health.cur) }}/{{ hp(info.target.health.max) }})</span>
      </p>
      <p v-else class="line muted">no target</p>
      <p v-if="info.target && !committed" class="line muted tiny">
        in range only — {{ info.motion.goalCoord ? 'not pursuing' : 'holding position, not pursuing' }}
      </p>
      <p v-if="info.underFire" class="line warn">under fire from {{ info.underFire.coord }}</p>

      <div class="sub">order</div>
      <p class="line">
        <b>{{ info.order.kind }}</b>
        <span v-if="info.order.destCoord"> · dest {{ info.order.destCoord }}</span>
        <span v-if="info.order.target"> · target {{ info.order.target.coord }}</span>
        <span v-if="info.order.kind !== 'none'" class="muted"> · manual</span>
        <span v-if="info.order.kind !== 'none' && !info.order.reachable" class="unreachable"> (unreachable)</span>
      </p>
      <p v-if="isAuto && orderIdle" class="line">
        <b>auto</b> ·
        <span class="intent" :style="intent === 'preserve' ? { color: PRESERVE_COLOR } : undefined">
          {{ intentLabel }}
        </span>
        <span v-if="info.motion.goalCoord" class="muted"> → {{ info.motion.goalCoord }}</span>
      </p>

      <div v-if="info.order.history.length" class="sub">order / auto changes</div>
      <ol v-if="info.order.history.length" class="order-log">
        <li v-for="(h, i) in info.order.history" :key="i">
          <span class="muted">t{{ h.tick }}</span> {{ h.text }}
        </li>
      </ol>

      <div class="sub">movement</div>
      <p class="line">
        <span v-if="info.motion.goalCoord">goal {{ info.motion.goalCoord }} · </span>
        <span v-else>{{ info.target && !committed ? 'holding position' : 'no goal' }} · </span>
        <span
          v-if="intentLabel"
          class="intent"
          :style="intent === 'preserve' ? { color: PRESERVE_COLOR } : undefined"
        >{{ intentLabel }} · </span>
        path {{ info.motion.pathLength }}
        <span v-if="info.motion.blocked"> · blocked</span>
        <span v-if="info.motion.moving"> · moving</span>
      </p>

      <div class="sub">queue ({{ info.order.queue.length }})</div>
      <ol v-if="info.order.queue.length" class="queue">
        <li v-for="(q, i) in info.order.queue" :key="i">
          {{ q.label }}
          <span class="muted"> · {{ q.source }}</span>
          <span v-if="!q.reachable" class="unreachable"> (unreachable)</span>
        </li>
      </ol>
      <p v-else class="line muted">empty</p>

      <button class="ctl clear" :disabled="!info.commandable" @click="emit('clear-orders')">
        Clear orders (c)
      </button>
    </template>
  </div>
</template>

<style scoped>
.piece-panel {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head .glyph {
  font-size: 26px;
  line-height: 1;
  font-family: "Segoe UI Symbol", "Apple Symbols", serif;
}

.head-text {
  display: flex;
  flex-direction: column;
}

.head-text .muted {
  font-size: 0.9em;
}

.stat {
  display: grid;
  grid-template-columns: 42px 1fr auto;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
}

.stat-label {
  color: var(--muted);
}

.bar {
  height: 8px;
  background: rgba(8, 10, 14, 0.82);
  border-radius: 2px;
  overflow: hidden;
}

.fill {
  height: 100%;
}

.fill.hp {
  background: #4cd964;
}

.fill.reload {
  background: #15c2b6;
}

.num {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.sub {
  margin: 10px 0 2px;
  color: var(--heading);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.line {
  margin: 1px 0;
  color: var(--text);
}

.line.muted {
  color: var(--muted);
}

.line.tiny {
  font-size: 0.9em;
}

.line.warn {
  color: #ff9f43;
}

.line .unreachable {
  color: #ff9f43;
}

.line .intent {
  color: var(--muted);
}

.stance-row {
  display: flex;
  gap: 4px;
}

.queue {
  margin: 0;
  padding-left: 18px;
  color: var(--muted);
  line-height: 1.6;
}

.order-log {
  margin: 0;
  padding-left: 18px;
  color: var(--text);
  line-height: 1.5;
  font-size: 0.92em;
}

.order-log .muted {
  color: var(--muted);
}

.ctl.clear {
  margin-top: 8px;
  width: 100%;
}

.ctl:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
