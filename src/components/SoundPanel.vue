<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { pieceAudioCatalog, type PieceAudioEntry } from '../audio/catalog'
import {
  clearAllOverrides,
  formatAllOverrides,
  overrideCount,
  overrideSource,
  subscribeOverrides,
} from '../audio/overrides'
import { MISS_CAUSES, missId, soundCue, type SoundCue } from '../audio/sounds'
import type { VoiceSpec } from '../audio/voices'
import SynthEditor from './SynthEditor.vue'

const emit = defineEmits<{
  (e: 'audition', id: string): void
  (e: 'preview', spec: VoiceSpec): void
  (e: 'stop'): void
}>()

const pieces = pieceAudioCatalog()
const missCauses = MISS_CAUSES
const editing = ref<SoundCue | null>(null)
const copiedAll = ref(false)
const overridesRev = ref(0)

let unsubscribe = (): void => {}
onMounted(() => {
  unsubscribe = subscribeOverrides(() => {
    overridesRev.value += 1
  })
})
onBeforeUnmount(() => unsubscribe())

const overrideTotal = computed(() => {
  void overridesRev.value
  return overrideCount()
})

function overrideClass(id: string): string {
  void overridesRev.value
  const source = overrideSource(id)
  return source ? `overridden ${source}` : ''
}

function play(id: string): void {
  emit('audition', id)
}

function openSynth(id: string): void {
  const cue = soundCue(id)
  if (cue) editing.value = cue
}

async function copyAll(): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatAllOverrides())
    copiedAll.value = true
    window.setTimeout(() => (copiedAll.value = false), 1200)
  } catch {
    // Clipboard unavailable.
  }
}

function clearAll(): void {
  if (overrideTotal.value === 0) return
  if (window.confirm(`Clear ${overrideTotal.value} saved sound override(s)?`)) clearAllOverrides()
}

function stats(piece: PieceAudioEntry): Array<[string, string]> {
  const w = piece.weapon
  const proj = piece.projectile
  return [
    ['hp', `${piece.hp}`],
    ['move', `${piece.move.text} · ${piece.move.cooldown}s`],
    ['weapon', w.key],
    ['damage', `${w.damage}`],
    ['rate', `${w.rate.toFixed(2)}/s (${w.cooldown}s cooldown)`],
    ['reach', `${w.text} · vision ${w.vision}`],
    ['projectile', `${proj.key} · ${proj.trajectory} · ${proj.shape}`],
    ['flight', `speed ${proj.speed} t/s · splash ${proj.splash} · radius ${proj.radius}`],
  ]
}
</script>

<template>
  <div class="sound-panel">
    <p class="sound-note">
      auditioning plays even when sound is off (toggle it in the toolbar). cue ids map 1:1 to what
      the battle plays.
    </p>

    <div class="override-bar">
      <span>saved overrides: <b>{{ overrideTotal }}</b></span>
      <span class="spacer"></span>
      <button class="ctl small" :disabled="overrideTotal === 0" @click="copyAll">
        {{ copiedAll ? 'Copied!' : 'Copy all saved' }}
      </button>
      <button class="ctl small" :disabled="overrideTotal === 0" @click="clearAll">Clear all</button>
    </div>

    <div class="sound-block">
      <div class="sound-sub">miss cues</div>
      <ul class="cue-list">
        <li v-for="cause in missCauses" :key="cause">
          <button class="cue-play" :aria-label="`audition ${missId(cause)}`" @click="play(missId(cause))">▶</button>
          <button class="cue-synth" :aria-label="`edit synth ${missId(cause)}`" @click="openSynth(missId(cause))">∿</button>
          <code class="cue-id" :class="overrideClass(missId(cause))">{{ missId(cause) }}</code>
          <span class="cue-desc">{{ cause }}</span>
        </li>
      </ul>
    </div>

    <div class="piece-grid">
      <details v-for="piece in pieces" :key="piece.key" class="piece-card">
        <summary>
          <span class="glyph">{{ piece.glyph }}</span>
          <b>{{ piece.name }}</b>
          <span class="muted">{{ piece.hp }} hp · {{ piece.weapon.damage }} dmg · {{ piece.weapon.cooldown }}s</span>
        </summary>

        <dl class="stats">
          <template v-for="[label, value] in stats(piece)" :key="label">
            <dt>{{ label }}</dt>
            <dd>{{ value }}</dd>
          </template>
        </dl>

        <div class="sound-sub">fires</div>
        <ul class="cue-list">
          <li>
            <button class="cue-play" :aria-label="`audition ${piece.fireId}`" @click="play(piece.fireId)">▶</button>
            <button class="cue-synth" :aria-label="`edit synth ${piece.fireId}`" @click="openSynth(piece.fireId)">∿</button>
            <code class="cue-id" :class="overrideClass(piece.fireId)">{{ piece.fireId }}</code>
            <span class="cue-desc">{{ piece.weapon.key }}</span>
          </li>
        </ul>

        <div class="sound-sub">takes hits from</div>
        <ul class="cue-list">
          <li v-for="hit in piece.hitsFrom" :key="hit.id">
            <button class="cue-play" :aria-label="`audition ${hit.id}`" @click="play(hit.id)">▶</button>
            <button class="cue-synth" :aria-label="`edit synth ${hit.id}`" @click="openSynth(hit.id)">∿</button>
            <code class="cue-id" :class="overrideClass(hit.id)">{{ hit.id }}</code>
            <span class="cue-desc">{{ hit.attackerName }} · {{ hit.shape }} · {{ hit.damage }} dmg</span>
          </li>
        </ul>

        <div class="sound-sub">dies</div>
        <ul class="cue-list">
          <li>
            <button class="cue-play" :aria-label="`audition ${piece.deathId}`" @click="play(piece.deathId)">▶</button>
            <button class="cue-synth" :aria-label="`edit synth ${piece.deathId}`" @click="openSynth(piece.deathId)">∿</button>
            <code class="cue-id" :class="overrideClass(piece.deathId)">{{ piece.deathId }}</code>
            <span class="cue-desc">explosion</span>
          </li>
        </ul>
      </details>
    </div>

    <SynthEditor
      v-if="editing"
      :cue="editing"
      @preview="emit('preview', $event)"
      @stop="emit('stop')"
      @close="editing = null"
    />
  </div>
</template>

<style scoped>
.sound-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
  font-size: 11px;
}

.sound-note {
  margin: 0 0 8px;
  color: var(--muted);
}

.override-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--muted);
}

.override-bar b {
  color: var(--text);
}

.sound-block {
  margin-bottom: 10px;
}

.sound-sub {
  color: var(--accent);
  font-weight: 700;
  letter-spacing: 0.04em;
  margin: 8px 0 3px;
}

.piece-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 10px;
  align-items: start;
}

.piece-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  padding: 6px 8px;
}

.piece-card > summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
  list-style: none;
}

.piece-card > summary::-webkit-details-marker {
  display: none;
}

.piece-card .glyph {
  font-size: 18px;
  line-height: 1;
  font-family: "Segoe UI Symbol", "Apple Symbols", serif;
}

.piece-card summary .muted {
  color: var(--muted);
  font-size: 0.95em;
}

.stats {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 1px 8px;
  margin: 8px 0 2px;
}

.stats dt {
  color: var(--muted);
}

.stats dd {
  margin: 0;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.cue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.cue-list li {
  display: grid;
  grid-template-columns: 22px 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}

.cue-play,
.cue-synth {
  width: 20px;
  height: 18px;
  line-height: 1;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 10px;
}

.cue-synth {
  color: var(--accent);
}

.cue-play:hover,
.cue-synth:hover {
  background: #1f6feb22;
  border-color: #3a4655;
}

.cue-id {
  color: #9fe0ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cue-id.overridden::before {
  content: '◆ ';
  font-size: 9px;
}

.cue-id.overridden.local {
  color: var(--accent);
}

.cue-id.overridden.code {
  color: #8fd3ff;
}

.cue-desc {
  color: var(--muted);
  white-space: nowrap;
}
</style>
