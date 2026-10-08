<script setup lang="ts">
/**
 * The window, arranged the way Photoshop arranges it: a menu bar, the options bar for the current
 * tool, the tool rail down the left, the document with its tab, the panels on the right, and the
 * status bar along the bottom.
 *
 * Keyboard handling lives here rather than in the canvas so a shortcut works wherever focus is —
 * except while a text field has it, which is what Photoshop does too.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import CanvasStage from './components/CanvasStage.vue'
import LayersPanel from './components/LayersPanel.vue'
import NewCanvasSheet from './components/NewCanvasSheet.vue'
import DimensionSheet from './components/DimensionSheet.vue'
import CommandPalette, { type Command } from './components/CommandPalette.vue'
import EffectsSheet from './components/EffectsSheet.vue'
import SelectionAmountSheet from './components/SelectionAmountSheet.vue'
import OptionsBar from './components/OptionsBar.vue'
import PropertiesPanel from './components/PropertiesPanel.vue'
import StatusBar from './components/StatusBar.vue'
import ToolRail from './components/ToolRail.vue'
import { ADJUSTMENT_KINDS, adjustmentKindKey } from './model/adjustments'
import { SHORTCUT_CYCLES } from './model/tools'
import {
  addAdjustment,
  addBlankLayer,
  addFolder,
  cycleTool,
  deleteSelected,
  deselect,
  duplicateSelected,
  exportPNG,
  fillLayer,
  fit,
  groupSelected,
  importImages,
  cancelCrop,
  chooseLocale,
  copyMerged,
  editLayerMask,
  exportJPEG,
  flipCanvas,
  installLanguagePack,
  openEffectsSheet,
  invertSelection,
  loadLanguagePacks,
  moveActive,
  newCanvasPrompt,
  openProject,
  loadLayerSelection,
  loadMaskSelection,
  mergeDown,
  mergeLayers,
  nudgeActive,
  openDimensionPrompt,
  openLanguageFolder,
  applyCrop,
  promptSelectionAmount,
  redo,
  reloadLanguagePacks,
  saveProject,
  selectAll,
  undo,
  ungroupSelected,
  useSession,
  trimTransparent,
  zoomBy,
  zoomTo,
} from './state/session'

const { t, locale } = useI18n()
const {
  manifest,
  foreground,
  background,
  dirty,
  busy,
  selection,
  selectedIds,
  activeLayer,
  mergeTitle,
  canMergeDown,
  cropRect,
  locales,
  paletteOpen,
  showsRulers,
  showsGrid,
  gridSpacing,
  gridSubdivisions,
  setGrid,
} = useSession()

interface MenuItem {
  label?: string
  shortcut?: string
  run?: () => void
  enabled?: () => boolean
  /** A section title rather than something to click. */
  heading?: boolean
  /** Drawn with a tick when it is the current choice. */
  checked?: () => boolean
}

interface Menu {
  label: string
  items: MenuItem[]
}

const openMenu = ref<number | null>(null)

/**
 * The menu, rebuilt whenever the language changes.
 *
 * A constant array would freeze whichever language happened to be active when the module was
 * first evaluated, which is why this is a computed rather than a plain literal.
 */
const menus = computed<Menu[]>(() => [
  {
    label: t('menu.file'),
    items: [
      { label: t('menu.newProject'), shortcut: 'Ctrl+N', run: () => (newCanvasPrompt.open = true) },
      { label: t('menu.open'), shortcut: 'Ctrl+O', run: () => void openProject() },
      { label: t('menu.importImages'), run: () => void importImages() },
      { label: '' },
      {
        label: t('menu.save'),
        shortcut: 'Ctrl+S',
        run: () => void saveProject(),
        enabled: () => dirty.value,
      },
      { label: t('menu.exportPng'), shortcut: 'Ctrl+E', run: () => void exportPNG() },
      { label: t('menu.exportJpeg'), run: () => void exportJPEG() },
    ],
  },
  {
    label: t('menu.edit'),
    items: [
      { label: t('menu.undo'), shortcut: 'Ctrl+Z', run: undo },
      { label: t('menu.redo'), shortcut: 'Ctrl+Shift+Z', run: redo },
      { label: '' },
      { label: t('menu.fillForeground'), run: () => fillLayer({ ...foreground }) },
      { label: t('menu.fillBackground'), run: () => fillLayer({ ...background }) },
      { label: t('menu.clear'), shortcut: 'Delete', run: () => fillLayer(null) },
      { label: '' },
      { label: t('menu.copyMerged'), shortcut: 'Ctrl+Shift+C', run: () => void copyMerged(), enabled: () => manifest.value !== null },
      { label: '' },
      { label: t('language.title'), heading: true },
      ...locales.value.map((entry) => ({
        label: entry.builtIn ? entry.name : `${entry.name} · ${t('language.installedBadge')}`,
        checked: () => locale.value === entry.code,
        run: () => chooseLocale(entry.code),
      })),
      { label: '' },
      { label: t('language.install'), run: () => void installLanguagePack() },
      {
        label: t('language.openFolder'),
        run: () => void openLanguageFolder(),
        enabled: () => inTauri(),
      },
      { label: t('language.reload'), run: () => void reloadLanguagePacks() },
    ],
  },
  {
    label: t('menu.image'),
    items: [
      { label: t('menu.canvasSize'), run: () => openDimensionPrompt('canvas'), enabled: () => manifest.value !== null },
      { label: t('menu.imageSize'), run: () => openDimensionPrompt('image'), enabled: () => manifest.value !== null },
      { label: t('menu.trim'), run: () => trimTransparent(), enabled: () => manifest.value !== null },
      { label: '' },
      { label: t('menu.flipCanvasH'), run: () => flipCanvas(true), enabled: () => manifest.value !== null },
      { label: t('menu.flipCanvasV'), run: () => flipCanvas(false), enabled: () => manifest.value !== null },
    ],
  },
  {
    label: t('menu.layer'),
    items: [
      { label: t('menu.newLayer'), shortcut: 'Ctrl+Shift+N', run: addBlankLayer },
      { label: t('adjust.title'), heading: true },
      ...ADJUSTMENT_KINDS.map((kind) => ({
        label: t(adjustmentKindKey(kind)),
        run: () => addAdjustment(kind),
      })),
      { label: '' },
      { label: t('menu.adjustmentHeading'), heading: true },
      { label: t('menu.newGroup'), run: addFolder },
      { label: t('menu.duplicateLayer'), shortcut: 'Ctrl+J', run: duplicateSelected },
      { label: '' },
      { label: t('menu.groupLayers'), shortcut: 'Ctrl+G', run: groupSelected },
      { label: t('menu.ungroupLayers'), shortcut: 'Ctrl+Shift+G', run: ungroupSelected },
      { label: '' },
      { label: t('menu.bringForward'), shortcut: 'Ctrl+]', run: () => moveActive(1) },
      { label: t('menu.sendBackward'), shortcut: 'Ctrl+[', run: () => moveActive(-1) },
      { label: '' },
      { label: '' },
      { label: mergeTitle.value, shortcut: 'Ctrl+E', run: () => (targetIdsCount() > 1 ? mergeLayers() : mergeDown()), enabled: () => canMergeDown.value || targetIdsCount() > 1 },
      { label: '' },
      { label: t('menu.invertMask'), run: () => editLayerMask('invert'), enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: t('menu.blurMask'), run: () => editLayerMask('blur', 10), enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: t('menu.featherMask'), run: () => editLayerMask('feather', 20), enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: '' },
      { label: '' },
      { label: t('menu.layerEffects') + '…', run: openEffectsSheet, enabled: () => activeLayer.value !== undefined },
      { label: '' },
      { label: t('menu.deleteLayer'), run: deleteSelected },
    ],
  },
  {
    label: t('menu.select'),
    items: [
      { label: t('menu.selectAll'), shortcut: 'Ctrl+A', run: selectAll },
      { label: t('menu.deselect'), shortcut: 'Ctrl+D', run: deselect },
      { label: t('menu.inverse'), shortcut: 'Ctrl+Shift+I', run: invertSelection },
      { label: '' },
      { label: t('select.loadPixels'), run: loadLayerSelection, enabled: () => activeLayer.value?.imageFile !== undefined },
      { label: t('select.loadMask'), run: loadMaskSelection, enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: '' },
      { label: t('select.feather') + '…', run: () => promptSelectionAmount('feather'), enabled: () => selection.value !== null },
      { label: t('select.expand') + '…', run: () => promptSelectionAmount('expand'), enabled: () => selection.value !== null },
      { label: t('select.contract') + '…', run: () => promptSelectionAmount('contract'), enabled: () => selection.value !== null },
    ],
  },
  {
    label: t('menu.filter'),
    items: [
      { label: t('menu.gaussianBlur'), enabled: () => false },
      { label: t('menu.addNoise'), enabled: () => false },
      { label: t('menu.cameraRaw'), enabled: () => false },
    ],
  },
  {
    label: t('menu.view'),
    items: [
      { label: t('menu.zoomIn'), shortcut: 'Ctrl++', run: () => zoomBy(1.25) },
      { label: t('menu.zoomOut'), shortcut: 'Ctrl+-', run: () => zoomBy(1 / 1.25) },
      { label: t('menu.commandPalette'), shortcut: 'F', run: () => (paletteOpen.value = true) },
      { label: '' },
      { label: t('menu.fitOnScreen'), shortcut: 'Ctrl+0', run: fit },
      { label: t('menu.actualPixels'), shortcut: 'Ctrl+1', run: () => zoomTo(1) },
      { label: '' },
      { label: t('menu.rulers'), run: () => (showsRulers.value = !showsRulers.value) },
      { label: t('menu.grid'), run: () => (showsGrid.value = !showsGrid.value) },
      { label: t('menu.gridLarger'), run: () => setGrid({ spacing: gridSpacing.value * 2 }) },
      { label: t('menu.gridSmaller'), run: () => setGrid({ spacing: Math.max(4, gridSpacing.value / 2) }) },
      { label: t('menu.gridSubdivide'), run: () => setGrid({ subdivisions: gridSubdivisions.value === 4 ? 2 : 4 }) },
    ],
  },
  {
    label: t('menu.help'),
    items: [{ label: t('menu.about'), enabled: () => false }],
  },
])

/**
 * The menu flattened into the palette's list.
 *
 * Built from `menus` rather than kept beside it, so a command added to the menu is in the palette
 * without anyone remembering to add it twice.
 */
const commands = computed<Command[]>(() =>
  menus.value.flatMap((menu) =>
    menu.items
      .filter((item) => item.label && !item.heading && item.run)
      .map((item) => ({
        group: menu.label,
        label: item.label as string,
        shortcut: item.shortcut,
        run: item.run as () => void,
      })),
  ),
)

/** Whether the shell can reach the filesystem, which decides if a folder can be opened. */
/** How many layers an operation would apply to, which decides what the merge item says. */
function targetIdsCount(): number {
  return Math.max(1, selectedIds.value.length)
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}


function toggleMenu(index: number): void {
  openMenu.value = openMenu.value === index ? null : index
}

function hoverMenu(index: number): void {
  if (openMenu.value !== null) openMenu.value = index
}

function runItem(item: MenuItem): void {
  openMenu.value = null
  if (item.enabled && !item.enabled()) return
  item.run?.()
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function onKeyDown(event: KeyboardEvent): void {
  if (isTextEntry(event.target)) return
  if (openMenu.value !== null && event.key === 'Escape') {
    openMenu.value = null
    return
  }

  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase()
    const shift = event.shiftKey
    const run = (work: () => void) => {
      event.preventDefault()
      work()
    }
    if (key === 'z') return run(shift ? redo : undo)
    if (key === 's') return run(() => void saveProject())
    if (key === 'o') return run(() => void openProject())
    if (key === 'e') return run(() => void exportPNG())
    if (key === 'a') return run(selectAll)
    if (key === 'd') return run(deselect)
    if (key === 'i' && shift) return run(invertSelection)
    if (key === 'g') return run(shift ? ungroupSelected : groupSelected)
    if (key === 'j') return run(duplicateSelected)
    if (key === 'n' && shift) return run(addBlankLayer)
    if (key === '0') return run(fit)
    if (key === '1') return run(() => zoomTo(1))
    if (key === 'e') return run(() => void exportPNG())
    if (key === 'c' && shift) return run(() => void copyMerged())
    if (key === ']') return run(() => moveActive(1))
    if (key === '[') return run(() => moveActive(-1))
    if (key === '=' || key === '+') return run(() => zoomBy(1.25))
    if (key === '-') return run(() => zoomBy(1 / 1.25))
    return
  }

  if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    paletteOpen.value = true
    return
  }
  const upper = event.key.toUpperCase()
  if (SHORTCUT_CYCLES[upper]) {
    event.preventDefault()
    cycleTool(upper)
    return
  }
  // The arrow keys nudge the active layer by a pixel, or by ten with Shift, as Photoshop's do.
  if (event.key.startsWith('Arrow')) {
    const step = event.shiftKey ? 10 : 1
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (dx !== 0 || dy !== 0) {
      event.preventDefault()
      nudgeActive(dx, dy)
      return
    }
  }
  if (event.key === 'Enter' && cropRect.value) {
    event.preventDefault()
    return applyCrop()
  }
  if (event.key === 'Escape' && cropRect.value) {
    event.preventDefault()
    return cancelCrop()
  }
  switch (event.key) {
    case 'Delete':
    case 'Backspace':
      event.preventDefault()
      fillLayer(null)
      break
    case ']':
      event.preventDefault()
      moveActive(1)
      break
    case '[':
      event.preventDefault()
      moveActive(-1)
      break
    default:
      break
  }
}

const documentName = computed(() => {
  const path = useSession().project.value?.path
  if (!path) return manifest.value ? 'Untitled.comp' : t('status.noDocument')
  return path.split(/[\\/]/).pop() ?? 'Untitled.comp'
})

onMounted(() => {
  void loadLanguagePacks()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('click', () => (openMenu.value = null), { capture: false })
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="window">
    <nav class="menubar">
      <span class="menubar__brand">Compositor</span>
      <div
        v-for="(menu, index) in menus"
        :key="menu.label"
        class="menubar__item"
        :class="{ 'menubar__item--open': openMenu === index }"
      >
        <button class="menubar__button" @click.stop="toggleMenu(index)" @mouseenter="hoverMenu(index)">
          {{ menu.label }}
        </button>
        <div v-if="openMenu === index" class="menu" @click.stop>
          <template v-for="(item, itemIndex) in menu.items" :key="itemIndex">
            <div v-if="!item.label" class="menu__sep" />
            <div v-else-if="item.heading" class="menu__heading">{{ item.label }}</div>
            <button
              v-else
              class="menu__item"
              :class="{
                'menu__item--off': item.enabled && !item.enabled(),
                'menu__item--checked': item.checked && item.checked(),
              }"
              @click="runItem(item)"
            >
              <span class="menu__tick">{{ item.checked && item.checked() ? '✓' : '' }}</span>
              <span class="menu__label">{{ item.label }}</span>
              <span v-if="item.shortcut" class="menu__shortcut">{{ item.shortcut }}</span>
            </button>
          </template>
        </div>
      </div>
      <span class="menubar__spacer" />
      <span v-if="busy" class="menubar__busy">{{ t('common.working') }}</span>
    </nav>

    <OptionsBar />

    <div class="body">
      <ToolRail />

      <main class="doc">
        <div class="doc__tabs">
          <div class="tab" :class="{ 'tab--on': true }">
            <span class="tab__icon">▣</span>
            <span class="tab__name">{{ documentName }}</span>
            <span v-if="dirty" class="tab__dot" :title="t('tab.unsaved')">•</span>
          </div>
          <button class="tab__new" :title="t('tab.newCanvas')" @click="newCanvasPrompt.open = true">+</button>
        </div>
        <CanvasStage />
      </main>

      <aside class="panels">
        <div class="panels__main">
          <LayersPanel />
        </div>
        <PropertiesPanel />
      </aside>
    </div>

    <StatusBar />
    <NewCanvasSheet />
    <SelectionAmountSheet />
    <DimensionSheet />
    <EffectsSheet />
    <CommandPalette :commands="commands" />
  </div>
</template>

<style scoped>
.window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--ps-frame);
}

/* Menu bar */
.menubar {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 6px;
  background: var(--ps-frame);
  border-bottom: 1px solid var(--ps-line-hard);
  font-size: 11px;
}

.menubar__brand {
  padding-right: 10px;
  color: var(--ps-text-faint);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.menubar__item {
  position: relative;
}

.menubar__button {
  padding: 2px 8px;
  border: 0;
  border-radius: 2px;
  background: none;
  color: var(--ps-text);
  font: inherit;
  cursor: pointer;
}

.menubar__item--open .menubar__button,
.menubar__button:hover {
  background: var(--ps-control);
}

.menubar__spacer {
  flex: 1;
}

.menubar__busy {
  color: var(--ps-text-dim);
}

.menu {
  position: absolute;
  left: 0;
  top: 22px;
  z-index: 50;
  min-width: 216px;
  padding: 3px;
  border: 1px solid var(--ps-line);
  background: var(--ps-panel);
  box-shadow: 0 8px 22px rgb(0 0 0 / 50%);
}

.menu__heading {
  padding: 5px 8px 2px;
  color: var(--ps-text-faint);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.menu__tick {
  width: 12px;
  color: #cfe4fb;
}

.menu__label {
  flex: 1;
}

.menu__item--checked {
  color: var(--ps-text-strong);
}

.menu__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 8px;
  border: 0;
  background: none;
  color: var(--ps-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__item:hover {
  background: var(--ps-accent-dim);
  color: #ffffff;
}

.menu__item--off {
  color: var(--ps-text-faint);
}

.menu__item--off:hover {
  background: none;
  color: var(--ps-text-faint);
}

.menu__shortcut {
  color: var(--ps-text-faint);
}

.menu__item:hover .menu__shortcut {
  color: #dbe8f6;
}

.menu__sep {
  height: 1px;
  margin: 3px 4px;
  background: var(--ps-line);
}

/* Body */
.body {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 292px;
  flex: 1;
  min-height: 0;
}

.doc {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ps-frame-dark);
}

.doc__tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 26px;
  padding: 3px 4px 0;
  background: var(--ps-frame-dark);
}

.tab {
  display: flex;
  gap: 6px;
  align-items: center;
  max-width: 240px;
  padding: 3px 10px;
  border-radius: 3px 3px 0 0;
  background: var(--ps-panel);
  color: var(--ps-text);
}

.tab--on {
  color: var(--ps-text-strong);
}

.tab__icon {
  color: #9aa0a8;
  font-size: 10px;
}

.tab__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tab__dot {
  color: #e0b060;
}

.tab__new {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--ps-text-dim);
  cursor: pointer;
}

.tab__new:hover {
  background: var(--ps-control);
  color: var(--ps-text-strong);
}

.panels {
  display: grid;
  grid-template-rows: minmax(140px, 1fr) auto;
  min-height: 0;
  border-left: 1px solid var(--ps-line-hard);
}

.panels__main {
  min-height: 0;
}
</style>
