<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  clearOverride,
  committedSpec,
  formatAllOverrides,
  formatEntry,
  overrideSource,
  setOverride,
  type OverrideSource,
} from '../audio/overrides'
import { cueSpec, type SoundCue } from '../audio/sounds'
import { isTone, type NoiseOptions, type ToneOptions, type VoiceEvent, type VoiceSpec } from '../audio/voices'
import Knob from './Knob.vue'

const props = defineProps<{ cue: SoundCue }>()
const emit = defineEmits<{
  (e: 'preview', spec: VoiceSpec): void
  (e: 'stop'): void
  (e: 'close'): void
}>()

const OSC_TYPES: Array<ToneOptions['type']> = ['sine', 'square', 'sawtooth', 'triangle']
const FILTER_TYPES: Array<NonNullable<NoiseOptions['filter']['type']>> = [
  'lowpass',
  'highpass',
  'bandpass',
  'notch',
]

function clone(spec: VoiceSpec): VoiceSpec {
  return JSON.parse(JSON.stringify(spec)) as VoiceSpec
}

function pretty(spec: VoiceSpec): string {
  return JSON.stringify(spec, null, 2)
}

function effective(): VoiceSpec {
  return cueSpec(props.cue.id) ?? clone(props.cue.builtin)
}

function specDuration(spec: VoiceSpec): number {
  let total = 0
  for (const event of spec) total = Math.max(total, (event.delay ?? 0) + event.duration)
  return total
}

const events = ref<VoiceSpec>(clone(effective()))
const activeIndex = ref(0)
const jsonText = ref(pretty(events.value))
const jsonError = ref('')
const copied = ref<'' | 'entry' | 'all'>('')
const source = ref<OverrideSource>(overrideSource(props.cue.id))
const loop = ref(false)

let skipJsonText = false
let editTimer = 0
let loopTimer = 0

const activeEvent = computed<VoiceEvent | undefined>(() => events.value[activeIndex.value])
const activeTone = computed<ToneOptions | null>(() => {
  const ev = activeEvent.value
  return ev && isTone(ev) ? ev : null
})

const badgeText = computed(() => {
  if (source.value === 'local') return 'override loaded (saved)'
  if (source.value === 'code') return 'override (code)'
  return 'built-in'
})

watch(
  events,
  () => {
    if (!skipJsonText) {
      jsonText.value = pretty(events.value)
      jsonError.value = ''
    }
    scheduleEdit()
  },
  { deep: true, flush: 'sync' },
)

function persistNow(): void {
  const current = JSON.stringify(events.value)
  const committed = JSON.stringify(committedSpec(props.cue.id, props.cue.builtin))
  if (current === committed) clearOverride(props.cue.id)
  else setOverride(props.cue.id, events.value)
  source.value = overrideSource(props.cue.id)
  if (loop.value) restartLoop()
}

function scheduleEdit(): void {
  if (editTimer) window.clearTimeout(editTimer)
  editTimer = window.setTimeout(() => {
    editTimer = 0
    persistNow()
  }, 140)
}

function flushEdit(): void {
  if (!editTimer) return
  window.clearTimeout(editTimer)
  editTimer = 0
  persistNow()
}

function patch(patchObj: Record<string, unknown>): void {
  const ev = activeEvent.value
  if (!ev) return
  events.value[activeIndex.value] = { ...ev, ...patchObj } as unknown as VoiceEvent
}

function setOptional(key: 'to' | 'attack' | 'delay', on: boolean): void {
  const ev = activeEvent.value
  if (!ev) return
  const next = { ...ev } as Record<string, unknown>
  if (on) next[key] = key === 'to' ? Math.round(((ev as ToneOptions).from ?? 440) * 0.5) : key === 'attack' ? 0.004 : 0.05
  else delete next[key]
  events.value[activeIndex.value] = next as unknown as VoiceEvent
}

function patchFilter(patchObj: Record<string, unknown>): void {
  const ev = activeEvent.value
  if (!ev) return
  const filter = { ...(ev.filter ?? { from: 1000 }), ...patchObj }
  events.value[activeIndex.value] = { ...ev, filter } as VoiceEvent
}

function setFilterEnabled(on: boolean): void {
  const ev = activeEvent.value
  if (!ev) return
  if (on) {
    if (!ev.filter) events.value[activeIndex.value] = { ...ev, filter: { type: 'lowpass', from: 1000, to: 400, q: 1 } }
  } else if (isTone(ev)) {
    const next = { ...ev } as Record<string, unknown>
    delete next.filter
    events.value[activeIndex.value] = next as unknown as VoiceEvent
  }
}

function setFilterSweep(on: boolean): void {
  const ev = activeEvent.value
  if (!ev || !ev.filter) return
  const filter = { ...ev.filter }
  if (on) {
    if (filter.to === undefined) filter.to = Math.max(20, Math.round(filter.from * 0.4))
  } else {
    delete filter.to
  }
  events.value[activeIndex.value] = { ...ev, filter } as VoiceEvent
}

function addTone(): void {
  events.value = [...events.value, { type: 'sine', from: 440, to: 220, duration: 0.2, gain: 0.2 }]
  activeIndex.value = events.value.length - 1
}

function addNoise(): void {
  events.value = [...events.value, { duration: 0.2, gain: 0.15, filter: { type: 'lowpass', from: 1200, to: 300 } }]
  activeIndex.value = events.value.length - 1
}

function removeAt(index: number): void {
  if (events.value.length <= 1) return
  events.value = events.value.filter((_, i) => i !== index)
  if (activeIndex.value > index) activeIndex.value -= 1
  else if (activeIndex.value >= events.value.length) activeIndex.value = events.value.length - 1
}

function onJsonInput(): void {
  try {
    const parsed = JSON.parse(jsonText.value) as unknown
    if (!Array.isArray(parsed)) throw new Error('spec must be an array of events')
    skipJsonText = true
    events.value = parsed as VoiceSpec
    skipJsonText = false
    if (activeIndex.value >= parsed.length) activeIndex.value = Math.max(0, parsed.length - 1)
    jsonError.value = ''
  } catch (error) {
    jsonError.value = error instanceof Error ? error.message : String(error)
  }
}

function play(): void {
  emit('preview', clone(events.value))
}

function clearLoopTimer(): void {
  if (loopTimer) {
    window.clearTimeout(loopTimer)
    loopTimer = 0
  }
}

function scheduleLoop(): void {
  clearLoopTimer()
  if (!loop.value) return
  const period = Math.max(specDuration(events.value) + 0.08, 0.15)
  loopTimer = window.setTimeout(() => {
    if (!loop.value) return
    emit('preview', clone(events.value))
    scheduleLoop()
  }, period * 1000)
}

function restartLoop(): void {
  if (!loop.value) return
  emit('preview', clone(events.value))
  scheduleLoop()
}

function onLoopToggle(): void {
  if (loop.value) {
    restartLoop()
  } else {
    clearLoopTimer()
    emit('stop')
  }
}

async function copy(text: string, which: 'entry' | 'all'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = which
    window.setTimeout(() => {
      if (copied.value === which) copied.value = ''
    }, 1200)
  } catch {
    // Clipboard unavailable; the JSON textarea stays selectable.
  }
}

function copyEntry(): void {
  void copy(formatEntry(props.cue.id, events.value), 'entry')
}

function copyAll(): void {
  void copy(formatAllOverrides(), 'all')
}

function reset(): void {
  clearOverride(props.cue.id)
  events.value = clone(committedSpec(props.cue.id, props.cue.builtin))
  activeIndex.value = 0
  source.value = overrideSource(props.cue.id)
  if (loop.value) restartLoop()
}

function close(): void {
  flushEdit()
  clearLoopTimer()
  loop.value = false
  emit('stop')
  emit('close')
}

function wavePath(type: string): string {
  const w = 26
  const h = 14
  const points: string[] = []
  for (let i = 0; i <= 26; i++) {
    const x = i / 26
    const phase = x * 2 * Math.PI
    let y: number
    if (type === 'square') y = Math.sin(phase) >= 0 ? 1 : -1
    else if (type === 'sawtooth') y = 2 * (x % 1) - 1
    else if (type === 'triangle') y = 4 * Math.abs((x % 1) - 0.5) - 1
    else y = Math.sin(phase)
    points.push(`${(x * w).toFixed(1)} ${(h / 2 - y * (h / 2 - 1)).toFixed(1)}`)
  }
  return `M ${points.join(' L ')}`
}

function onWindowKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onWindowKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  flushEdit()
  clearLoopTimer()
  emit('stop')
})

const envelopePath = computed(() => {
  const ev = activeEvent.value
  if (!ev) return ''
  const w = 168
  const h = 42
  const pad = 4
  const attack = ev.attack ?? 0.004
  const duration = Math.max(ev.duration, attack + 0.001)
  const delay = ev.delay ?? 0
  const total = Math.max(delay + duration, 0.01)
  const x = (t: number): number => pad + (t / total) * (w - 2 * pad)
  const y = (g: number): number => h - pad - g * (h - 2 * pad)
  return [
    `M ${x(0)} ${y(0)}`,
    `L ${x(delay)} ${y(0)}`,
    `L ${x(delay + attack)} ${y(ev.gain)}`,
    `L ${x(delay + duration)} ${y(0)}`,
  ].join(' ')
})
</script>

<template>
  <div class="synth-backdrop" @pointerdown.self="close">
    <section class="synth" role="dialog" aria-modal="true" :aria-label="`synth ${cue.id}`">
      <header class="synth-head">
        <div>
          <b>{{ cue.label }}</b>
          <code class="synth-id">{{ cue.id }}</code>
          <span class="override-badge" :class="source ?? 'builtin'">{{ badgeText }}</span>
        </div>
        <button class="ctl small" @click="close">Close</button>
      </header>

      <div class="event-tabs">
        <div
          v-for="(ev, i) in events"
          :key="i"
          class="event-tab"
          :class="{ active: i === activeIndex }"
        >
          <button class="event-tab-btn" @click="activeIndex = i">
            {{ i + 1 }} · {{ isTone(ev) ? ev.type : 'noise' }}
          </button>
          <button
            class="event-tab-x"
            :disabled="events.length <= 1"
            :aria-label="`remove layer ${i + 1}`"
            title="remove this layer"
            @click="removeAt(i)"
          >
            ×
          </button>
        </div>
        <button class="ctl small" title="add a tone" @click="addTone">+ tone</button>
        <button class="ctl small" title="add a noise layer" @click="addNoise">+ noise</button>
      </div>

      <div v-if="activeEvent" class="synth-body">
        <section class="panel">
          <h4>{{ activeTone ? 'oscillator' : 'noise' }}</h4>
          <template v-if="activeTone">
            <div class="wave-picker">
              <button
                v-for="t in OSC_TYPES"
                :key="t"
                class="wave-btn"
                :class="{ active: activeTone.type === t }"
                :title="t"
                @click="patch({ type: t })"
              >
                <svg width="26" height="14" viewBox="0 0 26 14"><path :d="wavePath(t)" /></svg>
              </button>
            </div>
            <div class="knob-row">
              <Knob label="from" unit="Hz" :model-value="activeTone.from" :min="20" :max="20000" :step="1" :precision="0" log @update:model-value="patch({ from: $event })" />
              <Knob
                v-if="activeTone.to !== undefined"
                label="to"
                unit="Hz"
                :model-value="activeTone.to"
                :min="20"
                :max="20000"
                :step="1"
                :precision="0"
                log
                @update:model-value="patch({ to: $event })"
              />
              <label class="mini-toggle">
                <input type="checkbox" :checked="activeTone.to !== undefined" @change="setOptional('to', ($event.target as HTMLInputElement).checked)" />
                sweep
              </label>
            </div>
          </template>
          <p v-else class="muted tiny">filtered white noise burst</p>
        </section>

        <section class="panel">
          <h4>envelope</h4>
          <svg class="envelope" width="168" height="42" viewBox="0 0 168 42">
            <path :d="envelopePath" />
          </svg>
          <div class="knob-row">
            <Knob label="delay" unit="s" :model-value="activeEvent.delay ?? 0" :min="0" :max="0.5" :step="0.005" :precision="3" :reset-value="0" @update:model-value="patch({ delay: $event })" />
            <Knob label="attack" unit="s" :model-value="activeEvent.attack ?? 0.004" :min="0.001" :max="0.3" :step="0.001" :precision="3" :reset-value="0.004" @update:model-value="patch({ attack: $event })" />
            <Knob label="decay" unit="s" :model-value="activeEvent.duration" :min="0.01" :max="2" :step="0.01" :precision="2" @update:model-value="patch({ duration: $event })" />
          </div>
          <label class="slider">
            <span>level</span>
            <input type="range" min="0" max="1" step="0.01" :value="activeEvent.gain" @input="patch({ gain: Number(($event.target as HTMLInputElement).value) })" />
            <input class="num" type="number" min="0" max="1" step="0.01" :value="activeEvent.gain" @change="patch({ gain: Number(($event.target as HTMLInputElement).value) })" />
          </label>
        </section>

        <section class="panel">
          <h4>filter</h4>
          <label v-if="activeTone" class="mini-toggle">
            <input type="checkbox" :checked="!!activeEvent.filter" @change="setFilterEnabled(($event.target as HTMLInputElement).checked)" />
            enabled
          </label>
          <template v-if="activeEvent.filter">
            <select
              class="ctl"
              :value="activeEvent.filter.type ?? 'lowpass'"
              @change="patchFilter({ type: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="t in FILTER_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <div class="knob-row">
              <Knob label="cutoff" unit="Hz" :model-value="activeEvent.filter.from" :min="20" :max="20000" :step="1" :precision="0" log @update:model-value="patchFilter({ from: $event })" />
              <Knob
                v-if="activeEvent.filter.to !== undefined"
                label="to"
                unit="Hz"
                :model-value="activeEvent.filter.to"
                :min="20"
                :max="20000"
                :step="1"
                :precision="0"
                log
                @update:model-value="patchFilter({ to: $event })"
              />
              <Knob label="q" :model-value="activeEvent.filter.q ?? 1" :min="0.1" :max="20" :step="0.1" :precision="1" @update:model-value="patchFilter({ q: $event })" />
            </div>
            <label class="mini-toggle">
              <input type="checkbox" :checked="activeEvent.filter.to !== undefined" @change="setFilterSweep(($event.target as HTMLInputElement).checked)" />
              env → cutoff sweep
            </label>
          </template>
          <p v-else class="muted tiny">no filter</p>
        </section>
      </div>

      <section class="json-panel">
        <div class="json-head">
          <h4>json</h4>
          <span v-if="jsonError" class="json-error">{{ jsonError }}</span>
          <span v-else class="muted tiny">saved locally &amp; applied live · Copy all replaces the VOICE_OVERRIDES block in src/audio/voices.ts</span>
        </div>
        <textarea v-model="jsonText" spellcheck="false" @input="onJsonInput"></textarea>
      </section>

      <footer class="synth-actions">
        <button class="ctl" @click="play">▶ Play</button>
        <label class="mini-toggle">
          <input type="checkbox" v-model="loop" @change="onLoopToggle" />
          loop
        </label>
        <span class="spacer"></span>
        <button class="ctl" @click="copyEntry">{{ copied === 'entry' ? 'Copied!' : 'Copy entry' }}</button>
        <button class="ctl" @click="copyAll">{{ copied === 'all' ? 'Copied!' : 'Copy all' }}</button>
        <button class="ctl" @click="reset">Reset</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.synth-backdrop {
  position: fixed;
  inset: 0;
  background: #0009;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 24px;
}

.synth {
  width: min(760px, 100%);
  max-height: 100%;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.synth-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.synth-head b {
  margin-right: 8px;
}

.synth-id {
  color: #9fe0ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.override-badge {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.04em;
  border: 1px solid var(--border);
  color: var(--muted);
}

.override-badge.local {
  color: #0b0f16;
  background: var(--accent);
  border-color: var(--accent);
}

.override-badge.code {
  color: #cfe3ff;
  border-color: var(--blue);
}

.event-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.event-tab {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
  background: var(--panel-2);
}

.event-tab.active {
  border-color: var(--blue);
  background: #1f6feb33;
}

.event-tab-btn {
  background: transparent;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  font: inherit;
}

.event-tab.active .event-tab-btn {
  color: #cfe3ff;
}

.event-tab-x {
  background: transparent;
  border: 0;
  border-left: 1px solid var(--border);
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  font: inherit;
}

.event-tab-x:hover {
  color: #fff;
  background: #f8514933;
}

.event-tab-x:disabled {
  opacity: 0.35;
  cursor: default;
}

.synth-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.panel {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  padding: 8px 10px;
}

.panel h4,
.json-head h4 {
  margin: 0 0 8px;
  color: var(--accent);
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.wave-picker {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.wave-btn {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 3px 5px;
  cursor: pointer;
  display: flex;
}

.wave-btn path {
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.4;
}

.wave-btn.active {
  border-color: var(--blue);
}

.wave-btn.active path {
  stroke: var(--blue);
}

.knob-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
}

.envelope {
  width: 100%;
  height: 42px;
  margin-bottom: 6px;
}

.envelope path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
}

.slider {
  display: grid;
  grid-template-columns: 40px 1fr 52px;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: var(--muted);
}

.slider .num {
  width: 100%;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  padding: 1px 4px;
}

.mini-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}

.json-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.json-error {
  color: #f85149;
  font-size: 10px;
}

.json-panel textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 8px;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

.synth-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.spacer {
  flex: 1;
}

.muted {
  color: var(--muted);
}

.tiny {
  font-size: 10px;
}

.ctl:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
