<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { SavedMap } from '../game/map'
import { drawMapPreview } from '../render/editor'

const props = withDefaults(defineProps<{ map: SavedMap; size?: number }>(), { size: 148 })
const canvasRef = ref<HTMLCanvasElement | null>(null)

function paint(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const size = props.size
  canvas.width = Math.floor(size * dpr)
  canvas.height = Math.floor(size * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawMapPreview(ctx, props.map, size)
}

onMounted(paint)
watch(() => props.map, paint)
</script>

<template>
  <canvas
    ref="canvasRef"
    class="map-thumb"
    :style="{ width: props.size + 'px', height: props.size + 'px' }"
  ></canvas>
</template>
