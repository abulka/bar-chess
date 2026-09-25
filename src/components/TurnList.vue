<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { GameSnapshot, TurnSummary } from '../game/game'

const props = defineProps<{
  snapshot: GameSnapshot
}>()

const emit = defineEmits<{
  (e: 'jump', index: number): void
  (e: 'play', index: number): void
  (e: 'fork'): void
}>()

/** Newest boundary first so the active row stays near the top. */
const rows = computed(() => [...props.snapshot.turns].reverse())
const current = computed(() => props.snapshot.historyIndex)
const latest = computed(() => props.snapshot.turns.length - 1)
const backtracked = computed(() => props.snapshot.historyIndex < latest.value)
const busy = computed(() => props.snapshot.turnActive || props.snapshot.replaying)
const dropped = computed(() => latest.value - props.snapshot.historyIndex)

function timeLabel(t: TurnSummary): string {
  if (t.ticks <= 0) return 'instant'
  return t.seconds < 10 ? `${t.seconds.toFixed(1)}s` : `${Math.round(t.seconds)}s`
}

function rowLabel(t: TurnSummary): string {
  if (t.index === 0 && t.turn === 0) return 'opening'
  return `${t.mega ? 'MEGA TURN' : 'TURN'} ${t.turn}`
}

function title(t: TurnSummary): string {
  const parts = [
    `${t.mega ? 'mega turn' : 'turn'} ${t.turn}`,
    `tick ${t.tick}`,
    t.ticks > 0 ? `${t.ticks} ticks (${timeLabel(t)})` : 'no recorded beat',
    `red ${t.redPieces} / blue ${t.bluePieces}`,
    `${t.orders} orders`,
  ]
  if (t.moves) parts.push(`${t.moves} moves`)
  if (t.kills) parts.push(`${t.kills} kills`)
  if (t.losses) parts.push(`${t.losses} losses`)
  return parts.join(' · ')
}

const listEl = ref<HTMLElement | null>(null)

watch(
  () => props.snapshot.historyIndex,
  async () => {
    await nextTick()
    listEl.value?.querySelector('li.active')?.scrollIntoView({ block: 'nearest' })
  },
)
</script>

<template>
  <div class="turn-panel">
    <ul ref="listEl" class="list">
      <li
        v-for="t in rows"
        :key="t.index"
        class="row"
        :class="{ active: t.index === current, future: t.index > current }"
        :title="title(t)"
        @click="!busy && emit('jump', t.index)"
      >
        <button
          class="play"
          :class="{ replayable: t.replayable }"
          :disabled="busy || !t.replayable"
          :title="t.replayable ? `replay ${rowLabel(t)}` : 'nothing to replay'"
          @click.stop="emit('play', t.index)"
        >
          ▶
        </button>
        <div class="body">
          <div class="main">
            <span class="name" :class="{ mega: t.mega }">{{ rowLabel(t) }}</span>
            <span class="muted">t{{ t.tick }}</span>
            <span v-if="t.index === current" class="tag now">now</span>
            <span v-else-if="t.index > current" class="tag future-tag">redo</span>
          </div>
          <div class="sub muted">
            {{ timeLabel(t) }} · {{ t.pieces }} pieces · {{ t.orders }} orders
          </div>
        </div>
        <button
          v-if="t.index === current && backtracked"
          class="fork"
          :disabled="busy"
          :title="`fork here (f) — discards ${dropped} redone beat${dropped === 1 ? '' : 's'}`"
          @click.stop="emit('fork')"
        >
          ⑂
        </button>
      </li>
    </ul>

    <p v-if="backtracked" class="warn">
      viewing turn {{ current }} of {{ latest }} — <b>space</b> replays forward ·
      <b>f</b> fork here · <b>u</b>/<b>r</b> undo/redo · <b>y</b> replay
    </p>
    <p v-if="snapshot.historyTrimmed > 0" class="muted tiny">
      {{ snapshot.historyTrimmed }} earlier beat{{ snapshot.historyTrimmed === 1 ? '' : 's' }} trimmed (history cap)
    </p>
  </div>
</template>

<style scoped>
.warn {
  margin: 6px 0 0;
  padding: 4px 6px;
  border: 1px solid #ff9f43;
  border-radius: 3px;
  color: #ffb066;
  line-height: 1.5;
}

.warn b {
  color: #ffd8a0;
}

.muted {
  color: var(--muted);
}

.tiny {
  font-size: 0.9em;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-left: 2px solid transparent;
  cursor: pointer;
}

.row:hover {
  background: var(--panel-2);
}

.row.active {
  border-left-color: var(--accent);
  background: var(--panel-2);
}

.row.future {
  opacity: 0.55;
}

.play {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
}

.play.replayable {
  color: var(--text);
}

.play:disabled {
  opacity: 0.35;
  cursor: default;
}

.fork {
  flex: none;
  margin-left: auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid #ff9f43;
  border-radius: 3px;
  background: transparent;
  color: #ffb066;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.fork:hover {
  color: #ffd8a0;
  border-color: #ffd8a0;
}

.fork:disabled {
  opacity: 0.35;
  cursor: default;
}

.body {
  min-width: 0;
}

.main {
  display: flex;
  align-items: center;
  gap: 5px;
}

.name {
  font-weight: 700;
  color: var(--text);
}

.name.mega {
  color: var(--accent);
}

.sub {
  font-size: 0.9em;
  line-height: 1.35;
}

.tag {
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 0.8em;
  color: var(--muted);
}

.tag.now {
  color: var(--heading);
  border-color: var(--heading);
}
</style>
