<script setup lang="ts">
import type { NoPreservePrompt } from '../game/game'
import { NO_PRESERVE_TURNS } from '../game/noPreserve'

defineProps<{ prompt: NoPreservePrompt }>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'dismiss'): void
}>()
</script>

<template>
  <div class="no-preserve" role="alertdialog" aria-live="polite">
    <span class="mark" aria-hidden="true">!</span>
    <div class="body">
      <p class="title">Self-preservation will interrupt {{ prompt.label }}</p>
      <p class="detail">
        <span class="coords">{{ prompt.coords.join(' · ') }}</span>
        would stop following the order to protect itself. Override for {{ NO_PRESERVE_TURNS }} turns?
      </p>
      <div class="actions">
        <button type="button" class="ctl small primary" @click="emit('confirm')">
          Override {{ NO_PRESERVE_TURNS }} turns
        </button>
        <button type="button" class="ctl small" @click="emit('dismiss')">Leave it</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-preserve {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  gap: 9px;
  align-items: flex-start;
  max-width: min(440px, calc(100% - 24px));
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-left: 3px solid #ffd166;
  border-radius: 6px;
  background: rgba(14, 17, 23, 0.92);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(3px);
  pointer-events: auto;
}

.mark {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffd166;
  color: #1a1400;
  font-weight: 700;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.body {
  min-width: 0;
}

.title {
  margin: 0 0 2px;
  color: var(--text);
  font-weight: 600;
}

.detail {
  margin: 0;
  color: var(--muted);
  line-height: 1.4;
}

.coords {
  color: var(--text);
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 7px;
}

.ctl.primary {
  border-color: #ffd166;
  color: #ffd166;
}
</style>
