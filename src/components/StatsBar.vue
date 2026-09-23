<script setup lang="ts">
import type { GameSnapshot } from '../game/game'

defineProps<{ snapshot: GameSnapshot }>()
</script>

<template>
  <div class="statsbar">
    <span class="stat">turn <b>{{ snapshot.turn }}</b></span>
    <span class="stat"><b>{{ snapshot.tick }}</b> tick</span>
    <span class="stat" title="battle seed">seed <b>{{ snapshot.seed }}</b></span>
    <span class="stat">{{ snapshot.fps }} fps</span>
    <span class="stat">{{ snapshot.tps }} tps</span>
    <span class="stat">{{ snapshot.counts.pieces }} pieces</span>
    <span class="stat">{{ snapshot.shots }} shots · {{ snapshot.counts.projectiles }} in-flight</span>
    <span class="stat">{{ snapshot.kills }} kills</span>
    <span class="stat">{{ snapshot.counts.entities }} entities</span>
    <span class="stat">{{ snapshot.selected.length }} selected</span>
    <span v-if="snapshot.warnings > 0" class="stat warn">{{ snapshot.warnings }} warnings</span>
    <span v-if="snapshot.winner" class="stat winner" :style="{ color: snapshot.teams[snapshot.winner].color }">
      {{ snapshot.teams[snapshot.winner].name }} wins — press <b>u</b> to undo
    </span>
  </div>
</template>
