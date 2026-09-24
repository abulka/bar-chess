<script setup lang="ts">
defineProps<{
  title: string
  open: boolean
}>()

const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <section class="collapsible">
    <button
      class="rail-title collapsible-head"
      type="button"
      :aria-expanded="open"
      @click="emit('toggle')"
    >
      <span class="caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>{{ title }}
    </button>
    <div v-show="open" class="collapsible-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.collapsible-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  margin: 0;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.collapsible-head:hover {
  color: var(--accent);
}

.caret {
  display: inline-block;
  width: 10px;
  font-size: 10px;
}
</style>
