<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import BoardView from './components/BoardView.vue'
import CollapsibleSection from './components/CollapsibleSection.vue'
import EventLog from './components/EventLog.vue'
import LegendIcon from './components/LegendIcon.vue'
import PiecePanel from './components/PiecePanel.vue'
import ReinforcementBar from './components/ReinforcementBar.vue'
import StatsBar from './components/StatsBar.vue'
import Toolbar from './components/Toolbar.vue'
import type { BoardSize } from './game/boards'
import { AudioEngine } from './audio/audio'
import type { VoiceSpec } from './audio/voices'
import {
  BOTTOM_FRACTION_DEFAULT,
  BOTTOM_FRACTION_MAX,
  BOTTOM_FRACTION_MIN,
  RAIL_FRACTION_DEFAULT,
  RAIL_FRACTION_MAX,
  RAIL_FRACTION_MIN,
  SNAPSHOT_INTERVAL_MS,
} from './game/constants'
import { Game } from './game/game'
import type { GameMode, GameSnapshot, HoverInfo, OverlayFlags } from './game/game'
import { INTENT_LABELS } from './game/intent'
import { GameLog } from './game/gameLog'
import { Recorder } from './game/record'
import { StudyController } from './game/study'
import type { StudyOptions, StudyState } from './game/study'
import { buildGamePrompt, buildSnapshotPrompt } from './game/studyPrompt'
import { loadSettings, saveSettings } from './game/settings'
import { deleteSlot, listSlots, loadSlot, saveSlot } from './game/storage'
import type { SlotMeta } from './game/storage'
import type { StanceMode, TeamId } from './game/types'

const game = new Game(8)
game.applySettings(loadSettings() ?? {})
const recorder = new Recorder(game)
const liveLog = new GameLog(game)
const study = new StudyController(game, recorder)
const audio = new AudioEngine({ enabled: game.soundEnabled })
const unsubscribeAudio = game.bus.subscribe((event) => audio.handle(event))
const snapshot = shallowRef<GameSnapshot>(game.snapshot())
const studyState = shallowRef<StudyState>(study.state)
const barProgress = ref(0)
const barHeld = computed(
  () => !snapshot.value.turnActive && !snapshot.value.replaying && barProgress.value >= 1,
)
const copied = ref('')
const boardView = ref<InstanceType<typeof BoardView> | null>(null)
const slots = ref<SlotMeta[]>([])
const slotName = ref('')
const ioMessage = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

/** Pixel clamps for the resizable HUD bottom panel. */
const MIN_BOTTOM_PX = 120
const MIN_STAGE_PX = 180

/** Pixel clamps for the resizable side rails. */
const MIN_RAIL_PX = 120
const MIN_BOARD_PX = 260
const SPLITTER_PX = 6
const ROSTER_PX = 200

const stageEl = ref<HTMLElement | null>(null)

const bottomHeight = ref(clampBottomPx(game.bottomFraction * window.innerHeight))
const leftWidth = ref(clampRailPx(game.leftRailFraction * window.innerWidth, 0))
const rightWidth = ref(clampRailPx(game.rightRailFraction * window.innerWidth, leftWidth.value))

const gridRows = computed(() =>
  snapshot.value.hudVisible
    ? `auto auto minmax(${MIN_STAGE_PX}px, 1fr) ${SPLITTER_PX}px ${bottomHeight.value}px`
    : 'auto auto minmax(0, 1fr)',
)

/** Stage columns, adapting to which side stacks (rails, rosters) are visible. */
const stageColumns = computed(() => {
  const left = `calc(${leftWidth.value}px + ${SPLITTER_PX}px)`
  const right = `calc(${rightWidth.value}px + ${SPLITTER_PX}px)`
  const roster = `${ROSTER_PX}px`
  if (snapshot.value.railsVisible && snapshot.value.hudVisible) {
    return `${left} ${roster} minmax(0, 1fr) ${roster} ${right}`
  }
  if (snapshot.value.railsVisible) return `${left} minmax(0, 1fr) ${right}`
  if (snapshot.value.hudVisible) return `${roster} minmax(0, 1fr) ${roster}`
  return 'minmax(0, 1fr)'
})

let timer = 0

function clampBottomPx(px: number): number {
  return Math.round(Math.max(MIN_BOTTOM_PX, Math.min(px, window.innerHeight - MIN_STAGE_PX)))
}

/** Available width for a rail: viewport minus the board floor, rosters and splitters. */
function railReserve(): number {
  const rosters = snapshot.value.hudVisible ? ROSTER_PX * 2 : 0
  return MIN_BOARD_PX + rosters + SPLITTER_PX * 2
}

function clampRailPx(px: number, otherPx: number): number {
  const max = Math.max(MIN_RAIL_PX, window.innerWidth - railReserve() - otherPx)
  return Math.round(Math.max(MIN_RAIL_PX, Math.min(px, max)))
}

/** Re-clamp both rails after a layout change (HUD/rails toggle, resize). */
function reclampRails(): void {
  rightWidth.value = clampRailPx(rightWidth.value, leftWidth.value)
  leftWidth.value = clampRailPx(leftWidth.value, rightWidth.value)
}

let splitterDrag = false

function onSplitterDown(event: PointerEvent): void {
  splitterDrag = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onSplitterMove(event: PointerEvent): void {
  if (!splitterDrag) return
  bottomHeight.value = clampBottomPx(window.innerHeight - event.clientY)
}

function onSplitterUp(event: PointerEvent): void {
  if (!splitterDrag) return
  splitterDrag = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  persistBottomHeight()
}

function onSplitterReset(): void {
  bottomHeight.value = clampBottomPx(window.innerHeight * BOTTOM_FRACTION_DEFAULT)
  persistBottomHeight()
}

function persistBottomHeight(): void {
  const fraction = bottomHeight.value / window.innerHeight
  game.bottomFraction = Math.max(BOTTOM_FRACTION_MIN, Math.min(BOTTOM_FRACTION_MAX, fraction))
  persistSettings()
}

let railDrag: 'left' | 'right' | null = null

function onRailDown(side: 'left' | 'right', event: PointerEvent): void {
  railDrag = side
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onRailMove(side: 'left' | 'right', event: PointerEvent): void {
  if (railDrag !== side) return
  const rect = stageEl.value?.getBoundingClientRect()
  const left = rect?.left ?? 0
  const right = rect?.right ?? window.innerWidth
  if (side === 'left') leftWidth.value = clampRailPx(event.clientX - left, rightWidth.value)
  else rightWidth.value = clampRailPx(right - event.clientX, leftWidth.value)
}

function onRailUp(side: 'left' | 'right', event: PointerEvent): void {
  if (railDrag !== side) return
  railDrag = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  persistRailWidths()
}

function onRailReset(side: 'left' | 'right'): void {
  const other = side === 'left' ? rightWidth.value : leftWidth.value
  const px = clampRailPx(window.innerWidth * RAIL_FRACTION_DEFAULT, other)
  if (side === 'left') leftWidth.value = px
  else rightWidth.value = px
  persistRailWidths()
}

function persistRailWidths(): void {
  const clamp = (fraction: number) =>
    Math.max(RAIL_FRACTION_MIN, Math.min(RAIL_FRACTION_MAX, fraction))
  game.leftRailFraction = clamp(leftWidth.value / window.innerWidth)
  game.rightRailFraction = clamp(rightWidth.value / window.innerWidth)
  persistSettings()
}

function onWindowResize(): void {
  bottomHeight.value = clampBottomPx(game.bottomFraction * window.innerHeight)
  leftWidth.value = clampRailPx(game.leftRailFraction * window.innerWidth, rightWidth.value)
  rightWidth.value = clampRailPx(game.rightRailFraction * window.innerWidth, leftWidth.value)
}

/** Resume the audio context on the first user gesture (autoplay policy). */
function unlockAudio(): void {
  window.removeEventListener('pointerdown', unlockAudio)
  window.removeEventListener('keydown', unlockAudio)
  if (game.soundEnabled) void audio.unlock()
}

const turnLabel = computed(() => {
  if (snapshot.value.winner) {
    return `GAME OVER — ${snapshot.value.teams[snapshot.value.winner].name} wins (u to undo)`
  }
  const turn = `TURN ${snapshot.value.turn}`
  const queued = snapshot.value.queuedTurns > 0 ? ` · +${snapshot.value.queuedTurns} queued` : ''
  if (snapshot.value.turnActive) return `${turn}${queued}`
  if (snapshot.value.replaying) return `${turn} · REPLAY${queued}`
  return snapshot.value.canReplay ? `${turn} · READY — space for next turn` : `${turn} · press space for a turn`
})

const hover = computed(() => snapshot.value.hover)

/** Describe a hovered piece's current activity: motion intent, else its order/stance. */
function hoverIntent(info: HoverInfo | null): string {
  const piece = info?.piece
  if (!piece) return ''
  if (piece.intent !== 'none') return INTENT_LABELS[piece.intent]
  if (piece.orderKind !== 'none') return piece.orderKind === 'attack' ? 'ordered attack' : 'ordered move'
  return piece.stance === 'none' ? 'idle' : `${piece.stance} stance`
}

function refresh(): void {
  study.tick()
  if (!study.state.running) liveLog.tick()
  snapshot.value = game.snapshot()
  studyState.value = study.state
}

function persistSettings(): void {
  saveSettings(game.settings())
}

function onDeploy(team: TeamId, key: string): void {
  game.deploy(team, key)
  refresh()
}

function onSelectSize(size: number): void {
  game.loadSize(size as BoardSize)
  recorder.reset()
  liveLog.begin()
  boardView.value?.fit()
  refresh()
}

function onSetGameMode(mode: GameMode): void {
  game.setGameMode(mode)
  recorder.reset()
  liveLog.begin()
  persistSettings()
  refresh()
}

function onStudyRun(options: StudyOptions): void {
  study.start(options)
  liveLog.begin()
  refresh()
}

function onStudyStop(): void {
  study.stopCurrent()
  liveLog.begin()
  refresh()
}

function onStudyCancel(): void {
  study.cancel()
  liveLog.begin()
  refresh()
}

function onSetPieceStance(mode: StanceMode): void {
  game.setPieceStance(mode)
  refresh()
}

function onClearOrders(): void {
  game.clearOrders()
  refresh()
}

function onSetSpeed(speed: number): void {
  game.setSpeed(speed)
  persistSettings()
  refresh()
}

function onOrdered(): void {
  refresh()
}

function onToggleOverlay(key: keyof OverlayFlags): void {
  game.overlays[key] = !game.overlays[key]
  persistSettings()
  refresh()
}

function onToggleSound(): void {
  game.soundEnabled = !game.soundEnabled
  audio.setEnabled(game.soundEnabled)
  persistSettings()
  refresh()
}

function onAudition(id: string): void {
  audio.audition(id)
}

function onPreview(spec: VoiceSpec): void {
  audio.preview(spec)
}

function onStopPreview(): void {
  audio.stopPreview()
}

function onToggleHud(): void {
  game.hudVisible = !game.hudVisible
  persistSettings()
  refresh()
  nextTick(() => {
    reclampRails()
    boardView.value?.resize()
  })
}

function onToggleRails(): void {
  game.railsVisible = !game.railsVisible
  persistSettings()
  refresh()
  nextTick(() => {
    reclampRails()
    boardView.value?.resize()
  })
}

function onToggleControls(): void {
  game.controlsCollapsed = !game.controlsCollapsed
  persistSettings()
  refresh()
}

function onToggleStance(): void {
  game.stanceCollapsed = !game.stanceCollapsed
  persistSettings()
  refresh()
}

function onToggleLegend(): void {
  game.legendCollapsed = !game.legendCollapsed
  persistSettings()
  refresh()
}

function onToggleFiringLines(): void {
  game.firingLinesCollapsed = !game.firingLinesCollapsed
  persistSettings()
  refresh()
}

function onToggleCopy(): void {
  game.copyCollapsed = !game.copyCollapsed
  persistSettings()
  refresh()
}

function onToggleAutoPreserve(): void {
  game.setAutoPreserve(!game.autoPreserve)
  persistSettings()
  refresh()
}

function onToggleCaptureAdvance(): void {
  game.setCaptureAdvance(!game.captureAdvance)
  persistSettings()
  refresh()
}

function onToggleChessKills(): void {
  game.setChessKills(!game.chessKills)
  persistSettings()
  refresh()
}

function onReset(): void {
  game.reset()
  recorder.reset()
  liveLog.begin()
  boardView.value?.fit()
  refresh()
}

function onTurn(): void {
  // Starting while a turn/replay is running buffers the request instead of
  // dropping it, so a double-tap plays two turns back-to-back.
  game.queueTurn()
  refresh()
}

function onReplay(): void {
  game.replayTurn()
  refresh()
}

function onUndo(): void {
  game.undoTurn()
  liveLog.rewind(game.turn)
  refresh()
}

function onRedo(): void {
  game.redoTurn()
  liveLog.rewind(game.turn)
  refresh()
}

async function copyText(text: string, kind: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = kind
    window.setTimeout(() => {
      if (copied.value === kind) copied.value = ''
    }, 1200)
  } catch {
    console.log(text)
  }
}

function copyJson(): void {
  void copyText(JSON.stringify(game.exportPosition(), null, 2), 'json')
}

function copyLlm(): void {
  const record = recorder.snapshot()
  const { transcript, analysis } = liveLog.finish(record, { boards: true })
  void copyText(buildGamePrompt({ game, record, transcript, analysis }), 'llm')
}

function copySnapshot(): void {
  void copyText(
    buildSnapshotPrompt({ game, trace: liveLog.turnTrace, events: liveLog.eventStream }),
    'snapshot',
  )
}

function refreshSlots(): void {
  slots.value = listSlots()
}

function applyLoaded(data: unknown): void {
  const result = game.importPosition(data)
  if (!result.ok) {
    ioMessage.value = result.error
    return
  }
  ioMessage.value = ''
  boardView.value?.fit()
  recorder.reset()
  liveLog.begin()
  refresh()
}

function onSaveSlot(): void {
  const result = saveSlot(slotName.value, game.exportPosition({ history: true }))
  if (!result.ok) {
    ioMessage.value = result.error
    return
  }
  ioMessage.value = result.warning ?? ''
  slotName.value = ''
  refreshSlots()
}

function onLoadSlot(id: string): void {
  const data = loadSlot(id)
  if (!data) {
    ioMessage.value = 'slot not found'
    return
  }
  applyLoaded(data)
}

function onDeleteSlot(id: string): void {
  deleteSlot(id)
  refreshSlots()
}

function onExport(): void {
  const json = JSON.stringify(game.exportPosition({ history: true }), null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `bar-chess-${snapshot.value.boardId}-tick${snapshot.value.tick}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function onImportClick(): void {
  fileInput.value?.click()
}

async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    applyLoaded(JSON.parse(await file.text()))
  } catch {
    ioMessage.value = 'invalid JSON file'
  }
}

function onKey(event: KeyboardEvent): void {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
  if (event.key === 'h') onToggleHud()
  else if (event.key === 'Tab') {
    event.preventDefault()
    onToggleRails()
  } else if (event.key === 'p') {
    game.togglePause()
    refresh()
  } else if (event.key === ' ') {
    event.preventDefault()
    onTurn()
  } else if (event.key === 's') {
    game.stepOnce()
    refresh()
  } else if (event.key === 'u') {
    onUndo()
  } else if (event.key === 'r') {
    onRedo()
  } else if (event.key === 'y') {
    onReplay()
  } else if (event.key === 'c' || event.key === 'Backspace') {
    event.preventDefault()
    game.clearOrders()
    refresh()
  } else if (event.key === 'o') {
    onToggleOverlay('myOrders')
  } else if (event.key === 'e') {
    onToggleOverlay('enemyPlans')
  } else if (event.key === 'Escape') {
    if (game.pendingCommand !== 'none') game.clearPendingCommand()
    else game.clearSelection()
    refresh()
  } else if (event.key === 'm') {
    game.setPendingCommand('move')
    refresh()
  } else if (event.key === 'a') {
    game.setPendingCommand('attack')
    refresh()
  }
}

onMounted(() => {
  game.start()
  liveLog.begin()
  game.onProgress = (value) => {
    barProgress.value = value
  }
  refreshSlots()
  timer = window.setInterval(refresh, SNAPSHOT_INTERVAL_MS)
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('keydown', unlockAudio)
  window.addEventListener('resize', onWindowResize)
  if (import.meta.env.DEV) {
    ;(window as unknown as { game: Game }).game = game
  }
})

onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.removeEventListener('keydown', onKey)
  game.onProgress = null
  window.removeEventListener('pointerdown', unlockAudio)
  window.removeEventListener('keydown', unlockAudio)
  window.removeEventListener('resize', onWindowResize)
  unsubscribeAudio()
  audio.dispose()
  liveLog.dispose()
  study.dispose()
  game.stop()
})
</script>

<template>
  <div class="app" :class="{ 'hud-hidden': !snapshot.hudVisible }" :style="{ gridTemplateRows: gridRows }">
    <Toolbar
      :snapshot="snapshot"
      @select-size="onSelectSize"
      @set-game-mode="onSetGameMode"
      @toggle-pause="game.togglePause(); refresh()"
      @step="game.stepOnce(); refresh()"
      @turn="onTurn"
      @undo="onUndo"
      @redo="onRedo"
      @replay="onReplay"
      @set-speed="onSetSpeed"
      @toggle-overlay="onToggleOverlay"
      @toggle-sound="onToggleSound"
      @reset="onReset"
      @toggle-hud="onToggleHud"
      @toggle-auto-preserve="onToggleAutoPreserve"
      @toggle-capture-advance="onToggleCaptureAdvance"
      @toggle-chess-kills="onToggleChessKills"
    />

    <div
      class="turnbar"
      :class="{ active: snapshot.turnActive, replay: snapshot.replaying }"
      :title="snapshot.turnActive ? 'turn in progress (space)' : 'press space for a turn, u/r to undo/redo, y to replay'"
    >
      <div
        class="turnbar-fill"
        :class="{ complete: barHeld }"
        :style="{ width: barProgress * 100 + '%' }"
      ></div>
      <span class="turnbar-label">{{ turnLabel }}</span>
      <span
        v-if="snapshot.pendingCommand !== 'none'"
        class="pending-command"
        :class="snapshot.pendingCommand"
      >
        {{ snapshot.pendingCommand === 'attack' ? 'ATTACK — left-click a target' : 'MOVE — left-click a square' }}
        · shift to queue · esc to cancel
      </span>
    </div>

    <div
      ref="stageEl"
      class="stage"
      :class="{ 'no-rosters': !snapshot.hudVisible, 'no-rails': !snapshot.railsVisible }"
      :style="{ gridTemplateColumns: stageColumns }"
    >
      <div v-if="snapshot.railsVisible" class="rail-stack left">
        <aside class="rail left">
          <CollapsibleSection
            title="controls"
            :open="!snapshot.controlsCollapsed"
            @toggle="onToggleControls"
          >
            <ul class="hints">
              <li><b>left-click</b> select · <b>shift-click</b> add · <b>drag</b> box</li>
              <li><b>right-click</b> empty → move · enemy → attack</li>
              <li><b>right-click</b> again (or shift) → queue next step</li>
              <li><b>m</b>/<b>a</b> then left-click → move / attack · shift to queue</li>
              <li><b>shift-drag</b>/middle pan · <b>wheel</b> zoom</li>
              <li><b>space</b> turn · <b>p</b> pause · <b>s</b> step</li>
              <li><b>u</b> undo · <b>r</b> redo · <b>y</b> replay · <b>c</b>/<b>Backspace</b> clear orders</li>
              <li><b>o</b> my orders · <b>e</b> enemy · <b>h</b> HUD · <b>tab</b> panels · <b>esc</b> cancel</li>
            </ul>
          </CollapsibleSection>
          <PiecePanel
            :snapshot="snapshot"
            @set-stance="onSetPieceStance"
            @clear-orders="onClearOrders"
          />
        </aside>
        <div
          class="splitter vertical"
          title="drag to resize · double-click to reset"
          @pointerdown="onRailDown('left', $event)"
          @pointermove="onRailMove('left', $event)"
          @pointerup="onRailUp('left', $event)"
          @dblclick="onRailReset('left')"
        ></div>
      </div>

      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.red"
        side="left"
        @deploy="onDeploy('red', $event)"
      />

      <div class="center">
        <div class="board-area">
          <BoardView
            ref="boardView"
            :game="game"
            :pending="snapshot.pendingCommand"
            @changed="refresh"
            @ordered="onOrdered"
          />
        </div>
      </div>

      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.blue"
        side="right"
        @deploy="onDeploy('blue', $event)"
      />

      <div v-if="snapshot.railsVisible" class="rail-stack right">
        <div
          class="splitter vertical"
          title="drag to resize · double-click to reset"
          @pointerdown="onRailDown('right', $event)"
          @pointermove="onRailMove('right', $event)"
          @pointerup="onRailUp('right', $event)"
          @dblclick="onRailReset('right')"
        ></div>
        <aside class="rail right">
          <CollapsibleSection
            title="stance"
            :open="!snapshot.stanceCollapsed"
            @toggle="onToggleStance"
          >
            <ul class="legend">
              <li><LegendIcon kind="badge-m" /><b>M</b> Move — travel, return fire only</li>
              <li><LegendIcon kind="badge-a" /><b>A</b> Attack — engage nearby, flee when low</li>
              <li><LegendIcon kind="badge-none" /><b>no order</b> — stand &amp; fire in range</li>
              <li><LegendIcon kind="ring-red" /><b>ordered</b> attack target</li>
              <li><LegendIcon kind="ring-amber" /><b>auto-acquired</b> / retaliation target</li>
            </ul>
          </CollapsibleSection>

          <CollapsibleSection
            title="legend"
            :open="!snapshot.legendCollapsed"
            @toggle="onToggleLegend"
          >
            <ul class="legend">
              <li><LegendIcon kind="move-cell" /> move cells</li>
              <li><LegendIcon kind="attack-cell" /> attack cells</li>
              <li><LegendIcon kind="range-arc" /> range arc (selected)</li>
              <li><LegendIcon kind="route" /> route <span class="muted">(orange = partial / blocked)</span></li>
              <li><LegendIcon kind="objective" /> objective destination</li>
              <li><LegendIcon kind="preserve" /> self-preservation retreat</li>
              <li><LegendIcon kind="waypoint" /> queued waypoints</li>
              <li><LegendIcon kind="select-ring" /> selected piece</li>
              <li><LegendIcon kind="bar-health" /> health (green→red)</li>
              <li><LegendIcon kind="bar-reload" /> recharge (teal)</li>
            </ul>
          </CollapsibleSection>

          <CollapsibleSection
            title="firing lines"
            :open="!snapshot.firingLinesCollapsed"
            @toggle="onToggleFiringLines"
          >
            <ul class="legend">
              <li><LegendIcon kind="line-clear" /> clear shot</li>
              <li><LegendIcon kind="line-blocked" /> firing shot blocked</li>
              <li><LegendIcon kind="line-unreachable" /> out of reach</li>
              <li><LegendIcon kind="line-engage" /> engaging (auto-acquired)</li>
              <li><LegendIcon kind="line-potshot" /> pot shot (in range only)</li>
            </ul>
          </CollapsibleSection>

          <div class="rail-title">hover</div>
          <div class="hover-readout">
            <template v-if="hover?.piece">
              <span class="hover-glyph" :style="{ color: hover.piece.color }">{{ hover.piece.glyph }}</span>
              <b>{{ hover.piece.name }}</b>
              <span class="muted">· {{ hover.kind }}</span>
              <span v-if="hover.piece.redacted" class="muted">· intent hidden</span>
              <span v-else class="hover-intent">· {{ hoverIntent(hover) }}</span>
              <span v-if="hover.piece.targetCoord" class="muted">→ {{ hover.piece.targetCoord }}</span>
            </template>
            <template v-else>
              <span>{{ hover?.coord ?? '—' }}</span>
              <span v-if="hover" class="muted">· {{ hover.kind }}</span>
            </template>
          </div>

          <CollapsibleSection
            title="copy"
            :open="!snapshot.copyCollapsed"
            @toggle="onToggleCopy"
          >
            <button class="ctl copy-btn" @click="copyLlm">
              {{ copied === 'llm' ? 'Copied!' : 'Copy history for LLM' }}
            </button>
            <button class="ctl copy-btn" @click="copySnapshot">
              {{ copied === 'snapshot' ? 'Copied!' : 'Copy snapshot for LLM' }}
            </button>
            <button class="ctl copy-btn" @click="copyJson">
              {{ copied === 'json' ? 'Copied!' : 'Copy state (JSON)' }}
            </button>
            <div class="save-row">
              <input
                v-model="slotName"
                class="slot-input"
                type="text"
                placeholder="slot name"
                @keydown.enter="onSaveSlot"
              />
              <button class="ctl" @click="onSaveSlot">Save</button>
            </div>
            <ul v-if="slots.length" class="slots">
              <li v-for="slot in slots" :key="slot.id">
                <span class="slot-name" :title="new Date(slot.savedAt).toLocaleString()">
                  {{ slot.name }}<template v-if="slot.turns"> · {{ slot.turns }} turns</template>
                </span>
                <button class="ctl small" @click="onLoadSlot(slot.id)">Load</button>
                <button class="ctl small" @click="onDeleteSlot(slot.id)">Del</button>
              </li>
            </ul>
            <div class="io-row">
              <button class="ctl" @click="onExport">Export JSON</button>
              <button class="ctl" @click="onImportClick">Import JSON</button>
            </div>
            <input
              ref="fileInput"
              class="hidden-file"
              type="file"
              accept="application/json,.json"
              @change="onImportFile"
            />
            <p v-if="ioMessage" class="io-msg">{{ ioMessage }}</p>
          </CollapsibleSection>
        </aside>
      </div>
    </div>

    <div
      v-if="snapshot.hudVisible"
      class="splitter horizontal"
      title="drag to resize the HUD · double-click to reset"
      @pointerdown="onSplitterDown"
      @pointermove="onSplitterMove"
      @pointerup="onSplitterUp"
      @dblclick="onSplitterReset"
    ></div>

    <div v-if="snapshot.hudVisible" class="bottom">
      <StatsBar :snapshot="snapshot" />
      <EventLog
        :snapshot="snapshot"
        :study-state="studyState"
        @audition="onAudition"
        @preview="onPreview"
        @stop="onStopPreview"
        @study-run="onStudyRun"
        @study-stop="onStudyStop"
        @study-cancel="onStudyCancel"
      />
    </div>
  </div>
</template>
