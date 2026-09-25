<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import BoardView from './components/BoardView.vue'
import CollapsibleSection from './components/CollapsibleSection.vue'
import EditorPanel from './components/EditorPanel.vue'
import EventLog from './components/EventLog.vue'
import LegendIcon from './components/LegendIcon.vue'
import MapsModal from './components/MapsModal.vue'
import PiecePanel from './components/PiecePanel.vue'
import ReinforcementBar from './components/ReinforcementBar.vue'
import StatsBar from './components/StatsBar.vue'
import Toolbar from './components/Toolbar.vue'
import TurnList from './components/TurnList.vue'
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
import { exportMap, validateMap } from './game/map'
import type { SavedMap } from './game/map'
import { deleteMap, getMap, listMaps, renameMap, saveMap } from './game/mapStore'
import { Recorder } from './game/record'
import type { GameRecord } from './game/record'
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
  () =>
    !snapshot.value.turnActive &&
    !snapshot.value.replaying &&
    !snapshot.value.playing &&
    barProgress.value >= 1,
)
const copied = ref('')
const forkArmed = ref(false)
const boardView = ref<InstanceType<typeof BoardView> | null>(null)
const slots = ref<SlotMeta[]>([])
const slotName = ref('')
const ioMessage = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const maps = ref<SavedMap[]>([])
const mapsOpen = ref(false)
const mapName = ref('')
const editingMapId = ref<string | null>(null)
const mapMessage = ref('')
const mapFileInput = ref<HTMLInputElement | null>(null)

interface PaletteDrag {
  team: TeamId
  key: string
  glyph: string
  color: string
  startX: number
  startY: number
  x: number
  y: number
  moved: boolean
}
const drag = ref<PaletteDrag | null>(null)
let dragCleanup: (() => void) | null = null
let recorderBackup: GameRecord | null = null

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

/** Active sub-tab in each side rail (left: games/turns, right: piece/info). */
const leftTab = ref<'games' | 'turns'>('games')
const rightTab = ref<'piece' | 'info'>('piece')

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
  const turn = `${snapshot.value.megaTurn ? 'MEGA TURN' : 'TURN'} ${snapshot.value.turn}`
  const queued = snapshot.value.queuedTurns > 0 ? ` · +${snapshot.value.queuedTurns} queued` : ''
  const playQueued = snapshot.value.queuedPlay ? ' · play queued' : ''
  const last = snapshot.value.turns.length - 1
  const behind = snapshot.value.historyIndex < last
  const forward = snapshot.value.queuedForward > 0 ? ` · +${snapshot.value.queuedForward} queued` : ''
  if (snapshot.value.playing) return `${turn} · PLAYING — space to pause`
  if (snapshot.value.turnActive) return `${turn}${queued}${playQueued}`
  if (snapshot.value.replaying) return `${turn} · REPLAY${queued}${playQueued}${forward}`
  if (behind) {
    return `${turn} · VIEWING ${snapshot.value.historyIndex}/${last} — space replays forward · f discards future turns`
  }
  return snapshot.value.canReplay
    ? `${turn} · READY — space for next turn`
    : `${turn} · press space for a turn`
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
  if (game.editorMode) {
    game.setEditorBrush({ kind: 'piece', team, key })
    refresh()
    return
  }
  game.deploy(team, key)
  refresh()
}

/** Begin dragging a roster piece; `payload` is its screen position at pick-up. */
function onGrab(team: TeamId, payload: { key: string; x: number; y: number }): void {
  if (game.editorMode) game.setEditorBrush({ kind: 'piece', team, key: payload.key })
  const piece = snapshot.value.teams[team].pieces.find((p) => p.key === payload.key)
  const state: PaletteDrag = {
    team,
    key: payload.key,
    glyph: piece?.glyph ?? '?',
    color: snapshot.value.teams[team].color,
    startX: payload.x,
    startY: payload.y,
    x: payload.x,
    y: payload.y,
    moved: false,
  }
  drag.value = state
  const move = (event: PointerEvent): void => {
    const cur = drag.value
    if (!cur) return
    cur.x = event.clientX
    cur.y = event.clientY
    if (Math.hypot(event.clientX - cur.startX, event.clientY - cur.startY) > 5) cur.moved = true
  }
  const up = (event: PointerEvent): void => endPaletteDrag(event)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up, { once: true })
  window.addEventListener('pointercancel', up, { once: true })
  dragCleanup = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
}

function endPaletteDrag(event: PointerEvent): void {
  const state = drag.value
  dragCleanup?.()
  dragCleanup = null
  drag.value = null
  if (!state || !state.moved || event.type === 'pointercancel') return
  const view = boardView.value
  if (!view || !view.overBoard(event.clientX, event.clientY)) return
  if (!game.canEdit) {
    flashMap('finish the turn before placing pieces')
    return
  }
  const cell = view.cellAtClient(event.clientX, event.clientY)
  game.placePiece(state.team, state.key, cell.x, cell.y)
  refresh()
}

function flashMap(message: string): void {
  mapMessage.value = message
  window.setTimeout(() => {
    if (mapMessage.value === message) mapMessage.value = ''
  }, 2500)
}

function refreshMaps(): void {
  void listMaps().then((list) => {
    maps.value = list
  })
}

function openMaps(): void {
  mapsOpen.value = true
  refreshMaps()
}

function closeMaps(): void {
  mapsOpen.value = false
}

/** A map/editor change replaces the battle, so a running study batch must stop. */
function stopStudyIfRunning(): void {
  if (study.state.running) {
    study.cancel()
    liveLog.begin()
  }
}

function onToggleEditor(): void {
  if (game.editorMode) {
    onDoneEditor()
    return
  }
  stopStudyIfRunning()
  recorderBackup = recorder.snapshot()
  game.hudVisible = true
  game.railsVisible = true
  game.setEditor(true)
  mapName.value = game.board.data.name
  editingMapId.value = game.currentMap?.id ?? null
  persistSettings()
  nextTick(() => {
    reclampRails()
    boardView.value?.resize()
  })
  refresh()
}

function onDoneEditor(): void {
  game.setEditor(false)
  recorderBackup = null
  refresh()
}

function onCancelEditor(): void {
  game.cancelEditor()
  if (recorderBackup) {
    recorder.restore(recorderBackup)
    recorderBackup = null
    liveLog.begin()
  }
  refresh()
}

function onToggleErase(): void {
  game.setEditorBrush(game.editorBrush?.kind === 'erase' ? null : { kind: 'erase' })
  refresh()
}

function onSaveMap(): void {
  const name = mapName.value.trim() || `${game.board.width}\u00d7${game.board.height} map`
  const map = exportMap(game, name, { id: editingMapId.value ?? undefined })
  void saveMap(map).then((saved) => {
    editingMapId.value = saved.id
    game.currentMap = saved
    mapName.value = saved.name
    flashMap(`saved "${saved.name}"`)
    refreshMaps()
    refresh()
  })
}

function onNewMap(size: BoardSize): void {
  stopStudyIfRunning()
  recorderBackup = null
  game.hudVisible = true
  game.railsVisible = true
  game.newMap(size)
  recorder.reset()
  liveLog.begin()
  mapName.value = game.board.data.name
  editingMapId.value = null
  closeMaps()
  nextTick(() => {
    reclampRails()
    boardView.value?.fit()
  })
  refresh()
}

function onPlayMap(id: string): void {
  void getMap(id).then((map) => {
    if (!map) {
      flashMap('map not found')
      return
    }
    stopStudyIfRunning()
    game.loadMap(map)
    recorder.reset()
    liveLog.begin()
    closeMaps()
    nextTick(() => boardView.value?.fit())
    refresh()
  })
}

function onEditMap(id: string): void {
  void getMap(id).then((map) => {
    if (!map) {
      flashMap('map not found')
      return
    }
    stopStudyIfRunning()
    game.hudVisible = true
    game.railsVisible = true
    game.loadMap(map)
    recorder.reset()
    recorderBackup = recorder.snapshot()
    game.setEditor(true)
    mapName.value = map.name
    editingMapId.value = map.id
    closeMaps()
    nextTick(() => {
      reclampRails()
      boardView.value?.fit()
    })
    refresh()
  })
}

function onRenameMap(id: string): void {
  const name = window.prompt('map name')
  if (name === null) return
  void renameMap(id, name).then((updated) => {
    if (updated && editingMapId.value === id) mapName.value = updated.name
    refreshMaps()
  })
}

function onDeleteMap(id: string): void {
  if (!window.confirm('delete this map?')) return
  void deleteMap(id).then(() => {
    if (editingMapId.value === id) editingMapId.value = null
    refreshMaps()
  })
}

function onExportMap(map: SavedMap): void {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${map.name || 'map'}.barchess-map.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function onImportMapClick(): void {
  mapFileInput.value?.click()
}

async function onImportMapFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const data: unknown = JSON.parse(await file.text())
    const valid = validateMap(data)
    if (!valid.ok) {
      flashMap(valid.error)
      return
    }
    const saved = await saveMap(data as SavedMap)
    flashMap(`imported "${saved.name}"`)
    refreshMaps()
  } catch {
    flashMap('invalid map JSON')
  }
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

function onTogglePromotion(): void {
  game.setPromotion(!game.promotion)
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
  // At the latest boundary this starts a turn; while viewing an earlier turn it
  // replays the next recorded beat forward instead of forking the timeline.
  game.advance()
  refresh()
}

function onPlayControl(): void {
  if (snapshot.value.playing || snapshot.value.replaying) {
    // Pause live play / abort a replay back to its boundary.
    game.togglePause()
  } else {
    // Idle: play forward through history, then live (a mega turn).
    game.requestPlay()
  }
  refresh()
}

function onFork(): void {
  if (!snapshot.value.canRedo) return
  // Two-step guard: the first f/Fork arms an inline confirmation so the
  // irreversible discard of future turns is always deliberate.
  if (!forkArmed.value) {
    forkArmed.value = true
    return
  }
  confirmFork()
}

function confirmFork(): void {
  game.forkTurn()
  forkArmed.value = false
  liveLog.rewind(game.turn)
  refresh()
}

function cancelFork(): void {
  forkArmed.value = false
}

// Any timeline move or order edit invalidates a pending fork confirmation.
watch(
  [
    () => snapshot.value.historyIndex,
    () => snapshot.value.historyLength,
    () => snapshot.value.ordersTouched,
  ],
  () => {
    forkArmed.value = false
  },
)

function onJumpTurn(index: number): void {
  game.jumpToTurn(index)
  liveLog.rewind(game.turn)
  refresh()
}

function onPlayTurn(index: number): void {
  game.replayTurnAt(index)
  liveLog.rewind(game.turn)
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
  void listSlots().then((list) => {
    slots.value = list
  })
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
  // A freshly loaded game belongs in the turns tab, ready to replay/step.
  leftTab.value = 'turns'
  refresh()
}

async function onSaveSlot(): Promise<void> {
  const result = await saveSlot(slotName.value, game.exportPosition({ history: true }))
  if (!result.ok) {
    ioMessage.value = result.error
    return
  }
  ioMessage.value = result.warning ?? ''
  slotName.value = ''
  refreshSlots()
}

async function onLoadSlot(id: string): Promise<void> {
  const data = await loadSlot(id)
  if (!data) {
    ioMessage.value = 'slot not found'
    return
  }
  applyLoaded(data)
}

async function onDeleteSlot(id: string): Promise<void> {
  await deleteSlot(id)
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
  if (game.editorMode) {
    if (event.key === 'Escape') {
      game.setEditorBrush(null)
      refresh()
    } else if (event.key === 'h') {
      onToggleHud()
    }
    return
  }
  if (event.key === 'h') onToggleHud()
  else if (event.key === 'Tab') {
    event.preventDefault()
    onToggleRails()
  } else if (event.key === 'p') {
    onPlayControl()
  } else if (event.key === ' ') {
    event.preventDefault()
    if (event.shiftKey) {
      // Shift+space: play continuously — forward through history first when
      // viewing an earlier turn, then live from the tip.
      game.requestPlay()
      refresh()
    } else if (snapshot.value.playing) {
      // Space during play pauses and closes the mega turn.
      game.togglePause()
      refresh()
    } else {
      onTurn()
    }
  } else if (event.key === 's') {
    game.stepOnce()
    refresh()
  } else if (event.key === 'u') {
    onUndo()
  } else if (event.key === 'r') {
    onRedo()
  } else if (event.key === 'y') {
    onReplay()
  } else if (event.key === 'f') {
    onFork()
  } else if (event.key === 'c' || event.key === 'Backspace') {
    event.preventDefault()
    game.clearOrders()
    refresh()
  } else if (event.key === 'o') {
    onToggleOverlay('myOrders')
  } else if (event.key === 'e') {
    onToggleOverlay('enemyPlans')
  } else if (event.key === 'Escape') {
    if (forkArmed.value) cancelFork()
    else if (game.pendingCommand !== 'none') game.clearPendingCommand()
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
  refreshMaps()
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
  dragCleanup?.()
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
      @toggle-pause="onPlayControl"
      @step="game.stepOnce(); refresh()"
      @turn="onTurn"
      @undo="onUndo"
      @redo="onRedo"
      @replay="onReplay"
      @fork="onFork"
      @set-speed="onSetSpeed"
      @toggle-overlay="onToggleOverlay"
      @toggle-sound="onToggleSound"
      @reset="onReset"
      @open-maps="openMaps"
      @toggle-editor="onToggleEditor"
      @toggle-hud="onToggleHud"
      @toggle-auto-preserve="onToggleAutoPreserve"
      @toggle-capture-advance="onToggleCaptureAdvance"
      @toggle-chess-kills="onToggleChessKills"
      @toggle-promotion="onTogglePromotion"
    />

    <div
      class="turnbar"
      :class="{ active: snapshot.turnActive, replay: snapshot.replaying, playing: snapshot.playing }"
      :title="
        snapshot.playing
          ? 'playing — space to pause (makes a mega turn)'
          : snapshot.turnActive
            ? 'turn in progress (space)'
            : snapshot.historyIndex < snapshot.turns.length - 1
              ? 'viewing an earlier turn — space replays forward, f discards the future turns'
              : 'press space for a turn, shift+space to play, u/r to undo/redo, y to replay'
      "
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
          <EditorPanel
            v-if="snapshot.editorMode"
            docked
            :map-name="mapName"
            :size="snapshot.boardSize"
            :brush="snapshot.editorBrush"
            :dirty="snapshot.editorDirty"
            @update:map-name="mapName = $event"
            @save="onSaveMap"
            @done="onDoneEditor"
            @cancel="onCancelEditor"
            @new-map="onNewMap"
            @open-maps="openMaps"
            @toggle-erase="onToggleErase"
          />
          <template v-else>
            <div class="rail-tabs">
              <button
                type="button"
                class="rail-tab"
                :class="{ active: leftTab === 'games' }"
                @click="leftTab = 'games'"
              >
                games
              </button>
              <button
                type="button"
                class="rail-tab"
                :class="{ active: leftTab === 'turns' }"
                @click="leftTab = 'turns'"
              >
                turns
              </button>
            </div>

            <div v-show="leftTab === 'games'" class="rail-tab-body">
              <div class="rail-title">debug</div>
              <button class="ctl copy-btn" @click="copyLlm">
                {{ copied === 'llm' ? 'Copied!' : 'Copy history for LLM' }}
              </button>
              <button class="ctl copy-btn" @click="copySnapshot">
                {{ copied === 'snapshot' ? 'Copied!' : 'Copy snapshot for LLM' }}
              </button>
              <button class="ctl copy-btn" @click="copyJson">
                {{ copied === 'json' ? 'Copied!' : 'Copy state (JSON)' }}
              </button>
              <div class="rail-title">save</div>
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
              <div class="rail-title">load</div>
              <ul v-if="slots.length" class="slots">
                <li v-for="slot in slots" :key="slot.id">
                  <span class="slot-name" :title="new Date(slot.savedAt).toLocaleString()">
                    {{ slot.name }}<template v-if="slot.turns"> · {{ slot.turns }} turns</template>
                  </span>
                  <button class="ctl small" @click="onLoadSlot(slot.id)">Load</button>
                  <button class="ctl small" @click="onDeleteSlot(slot.id)">Del</button>
                </li>
              </ul>
              <div class="rail-title">export</div>
              <div class="io-row">
                <button class="ctl" @click="onExport">Export JSON</button>
                <button class="ctl" @click="onImportClick">Import JSON</button>
              </div>
              <input
                ref="fileInput"
                id="position-file"
                class="hidden-file"
                type="file"
                accept="application/json,.json"
                @change="onImportFile"
              />
              <p v-if="ioMessage" class="io-msg">{{ ioMessage }}</p>
            </div>

            <div v-show="leftTab === 'turns'" class="rail-tab-body">
              <TurnList
                :snapshot="snapshot"
                :fork-armed="forkArmed"
                @jump="onJumpTurn"
                @play="onPlayTurn"
                @fork="onFork"
                @cancel-fork="cancelFork"
              />
            </div>
          </template>
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
        @grab="onGrab('red', $event)"
      />

      <div class="center">
        <div class="board-area">
          <BoardView
            ref="boardView"
            :game="game"
            :pending="snapshot.pendingCommand"
            :editor="snapshot.editorMode"
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
        @grab="onGrab('blue', $event)"
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
          <div class="rail-tabs">
            <button
              type="button"
              class="rail-tab"
              :class="{ active: rightTab === 'piece' }"
              @click="rightTab = 'piece'"
            >
              piece
            </button>
            <button
              type="button"
              class="rail-tab"
              :class="{ active: rightTab === 'info' }"
              @click="rightTab = 'info'"
            >
              info
            </button>
          </div>

          <div v-show="rightTab === 'piece'" class="rail-tab-body">
            <PiecePanel
              :snapshot="snapshot"
              @set-stance="onSetPieceStance"
              @clear-orders="onClearOrders"
            />

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
          </div>

          <div v-show="rightTab === 'info'" class="rail-tab-body">
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
                <li><b>space</b> next turn / replay forward · <b>shift+space</b> play · <b>s</b> step</li>
                <li><b>u</b> undo · <b>r</b> redo · <b>y</b> replay · <b>f</b> discard future turns</li>
                <li><b>c</b>/<b>Backspace</b> clear orders · <b>o</b> my orders · <b>e</b> enemy</li>
                <li><b>h</b> HUD · <b>tab</b> panels · <b>esc</b> cancel</li>
              </ul>
            </CollapsibleSection>

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
          </div>
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

    <div
      v-if="drag"
      class="drag-ghost"
      :style="{ left: drag.x + 'px', top: drag.y + 'px', color: drag.color }"
    >
      {{ drag.glyph }}
    </div>

    <MapsModal
      v-if="mapsOpen"
      :maps="maps"
      :current-id="editingMapId"
      @close="closeMaps"
      @play="onPlayMap"
      @edit="onEditMap"
      @rename="onRenameMap"
      @delete="onDeleteMap"
      @export="onExportMap"
      @import="onImportMapClick"
      @new-map="onNewMap"
    />

    <input
      ref="mapFileInput"
      id="map-file"
      class="hidden-file"
      type="file"
      accept="application/json,.json"
      @change="onImportMapFile"
    />

    <p v-if="mapMessage" class="map-toast">{{ mapMessage }}</p>
  </div>
</template>
