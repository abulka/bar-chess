<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { GameSnapshot } from '../game/game'
import { advantageFraction } from '../game/advantage'

const props = defineProps<{ snapshot: GameSnapshot }>()

/** Tween length for one turn's swing, in ms. */
const DURATION = 700

/**
 * Displayed bar fraction. It is latched to the turn boundary and tweened over
 * `DURATION`, so the bar makes one smooth move per turn instead of twitching
 * with every shot.
 */
const displayed = ref(0)
let raf = 0
let primed = false

function stop(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function animateTo(to: number): void {
  stop()
  const from = displayed.value
  const start = performance.now()
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / DURATION)
    const eased = t * t * (3 - 2 * t)
    displayed.value = from + (to - from) * eased
    raf = t < 1 ? requestAnimationFrame(step) : 0
  }
  raf = requestAnimationFrame(step)
}

watch(
  () => props.snapshot.turn,
  () => {
    const to = advantageFraction(props.snapshot.advantage)
    if (!primed) {
      displayed.value = to
      primed = true
      return
    }
    animateTo(to)
  },
  { immediate: true },
)

onBeforeUnmount(stop)

const pct = computed(() => `${(Math.abs(displayed.value) * 50).toFixed(2)}%`)
const leader = computed<'red' | 'blue'>(() => (displayed.value >= 0 ? 'red' : 'blue'))
const fillStyle = computed(() =>
  displayed.value >= 0 ? { right: '50%', width: pct.value } : { left: '50%', width: pct.value },
)
</script>

<template>
  <div
    class="advantage"
    :style="{
      '--red': snapshot.teams.red.color,
      '--blue': snapshot.teams.blue.color,
    }"
    :title="snapshot.advantageTooltip"
  >
    <div class="adv-track">
      <div class="adv-fill" :class="leader" :style="fillStyle"></div>
      <div class="adv-center"></div>
    </div>
  </div>
</template>

<style scoped>
.advantage {
  position: relative;
  height: 14px;
  background: var(--panel);
  cursor: default;
}

.adv-track {
  position: absolute;
  inset: 4px 0;
  height: 6px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
}

.adv-fill {
  position: absolute;
  top: 0;
  bottom: 0;
}

.adv-fill.red {
  background: var(--red);
  box-shadow: 0 0 8px var(--red);
}

.adv-fill.blue {
  background: var(--blue);
  box-shadow: 0 0 8px var(--blue);
}

.adv-center {
  position: absolute;
  top: -3px;
  bottom: -3px;
  left: 50%;
  width: 1px;
  background: rgba(255, 255, 255, 0.65);
  transform: translateX(-0.5px);
}
</style>
