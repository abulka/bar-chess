<script setup lang="ts">
import type { GameSnapshot, OverlayFlags } from '../game/game'

const props = defineProps<{
  snapshot: GameSnapshot
}>()

const emit = defineEmits<{
  (e: 'toggle-overlay', key: keyof OverlayFlags): void
  (
    e:
      | 'toggle-auto-preserve'
      | 'toggle-capture-advance'
      | 'toggle-chess-kills'
      | 'toggle-promotion'
      | 'toggle-finish-pressure',
  ): void
}>()

type RuleEvent =
  | 'toggle-auto-preserve'
  | 'toggle-capture-advance'
  | 'toggle-chess-kills'
  | 'toggle-promotion'
  | 'toggle-finish-pressure'

/**
 * Overlay options and their defaults (see Game.overlays). Each row is a
 * checkbox with a full label, a one-line description and the shipped default.
 */
const overlays: Array<{ key: keyof OverlayFlags; label: string; desc: string; def: boolean }> = [
  { key: 'moveCells', label: 'Movement cells', desc: 'Highlight the squares the selection can move to', def: true },
  { key: 'attackCells', label: 'Attack cells', desc: 'Highlight the squares the selection can attack', def: true },
  { key: 'rangeArcs', label: 'Weapon range arcs', desc: "Draw each shooter's firing range", def: false },
  { key: 'enemyPlans', label: 'Enemy plans & intent', desc: 'Reveal what enemy pieces are planning to do', def: false },
  { key: 'grid', label: 'Board grid', desc: 'Show the coordinate grid overlay', def: true },
  { key: 'health', label: 'Health bars', desc: 'Show hit-point bars above pieces', def: true },
  { key: 'reload', label: 'Firing recharge', desc: "Show each weapon's recharge timer", def: true },
  { key: 'healing', label: 'Healing aura', desc: "Draw the king's aura and tendrils to healed pieces", def: false },
  { key: 'advantage', label: 'Advantage bar', desc: "Show the \"who's winning\" bar over the board", def: true },
]

type RuleKey =
  | 'autoPreserve'
  | 'captureAdvance'
  | 'chessKills'
  | 'promotion'
  | 'finishPressure'

/**
 * Simulation rules and their defaults (see the matching Game fields). These
 * change how the battle plays out, not just how it is drawn.
 */
const rules: Array<{
  key: RuleKey
  label: string
  desc: string
  def: boolean
  event: RuleEvent
}> = [
  {
    key: 'autoPreserve',
    label: 'Auto-preserve wounded pieces',
    desc: 'Hurt pieces step out of fire on their own, even without orders',
    def: true,
    event: 'toggle-auto-preserve',
  },
  {
    key: 'captureAdvance',
    label: 'Chess kill (by advancing)',
    desc: 'An idle killer steps onto the square of the piece it just killed',
    def: true,
    event: 'toggle-capture-advance',
  },
  {
    key: 'chessKills',
    label: 'Chess kills (insta-kill)',
    desc: 'Ordering a move or attack kills instantly when the target is already in chess capture range',
    def: false,
    event: 'toggle-chess-kills',
  },
  {
    key: 'promotion',
    label: 'Pawn promotion',
    desc: 'A pawn reaching the enemy back rank becomes a queen',
    def: true,
    event: 'toggle-promotion',
  },
  {
    key: 'finishPressure',
    label: 'Finish pressure',
    desc: 'Once a side is down to only its king, attacks on that king deal more and more damage over time, so a siege cannot be dragged out forever',
    def: true,
    event: 'toggle-finish-pressure',
  },
]

function defText(def: boolean): string {
  return def ? 'default: on' : 'default: off'
}

function onOverlayChange(key: keyof OverlayFlags, event: Event): void {
  emit('toggle-overlay', key)
  ;(event.target as HTMLInputElement).blur()
}

function onRuleChange(rule: (typeof rules)[number]): void {
  emit(rule.event)
}
</script>

<template>
  <div class="options-panel">
    <div class="rail-title">overlays</div>
    <div class="option-list">
      <label v-for="o in overlays" :key="o.key" class="option toggle">
        <input
          type="checkbox"
          :checked="props.snapshot.overlays[o.key]"
          @change="onOverlayChange(o.key, $event)"
        />
        <span class="option-body">
          <span class="option-label">{{ o.label }}</span>
          <span class="option-desc">{{ o.desc }}</span>
          <span class="option-default">{{ defText(o.def) }}</span>
        </span>
      </label>
    </div>

    <div class="rail-title">rules</div>
    <p class="rules-note">These change how the battle plays out, not just what is drawn.</p>
    <div class="option-list">
      <label v-for="r in rules" :key="r.key" class="option toggle">
        <input
          type="checkbox"
          :checked="props.snapshot[r.key]"
          @change="onRuleChange(r)"
        />
        <span class="option-body">
          <span class="option-label">{{ r.label }}</span>
          <span class="option-desc">{{ r.desc }}</span>
          <span class="option-default">{{ defText(r.def) }}</span>
        </span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.option-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.option {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  cursor: pointer;
}

.option input[type='checkbox'] {
  margin-top: 2px;
  flex: none;
}

.option-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.option-label {
  color: var(--text);
  font-weight: 600;
}

.option-desc {
  color: var(--muted);
  line-height: 1.4;
}

.option-default {
  color: var(--muted);
  opacity: 0.72;
  font-size: 0.9em;
}

.rules-note {
  margin: 0 0 6px;
  color: var(--muted);
  line-height: 1.4;
}
</style>
