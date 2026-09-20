<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Game } from '../game/game'
import type { IntentMode, Vec2 } from '../game/types'
import { Renderer } from '../render/renderer'

const props = defineProps<{
  game: Game
  orderMode: IntentMode
}>()

const emit = defineEmits<{ (e: 'changed'): void }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const wrapperRef = ref<HTMLDivElement | null>(null)

let renderer: Renderer | null = null
let observer: ResizeObserver | null = null
let pointerDown = false
let panning = false
let moved = false
let button = 0
let lastX = 0
let lastY = 0

const DRAG_THRESHOLD = 4

function pointerPos(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function cellAt(event: PointerEvent | MouseEvent): Vec2 {
  const p = pointerPos(event)
  const w = renderer!.camera.screenToWorld(p.x, p.y)
  return props.game.board.worldToCell(w.x, w.y)
}

function onPointerDown(event: PointerEvent): void {
  canvasRef.value?.setPointerCapture(event.pointerId)
  const p = pointerPos(event)
  lastX = p.x
  lastY = p.y
  moved = false
  button = event.button
  pointerDown = true
  panning = event.button === 1 || event.button === 0
}

function onPointerMove(event: PointerEvent): void {
  if (!pointerDown) return
  const p = pointerPos(event)
  if (Math.abs(p.x - lastX) > DRAG_THRESHOLD || Math.abs(p.y - lastY) > DRAG_THRESHOLD) moved = true
  if (panning && moved) {
    renderer?.camera.panBy(p.x - lastX, p.y - lastY)
    emit('changed')
  }
  lastX = p.x
  lastY = p.y
}

function onPointerUp(event: PointerEvent): void {
  canvasRef.value?.releasePointerCapture(event.pointerId)
  const wasPanning = panning && moved
  pointerDown = false
  panning = false

  if (button === 2 && !wasPanning) {
    const dest = cellAt(event)
    props.game.orderSelected(props.orderMode, dest)
    emit('changed')
    return
  }

  if (button === 0 && !wasPanning) {
    const p = pointerPos(event)
    const w = renderer!.camera.screenToWorld(p.x, p.y)
    props.game.selectAt(w.x, w.y, event.shiftKey)
    emit('changed')
  }
  moved = false
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const p = pointerPos(event)
  renderer?.camera.zoomAt(p.x, p.y, event.deltaY < 0 ? 1.12 : 1 / 1.12)
  emit('changed')
}

function fit(): void {
  if (renderer && canvasRef.value) {
    renderer.resize()
    renderer.fit(props.game)
  }
}

defineExpose({ fit })

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  renderer = new Renderer(canvas)
  fit()
  props.game.onFrame = () => renderer?.draw(props.game)
  observer = new ResizeObserver(() => renderer?.resize())
  if (wrapperRef.value) observer.observe(wrapperRef.value)
  if (import.meta.env.DEV && renderer) {
    ;(window as unknown as { __renderer: Renderer }).__renderer = renderer
  }
})

onBeforeUnmount(() => {
  props.game.onFrame = null
  observer?.disconnect()
})
</script>

<template>
  <div ref="wrapperRef" class="board-wrapper">
    <canvas
      ref="canvasRef"
      class="board-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
      @contextmenu.prevent
    />
  </div>
</template>
