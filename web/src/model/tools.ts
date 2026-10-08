/**
 * The tool rail, laid out the way Photoshop lays it out: one cell per tool, a flyout triangle on
 * the corner of the cells that have variants, and the colour wells at the bottom.
 *
 * Icons are inline SVG using `currentColor`, so a tool that is unavailable for this build dims with
 * everything else rather than needing a second set of assets.
 */

export type ToolId =
  | 'move'
  | 'marqueeRect'
  | 'marqueeEllipse'
  | 'lasso'
  | 'wand'
  | 'crop'
  | 'eyedropper'
  | 'brush'
  | 'eraser'
  | 'heal'
  | 'clone'
  | 'gradient'
  | 'blur'
  | 'dodge'
  | 'pen'
  | 'type'
  | 'shape'
  | 'hand'
  | 'zoom'

export interface ToolVariant {
  id: ToolId
  /** A `tools.*` translation key. */
  labelKey: string
}

export interface ToolDefinition {
  /** The cell's tool. Long-pressing the cell offers the variants. */
  id: ToolId
  /** A `tools.*` translation key. */
  labelKey: string
  /** The Photoshop shortcut, shown in the tooltip and bound on the keyboard. */
  shortcut: string
  /** SVG markup drawn inside a 24×24 viewBox. */
  icon: string
  variants?: ToolVariant[]
  /** False while this build has no behaviour behind the tool. */
  implemented: boolean
}

export const TOOLS: ToolDefinition[] = [
  {
    id: 'move',
    labelKey: 'tools.move',
    shortcut: 'V',
    implemented: true,
    icon: `
      <path d="M12 2.8v18.4M2.8 12h18.4" />
      <path d="M12 2.8 9.6 5.2M12 2.8l2.4 2.4M12 21.2 9.6 18.8M12 21.2l2.4-2.4
               M2.8 12 5.2 9.6M2.8 12l2.4 2.4M21.2 12l-2.4-2.4M21.2 12l-2.4 2.4" />`,
  },
  {
    id: 'marqueeRect',
    labelKey: 'tools.marqueeRect',
    shortcut: 'M',
    implemented: true,
    variants: [
      { id: 'marqueeRect', labelKey: 'tools.marqueeRect' },
      { id: 'marqueeEllipse', labelKey: 'tools.marqueeEllipse' },
    ],
    icon: `<rect x="3" y="4.5" width="18" height="15" rx="1" stroke-dasharray="3 2.4" />`,
  },
  {
    id: 'marqueeEllipse',
    labelKey: 'tools.marqueeEllipse',
    shortcut: 'M',
    implemented: true,
    icon: `<ellipse cx="12" cy="12" rx="9" ry="7.5" stroke-dasharray="3 2.4" />`,
  },
  {
    id: 'lasso',
    labelKey: 'tools.lasso',
    shortcut: 'L',
    implemented: true,
    icon: `
      <path d="M12 4.5c4.9 0 8.8 2.2 8.8 5s-3.9 5-8.8 5c-1.9 0-3.7-.4-5.1-1.1" />
      <path d="M6.9 13.4C4.8 12.5 3.2 11.1 3.2 9.5c0-2.8 3.9-5 8.8-5" />
      <path d="M6.9 13.4c-.9 1-1.4 2.2-1.4 3.4 0 1.1.4 1.9 1.1 2.3" />`,
  },
  {
    id: 'wand',
    labelKey: 'tools.wand',
    shortcut: 'W',
    implemented: true,
    icon: `
      <path d="M3.5 20.5 13 11" stroke-width="1.8" />
      <path d="M16.5 3v4M20.5 7h-4M18.8 9.6 21 11.8M14.2 9.6 12 11.8" />`,
  },
  {
    id: 'crop',
    labelKey: 'tools.crop',
    shortcut: 'C',
    implemented: true,
    icon: `
      <path d="M7.5 2.5V16a.5.5 0 0 0 .5.5h13.5" />
      <path d="M2.5 7.5H16a.5.5 0 0 1 .5.5v13.5" />`,
  },
  {
    id: 'eyedropper',
    labelKey: 'tools.eyedropper',
    shortcut: 'I',
    implemented: true,
    icon: `
      <path d="M3 21l.9-3.6 8.1-8.1" />
      <path d="M12 9.3 15.2 6a2.9 2.9 0 0 1 4.1 4.1L16 13.3z" />
      <path d="M8.6 11.7l3.7 3.7" />`,
  },
  {
    id: 'brush',
    labelKey: 'tools.brush',
    shortcut: 'B',
    implemented: true,
    variants: [
      { id: 'brush', labelKey: 'tools.brush' },
      { id: 'eraser', labelKey: 'tools.eraser' },
    ],
    icon: `
      <path d="M20.4 3.6c-1.7-1.7-4.4.3-7 2.9L9 11l4 4 4.5-4.4c2.6-2.6 4.6-5.3 2.9-7z" />
      <path d="M9 11 5.2 14.8c-1 1-1.5 2.6-1.6 3.7-.1 1 .4 1.6 1.5 1.5 1.1-.1 2.7-.6 3.7-1.6L12.5 15" />`,
  },
  {
    id: 'eraser',
    labelKey: 'tools.eraser',
    shortcut: 'E',
    implemented: true,
    icon: `
      <path d="M8 20.5h13" />
      <path d="M15.4 4.6 4.6 15.4a1.9 1.9 0 0 0 0 2.7l1.8 1.8h5.4l9.2-9.2a1.9 1.9 0 0 0 0-2.7l-2.9-3a1.9 1.9 0 0 0-2.7 0z" />
      <path d="M9 11l4.5 4.5" />`,
  },
  {
    id: 'heal',
    labelKey: 'tools.heal',
    shortcut: 'J',
    implemented: false,
    icon: `
      <rect x="8.5" y="2.5" width="7" height="19" rx="3.5" transform="rotate(45 12 12)" />
      <path d="M9.4 9.4 14.6 14.6" />`,
  },
  {
    id: 'clone',
    labelKey: 'tools.clone',
    shortcut: 'S',
    implemented: false,
    icon: `
      <path d="M5.5 20.5h13" />
      <path d="M8 17.5h8v-3.2H8z" />
      <path d="M9.6 14.3V9.4h4.8v4.9" />
      <path d="M8 9.4h8V6.8A2.3 2.3 0 0 0 13.7 4.5h-3.4A2.3 2.3 0 0 0 8 6.8z" />`,
  },
  {
    id: 'gradient',
    labelKey: 'tools.gradient',
    shortcut: 'G',
    implemented: true,
    icon: `
      <rect x="3" y="4.5" width="18" height="15" rx="1" />
      <path d="M3.6 18.4h16.8M3.6 16h16.8M3.6 13.8h16.8M3.6 12h16.8M3.6 10.6h16.8M3.6 9.6h16.8" opacity=".65" />`,
  },
  {
    id: 'blur',
    labelKey: 'tools.blur',
    shortcut: 'R',
    implemented: false,
    icon: `<path d="M12 3s6.2 6.6 6.2 10.6a6.2 6.2 0 0 1-12.4 0C5.8 9.6 12 3 12 3z" />`,
  },
  {
    id: 'dodge',
    labelKey: 'tools.dodge',
    shortcut: 'O',
    implemented: false,
    icon: `
      <circle cx="9.2" cy="9.2" r="5.2" />
      <path d="M12.9 12.9 21 21" />`,
  },
  {
    id: 'pen',
    labelKey: 'tools.pen',
    shortcut: 'P',
    implemented: false,
    icon: `
      <path d="M12 3 20 11l-8 10-8-10z" />
      <path d="M12 3v18M4 11h16" opacity=".55" />`,
  },
  {
    id: 'type',
    labelKey: 'tools.type',
    shortcut: 'T',
    implemented: false,
    icon: `<path d="M4.5 5.5h15M12 5.5V19M9 19h6" />`,
  },
  {
    id: 'shape',
    labelKey: 'tools.shape',
    shortcut: 'U',
    implemented: true,
    icon: `
      <rect x="2.5" y="2.5" width="12" height="12" rx="1" />
      <circle cx="15" cy="15" r="6.5" />`,
  },
  {
    id: 'hand',
    labelKey: 'tools.hand',
    shortcut: 'H',
    implemented: true,
    icon: `
      <path d="M8.2 12.4V6.4a1.5 1.5 0 0 1 3 0v4.6" />
      <path d="M11.2 10.6V5.4a1.5 1.5 0 0 1 3 0v5.2" />
      <path d="M14.2 10.6V7a1.5 1.5 0 0 1 3 0v6.4c0 3.7-2.4 6.6-5.5 6.6h-1.3c-1.6 0-3.1-.8-4-2L3.9 15a1.6 1.6 0 0 1 2.5-2l1.8 2" />`,
  },
  {
    id: 'zoom',
    labelKey: 'tools.zoom',
    shortcut: 'Z',
    implemented: true,
    icon: `
      <circle cx="10.5" cy="10.5" r="6.6" />
      <path d="M15.4 15.4 21 21" />`,
  },
]

export const TOOLS_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]))

/** Toolbar tools that share a keyboard shortcut, in the order pressing it cycles them. */
export const SHORTCUT_CYCLES: Record<string, ToolId[]> = TOOLS.reduce<Record<string, ToolId[]>>(
  (cycles, tool) => {
    const key = tool.shortcut
    if (tool.implemented && key) cycles[key] = [...(cycles[key] ?? []), tool.id]
    return cycles
  },
  {},
)

/** Tools that paint with the brush tip, and so read the brush options. */
export const BRUSH_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['brush', 'eraser'])

/** Tools that draw or edit a selection. */
export const SELECTION_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'marqueeRect',
  'marqueeEllipse',
  'lasso',
  'wand',
])

/** The cursor CSS for each tool, as close to Photoshop's shapes as CSS cursors get. */
export function cursorFor(tool: ToolId, spaceHeld: boolean): string {
  if (spaceHeld) return 'grab'
  switch (tool) {
    case 'hand':
      return 'grab'
    case 'zoom':
      return 'zoom-in'
    case 'move':
      return 'move'
    case 'eyedropper':
      return 'crosshair'
    case 'marqueeRect':
    case 'marqueeEllipse':
    case 'lasso':
    case 'wand':
    case 'crop':
      return 'crosshair'
    default:
      // The brush draws its own outline instead of using a cursor.
      return 'none'
  }
}
