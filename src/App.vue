<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import BoardView from './components/BoardView.vue'
import EventLog from './components/EventLog.vue'
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
  SNAPSHOT_INTERVAL_MS,
} from './game/constants'
import { Game } from './game/game'
import type { GameMode, GameSnapshot, OverlayFlags } from './game/game'
import { Recorder } from './game/record'
import { StudyController } from './game/study'
import type { StudyOptions, StudyState } from './game/study'
import { loadSettings, saveSettings } from './game/settings'
import { deleteSlot, listSlots, loadSlot, saveSlot } from './game/storage'
import type { SlotMeta } from './game/storage'
import type { StanceMode, TeamId } from './game/types'

const game = new Game(8)
game.applySettings(loadSettings() ?? {})
const recorder = new Recorder(game)
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

const bottomHeight = ref(clampBottomPx(game.bottomFraction * window.innerHeight))

const gridRows = computed(() =>
  snapshot.value.hudVisible
    ? `auto auto minmax(${MIN_STAGE_PX}px, 1fr) 6px ${bottomHeight.value}px`
    : 'auto auto minmax(0, 1fr)',
)

let timer = 0

function clampBottomPx(px: number): number {
  return Math.round(Math.max(MIN_BOTTOM_PX, Math.min(px, window.innerHeight - MIN_STAGE_PX)))
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

function onWindowResize(): void {
  bottomHeight.value = clampBottomPx(game.bottomFraction * window.innerHeight)
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
  const queued = snapshot.value.queuedTurns > 0 ? ` · +${snapshot.value.queuedTurns} queued` : ''
  if (snapshot.value.turnActive) return `TURN ${snapshot.value.turn}${queued}`
  if (snapshot.value.replaying) return `REPLAY${queued}`
  return snapshot.value.canReplay ? 'READY — space for next turn' : 'press space for a turn'
})

function refresh(): void {
  study.tick()
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
  boardView.value?.fit()
  refresh()
}

function onSetGameMode(mode: GameMode): void {
  game.setGameMode(mode)
  recorder.reset()
  persistSettings()
  refresh()
}

function onStudyRun(options: StudyOptions): void {
  study.start(options)
  refresh()
}

function onStudyStop(): void {
  study.stopCurrent()
  refresh()
}

function onStudyCancel(): void {
  study.cancel()
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
  nextTick(() => boardView.value?.resize())
}

function onToggleRails(): void {
  game.railsVisible = !game.railsVisible
  persistSettings()
  refresh()
  nextTick(() => boardView.value?.resize())
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

function onReset(): void {
  game.reset()
  recorder.reset()
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
  refresh()
}

function onRedo(): void {
  game.redoTurn()
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

function copyShorthand(): void {
  void copyText(game.shorthand(), 'shorthand')
}

function copyLlm(): void {
  void copyText(game.llmShorthand(), 'llm')
}

function copyRecord(): void {
  recorder.finish()
  void copyText(JSON.stringify(recorder.record, null, 2), 'record')
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
  refresh()
}

function onSaveSlot(): void {
  const result = saveSlot(slotName.value, game.exportPosition())
  if (!result.ok) {
    ioMessage.value = result.error
    return
  }
  ioMessage.value = ''
  slotName.value = ''
  refreshSlots()
}

function onLoadSlot(id: string): void {
  const data = loadSlot(id)
  if (!data) {
    ioMessage.value = 'slot not found'
    return
  }
  if (!window.confirm('Load this position? Unsaved progress will be lost.')) return
  applyLoaded(data)
}

function onDeleteSlot(id: string): void {
  if (!window.confirm('Delete this saved position?')) return
  deleteSlot(id)
  refreshSlots()
}

function onExport(): void {
  const json = JSON.stringify(game.exportPosition(), null, 2)
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
    game.undoTurn()
    refresh()
  } else if (event.key === 'r') {
    game.redoTurn()
    refresh()
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
      class="stage"
      :class="{ 'no-rosters': !snapshot.hudVisible, 'no-rails': !snapshot.railsVisible }"
    >
      <aside v-if="snapshot.railsVisible" class="rail left">
        <div class="rail-title">controls</div>
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
        <PiecePanel
          :snapshot="snapshot"
          @set-stance="onSetPieceStance"
          @clear-orders="onClearOrders"
        />
      </aside>

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

      <aside v-if="snapshot.railsVisible" class="rail right">
        <div class="rail-title">stance</div>
        <ul class="legend">
          <li><span class="dot" style="background: #4ad991"></span><b>M</b> Move — travel, return fire only</li>
          <li><span class="dot" style="background: #ff3b30"></span><b>A</b> Attack — engage nearby, flee when low</li>
          <li><b>no badge</b> — no order (stand &amp; fire in range)</li>
          <li><span class="dot" style="background: #ff2d20"></span><b>red ring</b> ordered attack target</li>
          <li><span class="dot" style="background: #e3b341"></span><b>amber ring</b> auto-acquired / retaliation target</li>
        </ul>
        <div class="rail-title">hover</div>
        <div class="hover-readout">
          <span>{{ snapshot.hoverName ?? '—' }}</span>
          <span v-if="snapshot.hoverKind" class="muted">· {{ snapshot.hoverKind }}</span>
        </div>
        <div class="rail-title">legend</div>
        <ul class="legend">
          <li><span class="sw sw-move"></span> move cells</li>
          <li><span class="sw sw-attack"></span> attack cells</li>
          <li><span class="ln ln-route"></span> route / objective</li>
          <li><span class="dot" style="background: #ffd166"></span><b>1·2·3</b> queued waypoints</li>
          <li><span class="sw sw-bar"></span> health (green→red) · <span class="sw sw-reload"></span> recharge (teal)</li>
        </ul>
        <div class="rail-title">firing lines</div>
        <ul class="legend">
          <li><span class="ln ln-shoot"></span> clear shot</li>
          <li><span class="ln ln-blocked"></span> blocked</li>
          <li><span class="ln ln-unreachable"></span> out of reach</li>
        </ul>
        <div class="rail-title">position</div>
        <button class="ctl copy-btn" @click="copyJson">{{ copied === 'json' ? 'Copied!' : 'Copy position JSON' }}</button>
        <div class="io-row">
          <button class="ctl" @click="copyShorthand">
            {{ copied === 'shorthand' ? 'Copied!' : 'Copy shorthand' }}
          </button>
          <button class="ctl" @click="copyLlm">{{ copied === 'llm' ? 'Copied!' : 'Copy for LLM' }}</button>
        </div>
        <button class="ctl copy-btn" @click="copyRecord">
          {{ copied === 'record' ? 'Copied!' : 'Copy game record' }}
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
            <span class="slot-name" :title="new Date(slot.savedAt).toLocaleString()">{{ slot.name }}</span>
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
      </aside>
    </div>

    <div
      v-if="snapshot.hudVisible"
      class="splitter"
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
