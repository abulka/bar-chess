<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import BoardView from './components/BoardView.vue'
import EventLog from './components/EventLog.vue'
import ReinforcementBar from './components/ReinforcementBar.vue'
import StatsBar from './components/StatsBar.vue'
import Toolbar from './components/Toolbar.vue'
import type { BoardSize } from './game/boards'
import { SNAPSHOT_INTERVAL_MS } from './game/constants'
import { Game } from './game/game'
import type { GameMode, GameSnapshot, OverlayFlags } from './game/game'
import { loadSettings, saveSettings } from './game/settings'
import { deleteSlot, listSlots, loadSlot, saveSlot } from './game/storage'
import type { SlotMeta } from './game/storage'
import type { StanceMode, TeamId } from './game/types'

const game = new Game(8)
game.applySettings(loadSettings() ?? {})
const snapshot = shallowRef<GameSnapshot>(game.snapshot())
const stance = ref<StanceMode>(game.orderMode)
const copied = ref('')
const boardView = ref<InstanceType<typeof BoardView> | null>(null)
const slots = ref<SlotMeta[]>([])
const slotName = ref('')
const ioMessage = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

let timer = 0

function refresh(): void {
  snapshot.value = game.snapshot()
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
  boardView.value?.fit()
  refresh()
}

function onSetGameMode(mode: GameMode): void {
  game.setGameMode(mode)
  persistSettings()
  refresh()
}

function onSetStance(mode: StanceMode): void {
  stance.value = mode
  game.setOrderMode(mode)
  persistSettings()
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

function onToggleHud(): void {
  game.hudVisible = !game.hudVisible
  persistSettings()
  refresh()
  nextTick(() => boardView.value?.fit())
}

function onReset(): void {
  game.reset()
  boardView.value?.fit()
  refresh()
}

function onTurn(): void {
  // Ignore during an active turn/replay so space always starts the next turn
  // rather than cancelling the current one.
  if (game.turnActive || snapshot.value.replaying) return
  game.beginTurn()
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
  else if (event.key === 'p') {
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
    game.clearSelection()
    refresh()
  } else if (event.key === '1' || event.key === 'm') onSetStance('move')
  else if (event.key === '2' || event.key === 'a') onSetStance('attack')
}

onMounted(() => {
  game.start()
  refreshSlots()
  timer = window.setInterval(refresh, SNAPSHOT_INTERVAL_MS)
  window.addEventListener('keydown', onKey)
  if (import.meta.env.DEV) {
    ;(window as unknown as { game: Game }).game = game
  }
})

onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.removeEventListener('keydown', onKey)
  game.stop()
})
</script>

<template>
  <div class="app" :class="{ 'hud-hidden': !snapshot.hudVisible }">
    <Toolbar
      :snapshot="snapshot"
      :stance="stance"
      @select-size="onSelectSize"
      @set-game-mode="onSetGameMode"
      @toggle-pause="game.togglePause(); refresh()"
      @step="game.stepOnce(); refresh()"
      @turn="onTurn"
      @undo="onUndo"
      @redo="onRedo"
      @replay="onReplay"
      @set-speed="onSetSpeed"
      @set-stance="onSetStance"
      @toggle-overlay="onToggleOverlay"
      @reset="onReset"
      @toggle-hud="onToggleHud"
    />

    <div
      class="turnbar"
      :class="{ active: snapshot.turnActive, replay: snapshot.replaying }"
      :title="snapshot.turnActive ? 'turn in progress (space)' : 'press space for a turn, u/r to undo/redo, y to replay'"
    >
      <div
        class="turnbar-fill"
        :style="{ width: (snapshot.turnActive ? snapshot.turnProgress : snapshot.replaying ? snapshot.replayProgress : 0) * 100 + '%' }"
      ></div>
      <span class="turnbar-label">
        {{
          snapshot.turnActive
            ? 'TURN'
            : snapshot.replaying
              ? 'REPLAY'
              : snapshot.canReplay
                ? 'READY — space for next turn'
                : 'press space for a turn'
        }}
      </span>
    </div>

    <div class="stage" :class="{ 'no-rosters': !snapshot.hudVisible }">
      <aside class="rail left">
        <div class="rail-title">controls</div>
        <ul class="hints">
          <li><b>drag</b> select box · <b>shift-click</b> add</li>
          <li><b>shift-drag</b>/middle pan · <b>wheel</b> zoom</li>
          <li><b>right-click</b> empty → move</li>
          <li><b>right-click</b> again → queue next move</li>
          <li><b>right-click</b> enemy → attack (Attack stance)</li>
          <li><b>1</b>/<b>m</b> Move · <b>2</b>/<b>a</b> Attack stance</li>
          <li><b>space</b> turn · <b>p</b> pause · <b>s</b> step</li>
          <li><b>u</b> undo · <b>r</b> redo · <b>y</b> replay · <b>c</b>/<b>Backspace</b> clear orders</li>
          <li><b>o</b> my orders · <b>e</b> enemy · <b>h</b> HUD</li>
        </ul>
      </aside>

      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.red"
        side="left"
        @deploy="onDeploy('red', $event)"
      />

      <div class="center">
        <div class="board-area">
          <BoardView ref="boardView" :game="game" @changed="refresh" @ordered="onOrdered" />
        </div>
      </div>

      <ReinforcementBar
        v-if="snapshot.hudVisible"
        :team="snapshot.teams.blue"
        side="right"
        @deploy="onDeploy('blue', $event)"
      />

      <aside class="rail right">
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
          <li><span class="sw sw-bar"></span> health · <span class="sw sw-reload"></span> reload (red)</li>
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

    <div v-if="snapshot.hudVisible" class="bottom">
      <StatsBar :snapshot="snapshot" />
      <EventLog :snapshot="snapshot" />
    </div>
  </div>
</template>
