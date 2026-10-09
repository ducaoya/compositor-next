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
import DocumentTabs from './components/DocumentTabs.vue'
import CommandPalette, { type Command } from './components/CommandPalette.vue'
import ShortcutSheet from './components/ShortcutSheet.vue'
import EffectsSheet from './components/EffectsSheet.vue'
import FilterSheet from './components/FilterSheet.vue'
import SelectionAmountSheet from './components/SelectionAmountSheet.vue'
import OptionsBar from './components/OptionsBar.vue'
import RecoverySheet from './components/RecoverySheet.vue'
import PropertiesPanel from './components/PropertiesPanel.vue'
import StatusBar from './components/StatusBar.vue'
import ToolRail from './components/ToolRail.vue'
import { ADJUSTMENT_KINDS, adjustmentKindKey } from './model/adjustments'
import { commandForEvent, type CommandId } from './model/keymap'
import { TOOLS } from './model/tools'
import { keymap, recordingCommand, shortcutFor, shortcutSheetOpen } from './state/keymap'
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
  contentAwareFill,
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
  openFilterSheet,
  checkForUpdates,
  checkForRecovery,
  installUpdate,
  listenForProjectOpen,
  openStartupProject,
  startAutosave,
  stopAutosave,
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
  runThumbnailJob,
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
  updateAvailable,
  updatePercent,
  updatePhase,
} = useSession()

interface MenuItem {
  label?: string
  /** The command this item runs, when it is one a key can be bound to. */
  command?: CommandId
  /** The chord to print beside it, read from the keyboard map rather than typed here. */
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
 * Every command, by id: what it runs and whether it can run now.
 *
 * Built from the menus rather than kept beside them — a table of its own would be a second place to
 * forget a command exists — plus one entry per tool, which the menus have no item for because the
 * rail is where a tool is chosen.
 */
const itemsByCommand = computed(() => {
  const items = new Map<CommandId, MenuItem>()
  for (const menu of menus.value) {
    for (const item of menu.items) {
      if (item.command) items.set(item.command, item)
    }
  }
  for (const tool of TOOLS) {
    if (!tool.implemented) continue
    const id: CommandId = `tool.${tool.id}`
    // Cycling rather than selecting: pressing `R` three times walks the three tools that share it,
    // which is what a group of tools on one key is for.
    items.set(id, { run: () => cycleTool(shortcutFor(id)) })
  }
  return items
})

/**
 * Whether a filter can run: it needs a layer that has pixels to work on.
 *
 * A folder and an adjustment layer hold none, and a filter over a mask would be a filter over
 * coverage rather than colour, which is the mask menu's business.
 */
const canFilter = (): boolean => activeLayer.value?.imageFile !== undefined

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
      { label: t('menu.newProject'), command: 'file.new', shortcut: shortcutFor('file.new'), run: () => (newCanvasPrompt.open = true) },
      { label: t('menu.open'), command: 'file.open', shortcut: shortcutFor('file.open'), run: () => void openProject() },
      { label: t('menu.importImages'), command: 'file.import', run: () => void importImages() },
      { label: '' },
      {
        label: t('menu.save'),
        command: 'file.save',
        shortcut: shortcutFor('file.save'),
        run: () => void saveProject(),
        enabled: () => dirty.value,
      },
      { label: t('menu.exportPng'), command: 'file.exportPng', shortcut: shortcutFor('file.exportPng'), run: () => void exportPNG() },
      { label: t('menu.exportJpeg'), command: 'file.exportJpeg', run: () => void exportJPEG() },
    ],
  },
  {
    label: t('menu.edit'),
    items: [
      { label: t('menu.undo'), command: 'edit.undo', shortcut: shortcutFor('edit.undo'), run: undo },
      { label: t('menu.redo'), command: 'edit.redo', shortcut: shortcutFor('edit.redo'), run: redo },
      { label: '' },
      { label: t('menu.fillForeground'), command: 'edit.fillForeground', run: () => fillLayer({ ...foreground }) },
      { label: t('menu.fillBackground'), command: 'edit.fillBackground', run: () => fillLayer({ ...background }) },
      { label: t('menu.clear'), command: 'edit.clear', shortcut: shortcutFor('edit.clear'), run: () => fillLayer(null) },
      { label: '' },
      {
        label: t('menu.contentAwareFill'),
        command: 'edit.contentAwareFill',
        run: contentAwareFill,
        enabled: () => selection.value !== null && activeLayer.value?.imageFile !== undefined,
      },
      { label: '' },
      { label: t('menu.copyMerged'), command: 'edit.copyMerged', shortcut: shortcutFor('edit.copyMerged'), run: () => void copyMerged(), enabled: () => manifest.value !== null },
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
      { label: '' },
      { label: t('menu.keyboardShortcuts'), run: () => (shortcutSheetOpen.value = true) },
    ],
  },
  {
    label: t('menu.image'),
    items: [
      { label: t('menu.canvasSize'), command: 'image.canvasSize', run: () => openDimensionPrompt('canvas'), enabled: () => manifest.value !== null },
      { label: t('menu.imageSize'), command: 'image.imageSize', run: () => openDimensionPrompt('image'), enabled: () => manifest.value !== null },
      { label: t('menu.trim'), command: 'image.trim', run: () => trimTransparent(), enabled: () => manifest.value !== null },
      { label: '' },
      { label: t('menu.flipCanvasH'), command: 'image.flipHorizontal', run: () => flipCanvas(true), enabled: () => manifest.value !== null },
      { label: t('menu.flipCanvasV'), command: 'image.flipVertical', run: () => flipCanvas(false), enabled: () => manifest.value !== null },
    ],
  },
  {
    label: t('menu.layer'),
    items: [
      { label: t('menu.newLayer'), command: 'layer.new', shortcut: shortcutFor('layer.new'), run: addBlankLayer },
      { label: t('adjust.title'), heading: true },
      ...ADJUSTMENT_KINDS.map((kind) => ({
        label: t(adjustmentKindKey(kind)),
        run: () => addAdjustment(kind),
      })),
      { label: '' },
      { label: t('menu.adjustmentHeading'), heading: true },
      { label: t('menu.newGroup'), command: 'layer.newGroup', run: addFolder },
      { label: t('menu.duplicateLayer'), command: 'layer.duplicate', shortcut: shortcutFor('layer.duplicate'), run: duplicateSelected },
      { label: '' },
      { label: t('menu.groupLayers'), command: 'layer.group', shortcut: shortcutFor('layer.group'), run: groupSelected },
      { label: t('menu.ungroupLayers'), command: 'layer.ungroup', shortcut: shortcutFor('layer.ungroup'), run: ungroupSelected },
      { label: '' },
      { label: t('menu.bringForward'), command: 'layer.bringForward', shortcut: shortcutFor('layer.bringForward'), run: () => moveActive(1) },
      { label: t('menu.sendBackward'), command: 'layer.sendBackward', shortcut: shortcutFor('layer.sendBackward'), run: () => moveActive(-1) },
      { label: '' },
      { label: '' },
      { label: mergeTitle.value, command: 'layer.merge', shortcut: shortcutFor('layer.merge'), run: () => (targetIdsCount() > 1 ? mergeLayers() : mergeDown()), enabled: () => canMergeDown.value || targetIdsCount() > 1 },
      { label: '' },
      { label: t('menu.invertMask'), run: () => editLayerMask('invert'), enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: t('menu.blurMask'), run: () => editLayerMask('blur', 10), enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: t('menu.featherMask'), run: () => editLayerMask('feather', 20), enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: '' },
      { label: '' },
      { label: t('menu.layerEffects') + '…', command: 'layer.effects', run: openEffectsSheet, enabled: () => activeLayer.value !== undefined },
      { label: '' },
      { label: t('menu.deleteLayer'), command: 'layer.delete', run: deleteSelected },
    ],
  },
  {
    label: t('menu.select'),
    items: [
      { label: t('menu.selectAll'), command: 'select.all', shortcut: shortcutFor('select.all'), run: selectAll },
      { label: t('menu.deselect'), command: 'select.deselect', shortcut: shortcutFor('select.deselect'), run: deselect },
      { label: t('menu.inverse'), command: 'select.inverse', shortcut: shortcutFor('select.inverse'), run: invertSelection },
      { label: '' },
      { label: t('select.loadPixels'), command: 'select.fromPixels', run: loadLayerSelection, enabled: () => activeLayer.value?.imageFile !== undefined },
      { label: t('select.loadMask'), command: 'select.fromMask', run: loadMaskSelection, enabled: () => activeLayer.value?.maskFile !== undefined },
      { label: '' },
      { label: t('select.feather') + '…', command: 'select.feather', run: () => promptSelectionAmount('feather'), enabled: () => selection.value !== null },
      { label: t('select.expand') + '…', command: 'select.expand', run: () => promptSelectionAmount('expand'), enabled: () => selection.value !== null },
      { label: t('select.contract') + '…', command: 'select.contract', run: () => promptSelectionAmount('contract'), enabled: () => selection.value !== null },
    ],
  },
  {
    label: t('menu.filter'),
    items: [
      { label: t('menu.gaussianBlur'), command: 'filter.blur', run: () => openFilterSheet('blur'), enabled: canFilter },
      { label: t('menu.addNoise'), command: 'filter.noise', run: () => openFilterSheet('noise'), enabled: canFilter },
      { label: '' },
      { label: t('menu.vignette'), command: 'filter.vignette', run: () => openFilterSheet('vignette'), enabled: canFilter },
      { label: t('menu.bloomGlow'), command: 'filter.glow', run: () => openFilterSheet('glow'), enabled: canFilter },
      { label: t('menu.tonalContrast'), command: 'filter.tonal', run: () => openFilterSheet('tonal'), enabled: canFilter },
      { label: t('menu.lensCorrection'), command: 'filter.lens', run: () => openFilterSheet('lens'), enabled: canFilter },
      { label: t('menu.dither'), command: 'filter.dither', run: () => openFilterSheet('dither'), enabled: canFilter },
      { label: '' },
      // Camera Raw develops a RAW file, which is the importer's job rather than a filter's, and
      // Remove Background needs a model this build does not ship. Both say so rather than offering
      // a dialog that cannot work.
      { label: t('menu.cameraRaw'), enabled: () => false },
      { label: t('menu.removeBackground'), enabled: () => false },
    ],
  },
  {
    label: t('menu.view'),
    items: [
      { label: t('menu.zoomIn'), command: 'view.zoomIn', shortcut: shortcutFor('view.zoomIn'), run: () => zoomBy(1.25) },
      { label: t('menu.zoomOut'), command: 'view.zoomOut', shortcut: shortcutFor('view.zoomOut'), run: () => zoomBy(1 / 1.25) },
      { label: t('menu.commandPalette'), command: 'view.palette', shortcut: shortcutFor('view.palette'), run: () => (paletteOpen.value = true) },
      { label: '' },
      { label: t('menu.fitOnScreen'), command: 'view.fit', shortcut: shortcutFor('view.fit'), run: fit },
      { label: t('menu.actualPixels'), command: 'view.actualPixels', shortcut: shortcutFor('view.actualPixels'), run: () => zoomTo(1) },
      { label: '' },
      { label: t('menu.rulers'), command: 'view.rulers', run: () => (showsRulers.value = !showsRulers.value) },
      { label: t('menu.grid'), command: 'view.grid', run: () => (showsGrid.value = !showsGrid.value) },
      { label: t('menu.gridLarger'), command: 'view.gridLarger', run: () => setGrid({ spacing: gridSpacing.value * 2 }) },
      { label: t('menu.gridSmaller'), command: 'view.gridSmaller', run: () => setGrid({ spacing: Math.max(4, gridSpacing.value / 2) }) },
      { label: t('menu.gridSubdivide'), command: 'view.gridSubdivide', run: () => setGrid({ subdivisions: gridSubdivisions.value === 4 ? 2 : 4 }) },
    ],
  },
  {
    label: t('menu.help'),
    items: [
      { label: t('menu.checkUpdates'), command: 'help.checkUpdates', run: () => void checkForUpdates() },
      {
        label: t('menu.installUpdate'),
        command: 'help.installUpdate',
        run: () => void installUpdate(),
        enabled: () => updateAvailable.value !== null,
      },
      { label: t('menu.about'), enabled: () => false },
    ],
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

/** What an install is doing, for the one line in the menu bar. */
const updateStatus = computed(() => {
  if (updatePhase.value === 'installing') return t('update.installing')
  const percent = updatePercent.value
  return percent === null ? t('update.downloadingUnknown') : t('update.downloading', { percent })
})

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

/**
 * One key press, resolved through the keyboard map.
 *
 * The handler is a lookup now rather than a chain of comparisons: which key means which command is
 * `web/src/model/keymap.ts`'s business, and what a command *does* is the menu's. What is left here
 * is the part no binding can express — the arrows nudging the active layer, Enter applying a crop,
 * Escape cancelling one — and the rule that a modifier combination nobody bound does nothing rather
 * than falling through to whatever the bare key would have done.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (isTextEntry(event.target)) return
  // While a chord is being recorded the sheet is listening for the keys themselves.
  if (recordingCommand.value !== null) return
  if (openMenu.value !== null && event.key === 'Escape') {
    openMenu.value = null
    return
  }

  const command = commandForEvent(keymap.value, event)
  if (command) {
    const item = itemsByCommand.value.get(command)
    if (!item) return
    if (item.enabled && !item.enabled()) return
    event.preventDefault()
    item.run?.()
    return
  }
  // Ctrl+Delete is not Delete. A combination that means nothing here must not be read as the key it
  // happens to be pressed with, which is how a stray Ctrl+Backspace would clear a layer.
  if (event.ctrlKey || event.metaKey || event.altKey) return

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

onMounted(async () => {
  void loadLanguagePacks()
  // A thumbnail run draws one picture and stops; nothing else about a session applies to it.
  if (await runThumbnailJob()) return
  // Work the last run never saved, and the project a double-click named, if there was one. Both
  // ask the shell, so both are no-ops in a browser preview.
  void checkForRecovery()
  void openStartupProject()
  void listenForProjectOpen()
  startAutosave()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('click', () => (openMenu.value = null), { capture: false })
})
onBeforeUnmount(() => {
  stopAutosave()
  window.removeEventListener('keydown', onKeyDown)
})
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
      <span v-if="updatePhase !== 'idle'" class="menubar__busy">{{ updateStatus }}</span>
      <span v-else-if="busy" class="menubar__busy">{{ t('common.working') }}</span>
    </nav>

    <OptionsBar />

    <div class="body">
      <ToolRail />

      <main class="doc">
        <DocumentTabs />
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
    <FilterSheet />
    <RecoverySheet />
    <CommandPalette :commands="commands" />
    <ShortcutSheet />
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
