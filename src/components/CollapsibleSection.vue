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
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 2px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  user-select: none;
}

.collapsible-head:hover {
  color: var(--accent);
}

.caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  font-size: 14px;
  line-height: 1;
  color: var(--muted);
}

.collapsible-head:hover .caret {
  color: var(--accent);
}
</style>
