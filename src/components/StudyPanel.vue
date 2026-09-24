<script setup lang="ts">
import { computed, ref } from 'vue'
import { BOARD_SIZES } from '../game/boards'
import type { BoardSize } from '../game/boards'
import type { GameMode } from '../game/game'
import { STUDY_POLICIES } from '../game/study'
import type { StudyOptions, StudyPolicyName, StudyState } from '../game/study'
import { buildStudyPrompt } from '../game/studyPrompt'

const props = defineProps<{ state: StudyState }>()

const emit = defineEmits<{
  (e: 'run', options: StudyOptions): void
  (e: 'stop'): void
  (e: 'cancel'): void
}>()

const modes: Array<{ id: GameMode; label: string }> = [
  { id: 'ai-vs-ai', label: 'AI vs AI' },
  { id: 'human-vs-ai', label: 'Human (scripted) vs AI' },
]

const games = ref(5)
const mode = ref<GameMode>('ai-vs-ai')
const size = ref<BoardSize>(8)
const seedBase = ref(1)
const maxTurns = ref(120)
const policy = ref<StudyPolicyName>('focus')
const autoPreserve = ref(true)
const captureAdvance = ref(false)
const chessKills = ref(false)
const copied = ref(false)

const prompt = computed(() =>
  props.state.results.length === 0
    ? ''
    : buildStudyPrompt(
        props.state.results.map((r) => ({
          seed: r.seed,
          winner: r.winner,
          turns: r.turns,
          partial: r.partial,
          transcript: r.transcript,
          analysis: r.analysis,
        })),
        { mode: props.state.results[0]?.mode, size: props.state.results[0]?.size },
      ),
)

const preview = computed(() => (prompt.value.length > 1600 ? prompt.value.slice(0, 1600) + '\n…' : prompt.value))

const scripted = computed(() => mode.value === 'human-vs-ai')

function onRun(): void {
  copied.value = false
  emit('run', {
    games: Math.max(1, Math.min(50, games.value)),
    size: size.value,
    mode: mode.value,
    seedBase: seedBase.value,
    maxTurns: Math.max(5, maxTurns.value),
    policy: policy.value,
    autoPreserve: autoPreserve.value,
    captureAdvance: captureAdvance.value,
    chessKills: chessKills.value,
  })
}

function onCancel(): void {
  copied.value = false
  emit('cancel')
}

async function copyPrompt(): Promise<void> {
  const text = prompt.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    console.log(text)
  }
}
</script>

<template>
  <section class="study">
    <div class="study-controls">
      <label class="toggle">games <input v-model.number="games" type="number" min="1" max="50" :disabled="state.running" /></label>
      <label class="toggle">
        mode
        <select v-model="mode" :disabled="state.running">
          <option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
      </label>
      <label class="toggle">
        board
        <select v-model.number="size" :disabled="state.running">
          <option v-for="s in BOARD_SIZES" :key="s" :value="s">{{ s }}×{{ s }}</option>
        </select>
      </label>
      <label class="toggle">seed <input v-model.number="seedBase" type="number" :disabled="state.running" /></label>
      <label class="toggle">max turns <input v-model.number="maxTurns" type="number" min="5" :disabled="state.running" /></label>
      <label class="toggle" title="Scripted orders for the human side (human-vs-ai only)">
        policy
        <select v-model="policy" :disabled="state.running || !scripted">
          <option v-for="p in STUDY_POLICIES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </label>
      <label class="toggle"><input v-model="autoPreserve" type="checkbox" :disabled="state.running" /> auto-preserve</label>
      <label class="toggle"><input v-model="captureAdvance" type="checkbox" :disabled="state.running" /> capture advance</label>
      <label class="toggle"><input v-model="chessKills" type="checkbox" :disabled="state.running" /> chess kills</label>
    </div>

    <div class="study-actions">
      <button class="ctl" :disabled="state.running" @click="onRun">▶ Run {{ games }} games</button>
      <button class="ctl" :disabled="!state.running" @click="emit('stop')">⏹ Stop game</button>
      <button class="ctl" :disabled="!state.running && state.results.length === 0" @click="onCancel">✕ Cancel all</button>
      <span v-if="state.running" class="study-status">
        study in progress · game {{ state.index + 1 }}/{{ state.games }} · seed {{ state.seed }} · turn {{ state.turn }}
      </span>
    </div>

    <div class="study-body">
      <div class="study-results">
        <div v-for="r in state.results" :key="r.seed" class="study-game" :class="{ partial: r.partial }">
          <span class="study-seed">seed {{ r.seed }}</span>
          <span class="study-win">{{ r.winner ?? 'draw' }}</span>
          <span>{{ r.turns }}t</span>
          <span>{{ r.analysis.kills }} kills</span>
          <span v-if="r.analysis.heldUnderFire.length" class="flag" title="pieces that held under fire without moving">
            held×{{ r.analysis.heldUnderFire.length }}
          </span>
          <span v-if="r.analysis.neverMoved.length" class="flag" title="pieces that never moved">
            static×{{ r.analysis.neverMoved.length }}
          </span>
          <span v-if="r.analysis.oscillation.length" class="flag" title="pieces oscillating between cells">
            osc×{{ r.analysis.oscillation.length }}
          </span>
          <span v-if="r.partial" class="flag partial-flag">partial</span>
        </div>
        <div v-if="state.results.length === 0 && !state.running" class="log-empty">
          run a batch to watch AI-vs-AI games and study them
        </div>
      </div>

      <div class="study-copy">
        <button class="ctl" :disabled="state.results.length === 0" @click="copyPrompt">
          {{ copied ? 'Copied!' : '📋 Copy analysis prompt' }}
        </button>
        <textarea v-if="preview" class="study-preview" readonly :value="preview"></textarea>
      </div>
    </div>
  </section>
</template>

<style scoped>
.study {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  padding: 8px 10px;
  overflow: hidden;
}
.study-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.study-controls input[type='number'] {
  width: 64px;
}
.study-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.study-status {
  color: #e3b341;
  font-variant-numeric: tabular-nums;
}
.study-body {
  display: flex;
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.study-results {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.study-game {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  font-variant-numeric: tabular-nums;
}
.study-game.partial {
  border-left: 2px solid #e3b341;
}
.study-seed {
  min-width: 78px;
  color: #9aa4b2;
}
.study-win {
  min-width: 42px;
}
.flag {
  color: #ff9f43;
}
.partial-flag {
  color: #e3b341;
}
.study-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 42%;
  min-width: 220px;
}
.study-preview {
  flex: 1;
  min-height: 0;
  resize: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.35;
  white-space: pre;
  overflow: auto;
  background: rgba(0, 0, 0, 0.25);
  color: #c8d0da;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 6px;
}
</style>
