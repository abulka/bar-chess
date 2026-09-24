<script setup lang="ts">
import { computed, ref } from 'vue'
import { clamp } from '../game/math'

const props = withDefaults(
  defineProps<{
    modelValue: number
    min: number
    max: number
    step?: number
    label?: string
    unit?: string
    precision?: number
    /** logarithmic scale (frequencies); value must be > 0 */
    log?: boolean
    /** value restored on double-click */
    resetValue?: number
  }>(),
  { step: 0.01, precision: 2, log: false, unit: '', label: '' },
)

const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>()

const CX = 24
const CY = 24
const R = 18
const A0 = -135
const A1 = 135

function logMin(): number {
  return Math.log(Math.max(1e-4, props.min))
}
function logMax(): number {
  return Math.log(Math.max(1e-3, props.max))
}

function toNorm(v: number): number {
  if (props.log) return clamp((Math.log(Math.max(1e-4, v)) - logMin()) / (logMax() - logMin() || 1), 0, 1)
  return clamp((v - props.min) / (props.max - props.min || 1), 0, 1)
}

function fromNorm(t: number): number {
  const c = clamp(t, 0, 1)
  if (props.log) return Math.exp(logMin() + c * (logMax() - logMin()))
  return props.min + c * (props.max - props.min)
}

function snap(v: number): number {
  if (props.log || !props.step) return v
  return Math.round((v - props.min) / props.step) * props.step + props.min
}

const norm = computed(() => toNorm(props.modelValue))
const angle = computed(() => A0 + norm.value * (A1 - A0))
const display = computed(() => props.modelValue.toFixed(props.precision))

function point(angleDeg: number, r: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180
  return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) }
}

const trackPath = computed(() => {
  const a = point(A0, R)
  const b = point(A1, R)
  return `M ${a.x} ${a.y} A ${R} ${R} 0 1 1 ${b.x} ${b.y}`
})

const valuePath = computed(() => {
  const a = point(A0, R)
  const b = point(angle.value, R)
  const large = angle.value - A0 > 180 ? 1 : 0
  return `M ${a.x} ${a.y} A ${R} ${R} 0 ${large} 1 ${b.x} ${b.y}`
})

const pointer = computed(() => ({
  inner: point(angle.value, R * 0.34),
  outer: point(angle.value, R * 0.82),
}))

const active = ref(false)
let startY = 0
let startNorm = 0

function commit(value: number): void {
  emit('update:modelValue', clamp(snap(value), props.min, props.max))
}

function onPointerDown(event: PointerEvent): void {
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  startY = event.clientY
  startNorm = norm.value
  active.value = true
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!active.value) return
  const fine = event.shiftKey ? 5 : 1
  commit(fromNorm(startNorm + (startY - event.clientY) / (160 * fine)))
}

function onPointerUp(event: PointerEvent): void {
  if (!active.value) return
  active.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  commit(fromNorm(norm.value - event.deltaY * 0.0015))
}

function onKey(event: KeyboardEvent): void {
  const s = props.step || (props.max - props.min) / 100
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
    commit(props.modelValue + s)
    event.preventDefault()
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
    commit(props.modelValue - s)
    event.preventDefault()
  }
}

function onReset(): void {
  commit(props.resetValue ?? props.min + (props.max - props.min) / 2)
}

function onInput(event: Event): void {
  commit(Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="knob" :class="{ active }">
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      tabindex="0"
      role="slider"
      :aria-label="label"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="modelValue"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @wheel="onWheel"
      @keydown="onKey"
      @dblclick="onReset"
    >
      <path :d="trackPath" class="track" />
      <path :d="valuePath" class="value" />
      <line :x1="pointer.inner.x" :y1="pointer.inner.y" :x2="pointer.outer.x" :y2="pointer.outer.y" class="needle" />
    </svg>
    <div class="knob-meta">
      <span class="knob-label">{{ label }}<span v-if="unit" class="knob-unit"> ({{ unit }})</span></span>
      <input class="knob-input" type="number" :step="step" :value="display" @change="onInput" />
    </div>
  </div>
</template>

<style scoped>
.knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  user-select: none;
}

.knob svg {
  cursor: ns-resize;
  touch-action: none;
  outline: none;
}

.knob svg:focus-visible .track {
  stroke: var(--blue);
}

.track {
  fill: none;
  stroke: #0006;
  stroke-width: 4;
  stroke-linecap: round;
}

.value {
  fill: none;
  stroke: var(--accent);
  stroke-width: 4;
  stroke-linecap: round;
}

.needle {
  stroke: var(--text);
  stroke-width: 2;
  stroke-linecap: round;
}

.knob-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.knob-label {
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.knob-input {
  width: 54px;
  text-align: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 10px;
  padding: 1px 2px;
}

.knob.active .value {
  stroke: var(--blue);
}
</style>
