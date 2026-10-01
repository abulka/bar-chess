<script setup lang="ts">
import { computed, ref } from 'vue'
import type { GameSnapshot } from '../game/game'
import { INTENT_LABELS } from '../game/intent'
import { INSTA_KILL_NAME } from '../game/instaKill'
import { selfPreservationThresholds } from '../game/selfPreservation'
import { PRESERVE_COLOR, healthColor } from '../render/palette'

const props = defineProps<{
  snapshot: GameSnapshot
}>()

const emit = defineEmits<{
  (e: 'clear-orders'): void
}>()

/** Human labels for the source of the current motion goal. */
const info = computed(() => props.snapshot.pieceInfo)
const intent = computed(() => info.value?.motion.intent ?? 'none')
const intentLabel = computed(() => INTENT_LABELS[intent.value] ?? intent.value)
/** An autonomous goal (not a player order) — shown as an "auto" pseudo-order. */
const isAuto = computed(() => intent.value !== 'none' && intent.value !== 'order')
const orderIdle = computed(() => !info.value || info.value.order.kind === 'none')

/**
 * The piece's current task, derived from its order (and the AI's own motion):
 * Move with its destination, Attack with its target, Idle, or Auto for an AI
 * piece that acts on its own. Read-only: orders are given on the board.
 */
const status = computed<{ label: string; detail: string } | null>(() => {
  const i = info.value
  if (!i) return null
  if (!i.commandable) {
    return { label: 'Auto', detail: intent.value === 'none' ? '' : intentLabel.value }
  }
  if (i.order.kind === 'goto') return { label: 'Move', detail: i.order.destCoord ?? '' }
  if (i.order.kind === 'attack') return { label: 'Attack', detail: i.order.target?.coord ?? '' }
  return { label: 'Idle', detail: '' }
})

/**
 * A committed piece will pursue its target: an AI controller always does, and a
 * human piece does while it has an attack order (a standing chase). An idle
 * piece with only an auto-acquired target fires at whatever is already in range
 * and never follows it — a stationary "pot shot".
 */
const committed = computed(() => {
  const i = info.value
  if (!i) return true
  if (!i.commandable) return true
  return i.order.kind === 'attack'
})
const targetHeading = computed(() =>
  info.value?.target ? (committed.value ? 'engaging' : 'pot shot') : 'target',
)
/** Player-facing name for the parked insta-kill (immediate chess kill). */
const instaKillName = INSTA_KILL_NAME
/** A standing attack order that self-preservation is currently interrupting. */
const preserveOverride = computed(
  () => info.value?.order.kind === 'attack' && intent.value === 'preserve',
)
/**
 * Remaining turns of a player "no-preserve" insist order (0 when none). The
 * order stores the first turn self-preservation may run again, so the count is
 * that turn minus the current one. While play is paused the current turn has not
 * run yet, so one is subtracted to keep the readout honest ("2 turns" when the
 * order is given, not 3).
 */
const noPreserveLeft = computed(() => {
  const until = info.value?.order.noPreserveUntil ?? -1
  if (until < 0) return 0
  const base = until - props.snapshot.turn
  return Math.max(0, props.snapshot.turnActive ? base : base - 1)
})

/** Whether the automatic retreat rule applies to this piece right now. */
const preserve = computed(() => info.value?.preserve ?? null)
const preserveOff = computed(() => !!preserve.value && !preserve.value.active)
/**
 * A one-line explanation for an inactive self-preservation state, so the player
 * knows when (or why) it comes back — or that it will not.
 */
const preserveReason = computed(() => {
  const p = preserve.value
  if (!p || p.active) return ''
  switch (p.reason) {
    case 'insist': {
      const n = noPreserveLeft.value
      return `auto-restores in ${n} turn${n === 1 ? '' : 's'}`
    }
    case 'finishing':
      return 'finishing phase — no retreat until the enemy king falls'
    case 'rule':
      return 'the auto-preserve rule is off'
    case 'pawn':
      return 'pawns never retreat — they hold and fire instead'
    case 'ai-king':
      return 'the king holds its post'
    default:
      return ''
  }
})

/** Pawns can never retreat (they only step forward), so they show no notches. */
const isPawn = computed(() => info.value?.kind === 'pawn')

/** Plain explanation of why a blocked route is not advancing. */
const blockedReasonLabel = computed<string | null>(() => {
  const reason = info.value?.motion.blockedReason
  if (!reason) return null
  if (reason === 'enemy-fire') return 'the destination is under enemy fire — Alt-click the order to insist'
  if (reason === 'check') return 'the destination is in check — a king may not step there'
  if (reason === 'unreachable') return 'this piece can never reach the destination'
  return 'the way is blocked by a wall or another piece'
})

/** This piece's health thresholds for the two notches, shared with the sim rules. */
const thresholds = computed(() => selfPreservationThresholds(info.value?.kind ?? ''))

/** Instant hover hints for the bar regions, describing what happens in each. */
const zoneHints = computed(() => {
  const t = thresholds.value
  return {
    critical: `below ${pct(t.critical)} — critical: pulls back and waits until fully healed`,
    hurt: `below ${pct(t.preserve)} — hurt: pulls back to a healing square, returns once recovered`,
    healthy: `${pct(t.preserve)} or more — no automatic retreat`,
  }
})

/** An instant tooltip for the bar regions (native title has a visible delay). */
const hoverHint = ref<{ text: string; x: number; y: number; maxW: number } | null>(null)
function showHint(event: MouseEvent, text: string): void {
  const el = event.currentTarget as HTMLElement
  const panel = el.closest('.piece-panel') as HTMLElement | null
  if (!panel) return
  const panelRect = panel.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  // Centre the tip in the (narrow) panel and cap its width so it wraps instead
  // of spilling past the rail.
  hoverHint.value = {
    text,
    x: panelRect.width / 2,
    y: rect.top - panelRect.top,
    maxW: Math.max(120, panelRect.width - 12),
  }
}
function hideHint(): void {
  hoverHint.value = null
}

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

      <div class="stat health">
        <span class="stat-label">health</span>
        <div class="bar">
          <div class="fill hp" :style="{ width: pct(info.health.ratio), background: healthColor(info.health.ratio) }"></div>
          <template v-if="!isPawn">
            <span class="notch" :style="{ left: pct(thresholds.critical) }"></span>
            <span class="notch" :style="{ left: pct(thresholds.preserve) }"></span>
            <span
              class="zone"
              :style="{ left: '0', width: pct(thresholds.critical) }"
              @mouseenter="showHint($event, zoneHints.critical)"
              @mouseleave="hideHint"
            ></span>
            <span
              class="zone"
              :style="{ left: pct(thresholds.critical), width: pct(thresholds.preserve - thresholds.critical) }"
              @mouseenter="showHint($event, zoneHints.hurt)"
              @mouseleave="hideHint"
            ></span>
            <span
              class="zone"
              :style="{ left: pct(thresholds.preserve), right: '0' }"
              @mouseenter="showHint($event, zoneHints.healthy)"
              @mouseleave="hideHint"
            ></span>
          </template>
          <span
            v-else
            class="zone"
            :style="{ left: '0', right: '0' }"
            @mouseenter="showHint($event, 'pawns never retreat — they hold and fire instead')"
            @mouseleave="hideHint"
          ></span>
        </div>
        <span class="num">{{ pct(info.health.ratio) }}</span>
      </div>

      <div v-if="info.weapon" class="stat">
        <span class="stat-label">reload</span>
        <div class="bar">
          <div class="fill reload" :style="{ width: pct(reloadRatio(info.weapon)) }"></div>
        </div>
        <span class="num">{{ !info.weapon.fired || info.weapon.ready ? 'ready' : info.weapon.left.toFixed(1) + 's' }}</span>
      </div>

      <div class="sub">status</div>
      <div class="pill-row">
        <p v-if="status" class="status-pill" :class="status.label.toLowerCase()">
          <b>{{ status.label }}</b>
          <span v-if="status.detail" class="muted"> · {{ status.detail }}</span>
        </p>
        <p
          v-if="preserve"
          class="status-pill preserve"
          :class="preserveOff ? 'off' : 'on'"
          :title="preserveOff ? preserveReason : 'retreats this piece when it is hurt or under fire'"
        >
          <b>self-preservation</b> <span class="muted">{{ preserveOff ? 'off' : 'on' }}</span>
        </p>
      </div>
      <p v-if="preserveOff && preserveReason" class="line tiny preserve-note">
        {{ preserveReason }}
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
      <p
        v-if="info.order.instaKill"
        class="line insta-kill"
        title="Immediate chess kill — pressed next tick regardless of wounds"
      >
        <b>insta-kill</b> · {{ instaKillName }} · target {{ info.order.instaKill.coord }}
      </p>
      <p v-if="preserveOverride" class="line warn">
        self-preservation overriding the attack order — resumes after healing
      </p>
      <p v-if="noPreserveLeft > 0" class="line no-preserve">
        <b>no-preserve</b> · self-preservation off for
        {{ noPreserveLeft }} more turn{{ noPreserveLeft === 1 ? '' : 's' }} — pressing this order
      </p>
      <p
        v-else-if="info.order.kind === 'attack' && !info.order.reachable"
        class="line muted tiny"
      >
        target unreachable —
        {{ info.motion.pathLength > 0 ? 'moving to the nearest point' : 'at the nearest point' }}
      </p>
      <p v-if="isAuto && orderIdle" class="line">
        <b>auto</b> ·
        <span class="intent" :style="intent === 'preserve' ? { color: PRESERVE_COLOR } : undefined">
          {{ intentLabel }}
        </span>
        <span v-if="info.motion.goalCoord" class="muted"> → {{ info.motion.goalCoord }}</span>
      </p>

      <div v-if="info.order.history.length" class="sub">order / auto changes</div>
      <ul v-if="info.order.history.length" class="order-log">
        <li v-for="(h, i) in info.order.history" :key="i">
          <span class="muted">t{{ h.tick }}</span> {{ h.text }}
          <span v-if="i === 0" class="tag latest">latest</span>
          <span v-else-if="i === info.order.history.length - 1" class="tag oldest">oldest</span>
        </li>
      </ul>

      <div class="sub">movement</div>
      <p class="line">
        <span v-if="info.motion.goalCoord">goal {{ info.motion.goalCoord }} · </span>
        <span v-else>{{ intent === 'preserve' || (info.target && !committed) ? 'holding position' : 'no goal' }} · </span>
        <span
          v-if="intentLabel"
          class="intent"
          :style="intent === 'preserve' ? { color: PRESERVE_COLOR } : undefined"
        >{{ intentLabel }} · </span>
        <span v-if="info.motion.holdUntilHp > 0" class="hold">
          safe-hold until {{ hp(info.motion.holdUntilHp) }} hp ·
        </span>
        path {{ info.motion.pathLength }}
        <span v-if="info.motion.blocked"> · blocked</span>
        <span v-if="info.motion.moving"> · moving</span>
      </p>
      <p v-if="info.motion.blocked && blockedReasonLabel" class="line warn">
        blocked — {{ blockedReasonLabel }}
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

    <div
      v-if="hoverHint"
      class="bar-tip"
      :style="{ left: hoverHint.x + 'px', top: hoverHint.y + 'px', maxWidth: hoverHint.maxW + 'px' }"
    >
      {{ hoverHint.text }}
    </div>
  </div>
</template>

<style scoped>
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

.piece-panel {
  position: relative;
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
  position: relative;
  height: 8px;
  background: rgba(8, 10, 14, 0.82);
  border-radius: 2px;
  overflow: hidden;
}

/* The two self-preservation notches, drawn on the bar in grey so they read as
 * reference marks rather than health colour. A thin dark outline keeps each one
 * readable over both the dark frame and the health fill. */
.notch {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 1px;
  background: #9aa1ab;
  box-shadow: 0 0 0 1px rgba(8, 10, 14, 0.6);
}

/* Invisible regions tiling the bar; hovering one shows an instant hint. */
.zone {
  position: absolute;
  top: 0;
  bottom: 0;
  cursor: help;
}

/* Instant tooltip for the bar regions (native title has a visible delay). */
.bar-tip {
  position: absolute;
  transform: translate(-50%, -100%);
  margin-top: -6px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel-2, #12161d);
  color: var(--text);
  font-size: 0.85em;
  line-height: 1.35;
  text-align: center;
  white-space: normal;
  pointer-events: none;
  z-index: 5;
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

/* No-preserve insist override: gold, distinct from the preserve cyan/orange. */
.line.no-preserve {
  color: #ffd166;
}

/* Insta-kill (immediate chess kill): red like the ordered-target reticle. */
.line.insta-kill {
  color: #ff5a46;
}

.line .hold {
  color: #ff9f43;
}

.line .unreachable {
  color: #ff9f43;
}

.line .intent {
  color: var(--muted);
}

.status-pill {
  display: inline-block;
  margin: 0;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}

.status-pill.move {
  border-color: #4ad991;
}

.status-pill.attack {
  border-color: #ff3b30;
}

.status-pill.auto {
  border-style: dashed;
}

/* Status and self-preservation pills share one wrapping row. */
.pill-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* The preservation pill is dashed when on (a passive rule) and amber when a
 * force-order or a phase rule has switched the retreat off. The full term does
 * not fit the rail beside a long status, so it may wrap to two centred lines. */
.status-pill.preserve {
  white-space: normal;
  text-align: center;
}

/* Never split the term itself; let the on/off state drop to its own line. */
.status-pill.preserve b {
  white-space: nowrap;
}

.status-pill.preserve.on {
  border-style: dashed;
}

.status-pill.preserve.off {
  border-color: #ffd166;
  color: #ffd166;
}

.line.preserve-note {
  color: #ffd166;
  opacity: 0.85;
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

.order-log .tag {
  margin-left: 4px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 0.8em;
  color: var(--muted);
  vertical-align: 1px;
}

.order-log .tag.latest {
  color: var(--heading);
  border-color: var(--heading);
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
