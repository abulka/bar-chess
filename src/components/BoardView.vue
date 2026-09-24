<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Game } from '../game/game'
import type { StanceMode, Vec2 } from '../game/types'
import { Renderer } from '../render/renderer'

const props = defineProps<{
  game: Game
  /** Pending BAR-style command (`m`/`a`), used for the cursor and click routing. */
  pending: StanceMode
  /** Whether the map editor is active (cursor + pointer routing). */
  editor: boolean
}>()

const emit = defineEmits<{ (e: 'changed'): void; (e: 'ordered'): void }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const wrapperRef = ref<HTMLDivElement | null>(null)

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const box = ref<Box | null>(null)
const panning = ref(false)

let renderer: Renderer | null = null
let observer: ResizeObserver | null = null
let pointerDown = false
let selecting = false
let commandClick = false
let editing = false
let lastEditKey = ''
let moved = false
let button = 0
let shiftDown = false
let startX = 0
let startY = 0
let lastX = 0
let lastY = 0

const DRAG_THRESHOLD = 4

function pointerPos(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function worldAt(event: PointerEvent | MouseEvent): Vec2 {
  const p = pointerPos(event)
  const w = renderer!.camera.screenToWorld(p.x, p.y)
  return w
}

function cellAt(event: PointerEvent | MouseEvent): Vec2 {
  const w = worldAt(event)
  return props.game.board.worldToCell(w.x, w.y)
}

/** Board cell under an arbitrary client point, for palette drops from outside. */
function cellAtClient(clientX: number, clientY: number): Vec2 {
  const canvas = canvasRef.value
  if (!renderer || !canvas) return { x: -1, y: -1 }
  const rect = canvas.getBoundingClientRect()
  const w = renderer.camera.screenToWorld(clientX - rect.left, clientY - rect.top)
  return props.game.board.worldToCell(w.x, w.y)
}

function overBoard(clientX: number, clientY: number): boolean {
  const canvas = canvasRef.value
  if (!canvas) return false
  const rect = canvas.getBoundingClientRect()
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
}

/** Apply the active editor brush at a cell; `place` true only for a clean click. */
function applyEdit(cell: Vec2, place: boolean): void {
  if (!props.game.editorMode || !props.game.board.inBounds(cell.x, cell.y)) return
  const brush = props.game.editorBrush
  if (!brush) return
  if (brush.kind === 'erase') props.game.removePieceAt(cell.x, cell.y)
  else if (place) props.game.placePiece(brush.team, brush.key, cell.x, cell.y)
  emit('changed')
}

function additive(event: PointerEvent | MouseEvent): boolean {
  return event.ctrlKey || event.metaKey
}

function onPointerDown(event: PointerEvent): void {
  button = event.button
  if (event.button === 2) return
  canvasRef.value?.setPointerCapture(event.pointerId)
  const p = pointerPos(event)
  startX = p.x
  startY = p.y
  lastX = p.x
  lastY = p.y
  moved = false
  shiftDown = event.shiftKey
  pointerDown = true
  commandClick = false
  editing = false
  lastEditKey = ''

  // Middle always pans; while a command prefix is armed, left-click issues the
  // command (Shift keeps it armed to queue more) instead of selecting/panning.
  if (button === 1) {
    panning.value = true
  } else if (props.game.editorMode) {
    if (event.shiftKey || button !== 0) {
      panning.value = true
    } else {
      editing = true
      const cell = cellAt(event)
      lastEditKey = `${cell.x},${cell.y}`
      applyEdit(cell, false)
    }
  } else if (button === 0 && props.pending !== 'none') {
    commandClick = true
  } else if (event.shiftKey) {
    panning.value = true
  } else if (button === 0) {
    selecting = true
    box.value = { x: p.x, y: p.y, w: 0, h: 0 }
  }
}

function onPointerMove(event: PointerEvent): void {
  // Always track the hovered cell so orders can be previewed.
  props.game.setHover(cellAt(event))
  emit('changed')
  if (!pointerDown) return
  const p = pointerPos(event)
  if (Math.abs(p.x - lastX) > DRAG_THRESHOLD || Math.abs(p.y - lastY) > DRAG_THRESHOLD) moved = true

  if (editing) {
    const cell = cellAt(event)
    const key = `${cell.x},${cell.y}`
    if (key !== lastEditKey) {
      lastEditKey = key
      applyEdit(cell, false)
    }
  } else if (panning.value && moved) {
    renderer?.camera.panBy(p.x - lastX, p.y - lastY)
    emit('changed')
  } else if (selecting) {
    box.value = {
      x: Math.min(startX, p.x),
      y: Math.min(startY, p.y),
      w: Math.abs(p.x - startX),
      h: Math.abs(p.y - startY),
    }
  }
  lastX = p.x
  lastY = p.y
}

function onPointerUp(event: PointerEvent): void {
  canvasRef.value?.releasePointerCapture(event.pointerId)
  if (!pointerDown) return
  pointerDown = false
  panning.value = false
  const wasCommand = commandClick
  commandClick = false
  const wasEditing = editing
  editing = false

  if (button === 2) {
    selecting = false
    box.value = null
    moved = false
    return
  }

  if (wasEditing) {
    if (!moved && button === 0) applyEdit(cellAt(event), true)
    selecting = false
    box.value = null
    moved = false
    return
  }

  if (wasCommand) {
    if (!moved && button === 0 && props.pending !== 'none') {
      const command = props.pending === 'attack' ? 'attack' : 'move'
      props.game.orderAt(cellAt(event), command)
      // Shift keeps the prefix armed so several commands can be queued.
      if (!shiftDown) props.game.clearPendingCommand()
      emit('ordered')
      emit('changed')
    }
    selecting = false
    box.value = null
    moved = false
    return
  }

  const add = additive(event) || shiftDown
  if (!moved) {
    // A plain left-click selects and drops any armed command prefix.
    if (button === 0) {
      const w = worldAt(event)
      props.game.clearPendingCommand()
      props.game.selectAt(w.x, w.y, add)
      emit('changed')
    }
  } else if (selecting) {
    const rect = box.value
    if (rect) {
      const a = renderer!.camera.screenToWorld(rect.x, rect.y)
      const b = renderer!.camera.screenToWorld(rect.x + rect.w, rect.y + rect.h)
      props.game.selectRect(a.x, a.y, b.x, b.y, add)
      emit('changed')
    }
  }
  selecting = false
  box.value = null
  moved = false
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  if (props.game.editorMode) {
    const cell = cellAt(event)
    props.game.removePieceAt(cell.x, cell.y)
    emit('changed')
    return
  }
  props.game.clearPendingCommand()
  props.game.orderAt(cellAt(event))
  emit('ordered')
  emit('changed')
}

function onPointerLeave(): void {
  props.game.setHover(null)
  emit('changed')
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const p = pointerPos(event)
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
  const factor = Math.min(1.4, Math.max(0.7, Math.exp(-delta * 0.0008)))
  renderer?.camera.zoomAt(p.x, p.y, factor)
  emit('changed')
}

function fit(): void {
  if (renderer && canvasRef.value) {
    renderer.resize()
    renderer.fit(props.game)
  }
}

/**
 * Recompute the viewport after a layout change (panels/HUD toggled) without
 * re-fitting the board, so the player's current zoom and centre are preserved.
 */
function resize(): void {
  renderer?.resize()
}

defineExpose({ fit, resize, cellAtClient, overBoard })

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
      :class="{
        panning: panning,
        editor: props.editor,
        'pending-move': props.pending === 'move',
        'pending-attack': props.pending === 'attack',
      }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
      @wheel="onWheel"
      @contextmenu="onContextMenu"
    />
    <div
      v-if="box"
      class="select-box"
      :style="{ left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' }"
    ></div>
  </div>
</template>
