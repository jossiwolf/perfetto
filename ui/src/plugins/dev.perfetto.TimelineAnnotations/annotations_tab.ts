// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {Time, type time} from '../../base/time';
import type {Tab} from '../../public/tab';
import type {Trace} from '../../public/trace';
import {
  Button,
  ButtonBar,
  ButtonGroup,
  ButtonVariant,
} from '../../widgets/button';
import {EmptyState} from '../../widgets/empty_state';
import {Icon} from '../../widgets/icon';
import {Popup, PopupPosition} from '../../widgets/popup';
import {Switch} from '../../widgets/switch';
import {Intent} from '../../widgets/common';
import {
  type Annotation,
  type AnnotationStore,
  type LabelAnnotation,
  type LabelFontFamily,
  normalizeColor,
} from './model';
import {exportAnnotations, importAnnotationsFromFile} from './persistence';
import {type ToolKind, TOOL_KINDS, type ToolController} from './tools';
import type {AnnotationsOverlay} from './overlay';
import {annotationToRow} from './annotation_track';

export const ANNOTATIONS_TAB_URI = 'dev.perfetto.TimelineAnnotations#tab';

export const PALETTE_COLORS: ReadonlyArray<{
  readonly label: string;
  readonly value: string;
}> = [
  {label: 'Red', value: '#e53935'},
  {label: 'Orange', value: '#ff6d00'},
  {label: 'Yellow', value: '#fdd835'},
  {label: 'Green', value: '#43a047'},
  {label: 'Teal', value: '#00897b'},
  {label: 'Blue', value: '#1e88e5'},
  {label: 'Purple', value: '#8e24aa'},
  {label: 'Grey', value: '#757575'},
];

export const LABEL_FONT_OPTIONS: ReadonlyArray<{
  readonly value: LabelFontFamily;
  readonly label: string;
}> = [
  {value: 'Roboto', label: 'Roboto'},
  {value: 'Google Sans', label: 'Google Sans'},
  {value: 'Inter', label: 'Inter'},
  {value: 'Roboto Condensed', label: 'Roboto Condensed'},
  {value: 'Roboto Mono', label: 'Roboto Mono'},
  {value: 'Georgia', label: 'Georgia'},
];

export const LABEL_FONT_SIZES: ReadonlyArray<number> = [
  11, 12, 13, 14, 16, 18, 20, 24,
];

function normalizeFontFamily(family?: LabelFontFamily): LabelFontFamily {
  if (!family || family === 'sans-serif') return 'Roboto';
  if (family === 'monospace') return 'Roboto Mono';
  if (family === 'serif') return 'Georgia';
  return family;
}

const ANNOTATION_KINDS: ReadonlyArray<{
  readonly kind: Annotation['kind'];
  readonly icon: string;
  readonly label: string;
}> = [
  {kind: 'rect', icon: 'crop_square', label: 'Rectangle'},
  {kind: 'ellipse', icon: 'circle', label: 'Ellipse'},
  {kind: 'label', icon: 'text_fields', label: 'Label'},
  {kind: 'arrow', icon: 'arrow_forward', label: 'Arrow'},
  {kind: 'path', icon: 'draw', label: 'Path'},
];

export function getToolIcon(tool: ToolKind): string {
  switch (tool) {
    case 'select':
      return 'near_me';
    case 'rect':
      return 'crop_square';
    case 'ellipse':
      return 'circle';
    case 'pen':
      return 'draw';
    case 'arrow':
      return 'arrow_forward';
    case 'label':
      return 'text_fields';
  }
}

export function getToolLabel(tool: ToolKind): string {
  switch (tool) {
    case 'select':
      return 'Select';
    case 'rect':
      return 'Rectangle';
    case 'ellipse':
      return 'Ellipse';
    case 'pen':
      return 'Pen';
    case 'arrow':
      return 'Arrow';
    case 'label':
      return 'Label';
  }
}

function getKindIcon(kind: Annotation['kind']): string {
  switch (kind) {
    case 'rect':
      return 'crop_square';
    case 'ellipse':
      return 'circle';
    case 'label':
      return 'text_fields';
    case 'path':
      return 'draw';
    case 'arrow':
      return 'arrow_forward';
  }
}

export function colorWithAlpha(color: string, alpha: number): string {
  const normalized = normalizeColor(color);
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    const red = parseInt(normalized.slice(1, 3), 16);
    const green = parseInt(normalized.slice(3, 5), 16);
    const blue = parseInt(normalized.slice(5, 7), 16);
    const clampedAlpha = Math.max(
      0,
      Math.min(1, Number.isFinite(alpha) ? alpha : 1),
    );
    return `rgba(${red}, ${green}, ${blue}, ${clampedAlpha})`;
  }
  return color;
}

export interface ColorSwatchesAttrs {
  readonly value: string;
  readonly onChange: (color: string) => void;
  readonly label?: string;
  readonly tooltip?: string;
  readonly allowMatchStroke?: {
    readonly active: boolean;
    readonly strokeColor: string;
    readonly title?: string;
    readonly onSelect: () => void;
  };
  readonly allowTransparent?: {
    readonly active: boolean;
    readonly title?: string;
    readonly onSelect: () => void;
  };
}

export class ColorSwatches implements m.ClassComponent<ColorSwatchesAttrs> {
  view({attrs}: m.CVnode<ColorSwatchesAttrs>) {
    const {
      value,
      onChange,
      label,
      tooltip,
      allowMatchStroke,
      allowTransparent,
    } = attrs;
    const normalized = normalizeColor(value).toLowerCase();
    const isSpecialActive = Boolean(
      allowMatchStroke?.active || allowTransparent?.active,
    );
    const isPaletteMatch = PALETTE_COLORS.some(
      (paletteColor) =>
        normalizeColor(paletteColor.value).toLowerCase() === normalized,
    );

    const swatchElements: m.Children[] = [];

    if (allowMatchStroke !== undefined) {
      swatchElements.push(
        m(
          'button.pf-timeline-annotations__swatch.pf-timeline-annotations__swatch--auto',
          {
            key: 'match-stroke',
            type: 'button',
            className: allowMatchStroke.active
              ? 'pf-timeline-annotations__swatch--active'
              : '',
            style: {
              borderColor: allowMatchStroke.strokeColor,
              backgroundColor: colorWithAlpha(
                allowMatchStroke.strokeColor,
                0.2,
              ),
              color: allowMatchStroke.strokeColor,
            },
            title: allowMatchStroke.title ?? 'Match stroke color',
            onclick: (event: MouseEvent) => {
              event.stopPropagation();
              allowMatchStroke.onSelect();
            },
          },
          m(Icon, {icon: 'sync'}),
        ),
      );
    }

    if (allowTransparent !== undefined) {
      swatchElements.push(
        m(
          'button.pf-timeline-annotations__swatch.pf-timeline-annotations__swatch--none',
          {
            key: 'transparent',
            type: 'button',
            className: allowTransparent.active
              ? 'pf-timeline-annotations__swatch--active'
              : '',
            title: allowTransparent.title ?? 'No fill (transparent)',
            onclick: (event: MouseEvent) => {
              event.stopPropagation();
              allowTransparent.onSelect();
            },
          },
        ),
      );
    }

    for (const paletteColor of PALETTE_COLORS) {
      const isActive =
        !isSpecialActive &&
        normalizeColor(paletteColor.value).toLowerCase() === normalized;
      swatchElements.push(
        m('button.pf-timeline-annotations__swatch', {
          key: paletteColor.value,
          type: 'button',
          className: isActive ? 'pf-timeline-annotations__swatch--active' : '',
          style: {backgroundColor: paletteColor.value},
          title: paletteColor.label,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            onChange(paletteColor.value);
          },
        }),
      );
    }

    const customInputHex = /^#[0-9a-f]{6}$/i.test(normalized)
      ? normalized
      : '#757575';
    const isCustomActive = !isSpecialActive && !isPaletteMatch;
    swatchElements.push(
      m(
        'label.pf-timeline-annotations__swatch.pf-timeline-annotations__swatch--custom',
        {
          key: 'custom',
          className: isCustomActive
            ? 'pf-timeline-annotations__swatch--active'
            : '',
          style: isCustomActive ? {backgroundColor: normalized} : undefined,
          title: isCustomActive
            ? `Custom color (${normalized})`
            : 'Custom color...',
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
          },
        },
        m('input[type=color]', {
          value: customInputHex,
          oninput: (event: Event) => {
            const target = event.target as HTMLInputElement;
            onChange(target.value);
          },
          onchange: (event: Event) => {
            const target = event.target as HTMLInputElement;
            onChange(target.value);
          },
        }),
      ),
    );

    const children: m.Children = [];
    if (label) {
      children.push(m('span.pf-timeline-annotations__label', label));
    }
    children.push(m('.pf-timeline-annotations__swatch-row', swatchElements));

    return m('.pf-timeline-annotations__swatches', {title: tooltip}, children);
  }
}

function getAnnotationStartTs(
  annotation: Annotation,
  store: AnnotationStore,
): bigint {
  const row = annotationToRow(annotation, (lookupId) => store.get(lookupId));
  return row.ts;
}

interface JumpTarget {
  readonly start: time;
  readonly end: time;
  readonly trackUris: ReadonlyArray<string>;
}

function getTrackUrisForAnnotation(
  annotation: Annotation,
  store: AnnotationStore,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(annotation.id)) {
    return [];
  }
  visited.add(annotation.id);

  switch (annotation.kind) {
    case 'rect':
    case 'ellipse':
      return [...annotation.anchor.trackUris];
    case 'label':
      return [annotation.position.trackUri];
    case 'path':
      return annotation.points.map((point) => point.trackUri);
    case 'arrow': {
      const uris: string[] = [];
      if (annotation.from.kind === 'point') {
        uris.push(annotation.from.point.trackUri);
      } else {
        const fromTarget = store.get(annotation.from.id);
        if (fromTarget) {
          uris.push(...getTrackUrisForAnnotation(fromTarget, store, visited));
        }
      }
      if (annotation.to.kind === 'point') {
        uris.push(annotation.to.point.trackUri);
      } else {
        const toTarget = store.get(annotation.to.id);
        if (toTarget) {
          uris.push(...getTrackUrisForAnnotation(toTarget, store, visited));
        }
      }
      return uris;
    }
  }
}

function getJumpTarget(
  annotation: Annotation,
  store: AnnotationStore,
): JumpTarget {
  switch (annotation.kind) {
    case 'rect':
    case 'ellipse':
      return {
        start: annotation.anchor.start,
        end: annotation.anchor.end,
        trackUris: annotation.anchor.trackUris,
      };
    case 'label':
      return {
        start: annotation.position.ts,
        end: annotation.position.ts,
        trackUris: [annotation.position.trackUri],
      };
    case 'path': {
      const points = annotation.points;
      if (points.length === 0) {
        return {start: Time.fromRaw(0n), end: Time.fromRaw(0n), trackUris: []};
      }
      let minTs = points[0].ts;
      let maxTs = points[0].ts;
      const uris = new Set<string>();
      for (const point of points) {
        if (point.ts < minTs) minTs = point.ts;
        if (point.ts > maxTs) maxTs = point.ts;
        uris.add(point.trackUri);
      }
      return {start: minTs, end: maxTs, trackUris: Array.from(uris)};
    }
    case 'arrow': {
      const row = annotationToRow(annotation, (lookupId) =>
        store.get(lookupId),
      );
      const start = Time.fromRaw(row.ts);
      const end = Time.fromRaw(row.ts + row.dur);
      const uris = getTrackUrisForAnnotation(annotation, store);
      return {start, end, trackUris: uris};
    }
  }
}

const POPUP_EXIT_ANIM_MS = 85;

export class AnnotationsTab implements Tab {
  private readonly trace: Trace;
  private readonly store: AnnotationStore;
  private readonly tools: ToolController;
  private readonly overlay: AnnotationsOverlay;
  private showClearConfirm = false;
  private closingClearConfirm = false;
  private fallbackFillColor: string | undefined = undefined;
  private fallbackFillOpacity: number = 0.2;
  private readonly knownAnnotationIds = new Set<string>();
  private readonly knownItemIds = new Set<string>();
  private readonly enteringItemIds = new Set<string>();
  private isInitialMount = true;
  private readonly deletingIds = new Set<string>();
  private openPopupKey: string | undefined = undefined;
  private closingPopupKey: string | undefined = undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(
    trace: Trace,
    store: AnnotationStore,
    tools: ToolController,
    overlay: AnnotationsOverlay,
  ) {
    this.trace = trace;
    this.store = store;
    this.tools = tools;
    this.overlay = overlay;
  }

  getTitle(): string {
    return 'Annotations';
  }

  get pendingClearConfirm(): boolean {
    return this.showClearConfirm;
  }

  set pendingClearConfirm(val: boolean) {
    if (val) {
      this.showClearConfirm = true;
      this.closingClearConfirm = false;
    } else {
      this.closeClearConfirmModal();
    }
  }

  private closeClearConfirmModal(onComplete?: () => void): void {
    if (!this.showClearConfirm || this.closingClearConfirm) {
      return;
    }
    this.closingClearConfirm = true;
    m.redraw();
    setTimeout(() => {
      this.showClearConfirm = false;
      this.closingClearConfirm = false;
      onComplete?.();
      m.redraw();
    }, 130);
  }

  private closePopupWithAnimation(key: string): void {
    if (this.openPopupKey === key) {
      this.openPopupKey = undefined;
      this.closingPopupKey = key;
      if (this.closeTimer !== undefined) {
        clearTimeout(this.closeTimer);
      }
      m.redraw();
      this.closeTimer = setTimeout(() => {
        if (this.closingPopupKey === key) {
          this.closingPopupKey = undefined;
          this.closeTimer = undefined;
          m.redraw();
        }
      }, POPUP_EXIT_ANIM_MS);
    }
  }

  private closeAllPopups(): void {
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.openPopupKey = undefined;
    this.closingPopupKey = undefined;
  }

  private deleteAnnotationAnimated(id: string): void {
    if (this.deletingIds.has(id)) {
      return;
    }
    this.deletingIds.add(id);
    this.trace.raf?.scheduleFullRedraw?.();
    m.redraw();
    setTimeout(() => {
      this.deletingIds.delete(id);
      this.store.remove(id);
      this.trace.raf?.scheduleFullRedraw?.();
      m.redraw();
    }, 150);
  }

  private renderAnimatedPopup(
    key: string,
    triggerVnode: m.Vnode,
    position: PopupPosition,
    className: string,
    content: m.Children,
  ): m.Children {
    const isOpen = this.openPopupKey === key || this.closingPopupKey === key;
    const isClosing = this.closingPopupKey === key;
    const triggerAttrs = triggerVnode.attrs as
      {onclick?: (event: MouseEvent) => void} | undefined;
    const originalOnClick = triggerAttrs?.onclick;
    const triggerWithClick = {
      ...triggerVnode,
      attrs: {
        ...triggerVnode.attrs,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          if (typeof originalOnClick === 'function') {
            originalOnClick(event);
          }
          if (this.openPopupKey === key) {
            this.closePopupWithAnimation(key);
          } else {
            if (this.closeTimer !== undefined) {
              clearTimeout(this.closeTimer);
              this.closeTimer = undefined;
            }
            this.closingPopupKey = undefined;
            this.openPopupKey = key;
            m.redraw();
          }
        },
      },
    };

    const fullClassName = [
      className,
      isClosing
        ? `${className}--closing pf-timeline-annotations-popup--closing`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    return m(
      Popup,
      {
        fitContent: true,
        position,
        className: fullClassName,
        isOpen,
        onChange: (shouldOpen: boolean) => {
          if (!shouldOpen) {
            this.closePopupWithAnimation(key);
          }
        },
        trigger: triggerWithClick,
      },
      content,
    );
  }

  private get defaultFillColor(): string | undefined {
    const toolsFill = (this.tools as {fillColor?: string}).fillColor;
    return toolsFill !== undefined ? toolsFill : this.fallbackFillColor;
  }

  private setDefaultFillColor(color: string | undefined): void {
    if (
      typeof (this.tools as {setFillColor?: (color?: string) => void})
        .setFillColor === 'function'
    ) {
      (this.tools as {setFillColor?: (color?: string) => void}).setFillColor!(
        color,
      );
    } else {
      this.fallbackFillColor = color;
    }
  }

  private get defaultFillOpacity(): number {
    const toolsOpacity = (this.tools as {fillOpacity?: number}).fillOpacity;
    return toolsOpacity !== undefined ? toolsOpacity : this.fallbackFillOpacity;
  }

  private setDefaultFillOpacity(opacity: number): void {
    if (
      typeof (this.tools as {setFillOpacity?: (opacity: number) => void})
        .setFillOpacity === 'function'
    ) {
      (this.tools as {setFillOpacity?: (opacity: number) => void})
        .setFillOpacity!(opacity);
    } else {
      this.fallbackFillOpacity = opacity;
    }
  }

  render(): m.Children {
    const annotations = this.store
      .list()
      .slice()
      .sort((first, second) => {
        const firstTs = getAnnotationStartTs(first, this.store);
        const secondTs = getAnnotationStartTs(second, this.store);
        if (firstTs < secondTs) return -1;
        if (firstTs > secondTs) return 1;
        return 0;
      });

    for (const ann of annotations) {
      this.knownAnnotationIds.add(ann.id);
    }

    if (this.isInitialMount) {
      for (const ann of annotations) {
        this.knownItemIds.add(ann.id);
      }
      this.isInitialMount = false;
    } else {
      for (const ann of annotations) {
        if (!this.knownItemIds.has(ann.id)) {
          this.knownItemIds.add(ann.id);
          this.enteringItemIds.add(ann.id);
          setTimeout(() => {
            this.enteringItemIds.delete(ann.id);
            m.redraw();
          }, 180);
        }
      }
      const currentIds = new Set(annotations.map((ann) => ann.id));
      for (const id of this.knownItemIds) {
        if (!currentIds.has(id)) {
          this.knownItemIds.delete(id);
          this.enteringItemIds.delete(id);
        }
      }
    }

    const children: m.Children = [
      this.renderToolbar(annotations.length),
      annotations.length === 0
        ? m(
            EmptyState,
            {
              icon: 'draw',
              title: 'No annotations yet',
              fillHeight: true,
            },
            'Turn on drawing mode or select an area on the timeline to create annotations.',
          )
        : m(
            '.pf-timeline-annotations-list',
            annotations.map((annotation) =>
              this.renderAnnotationItem(annotation),
            ),
          ),
    ];

    if (this.showClearConfirm || this.closingClearConfirm) {
      children.push(this.renderClearConfirmModal(annotations.length));
    }

    return m('.pf-timeline-annotations-tab', children);
  }

  private renderToolbar(count: number): m.Children {
    return m(
      '.pf-timeline-annotations__toolbar.pf-timeline-annotations-toolbar',
      m(
        '.pf-timeline-annotations__group',
        m(
          '.pf-timeline-annotations__drawing-toggle',
          {
            className: this.tools.drawingMode
              ? 'pf-timeline-annotations__drawing-toggle--active'
              : '',
          },
          m(Icon, {
            icon: 'draw',
            className: 'pf-timeline-annotations__drawing-icon',
          }),
          m(Switch, {
            label: 'Drawing mode',
            title: 'Toggle drawing mode (Mod+Shift+D)',
            checked: this.tools.drawingMode,
            onchange: (event: Event) => {
              const target = event.target as HTMLInputElement | null;
              const next =
                target && typeof target.checked === 'boolean'
                  ? target.checked
                  : !this.tools.drawingMode;
              this.tools.setDrawingMode(next);
            },
          }),
        ),
      ),
      m(
        '.pf-timeline-annotations__group',
        m(
          ButtonGroup,
          {className: 'pf-timeline-annotations__tools'},
          TOOL_KINDS.map((toolKind) => {
            const isActive = this.tools.tool === toolKind;
            const label = getToolLabel(toolKind);
            return m(Button, {
              'key': toolKind,
              'icon': getToolIcon(toolKind),
              'active': isActive,
              'intent': isActive ? Intent.Primary : Intent.None,
              'variant': ButtonVariant.Filled,
              'compact': true,
              'title': `${label} tool`,
              'className':
                'pf-timeline-annotations__tool-button pf-timeline-annotations__tool-btn',
              'data-tool': toolKind,
              'onclick': () => {
                if (
                  this.tools.tool === toolKind &&
                  toolKind !== 'select' &&
                  this.tools.drawingMode
                ) {
                  this.tools.setDrawingMode(false);
                  return;
                }
                if (
                  typeof (this.tools as {activateTool?: (t: ToolKind) => void})
                    .activateTool === 'function'
                ) {
                  (this.tools as {activateTool?: (t: ToolKind) => void})
                    .activateTool!(toolKind);
                } else {
                  this.tools.setTool(toolKind);
                  if (toolKind !== 'select' && !this.tools.drawingMode) {
                    this.tools.setDrawingMode(true);
                  }
                }
              },
            });
          }),
        ),
        this.renderDefaultStylePopup(),
      ),
      m(
        '.pf-timeline-annotations__group.pf-timeline-annotations__group--right',
        m(
          ButtonBar,
          m(Button, {
            icon: 'undo',
            title: 'Undo',
            disabled: !this.store.canUndo,
            onclick: () => this.store.undo(),
          }),
          m(Button, {
            icon: 'redo',
            title: 'Redo',
            disabled: !this.store.canRedo,
            onclick: () => this.store.redo(),
          }),
        ),
        m('.pf-timeline-annotations__divider'),
        m(Button, {
          icon: 'delete_sweep',
          label: 'Clear all',
          title: 'Remove all annotations',
          disabled: count === 0,
          onclick: () => {
            this.showClearConfirm = true;
            this.closingClearConfirm = false;
            m.redraw();
          },
        }),
        m('.pf-timeline-annotations__divider'),
        m(
          ButtonBar,
          m(Button, {
            icon: 'file_upload',
            label: 'Import',
            title: 'Import annotations from JSON file',
            onclick: () => {
              importAnnotationsFromFile(this.store);
            },
          }),
          m(Button, {
            icon: 'file_download',
            label: 'Export',
            title: 'Export annotations to JSON',
            onclick: () => {
              exportAnnotations(this.trace, this.store);
            },
          }),
        ),
      ),
    );
  }

  private renderDefaultStylePopup(): m.Children {
    const currentColor = this.tools.color;
    const currentFill = this.defaultFillColor;
    const currentOpacity = this.defaultFillOpacity;
    const fillCss =
      currentFill === 'transparent'
        ? 'transparent'
        : colorWithAlpha(
            currentFill ?? currentColor,
            Math.max(0.35, currentOpacity),
          );

    const trigger = m(
      'button.pf-timeline-annotations__color-trigger',
      {
        type: 'button',
        title: 'Default annotation color & fill',
      },
      m('.pf-timeline-annotations__color-preview', {
        style: {
          borderColor: currentColor,
          backgroundColor: fillCss,
        },
      }),
      m(Icon, {icon: 'arrow_drop_down'}),
    );

    const content = m(
      '.pf-timeline-annotations-style-panel',
      m(
        '.pf-timeline-annotations-style-section',
        m(
          'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
          'Default stroke',
        ),
        m(ColorSwatches, {
          value: currentColor,
          onChange: (color: string) => {
            this.tools.setColor(color);
          },
        }),
      ),
      m(
        '.pf-timeline-annotations-style-section',
        m(
          'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
          'Default fill',
        ),
        m(ColorSwatches, {
          value: currentFill ?? currentColor,
          allowMatchStroke: {
            active: currentFill === undefined,
            strokeColor: currentColor,
            title: 'Match stroke color',
            onSelect: () => this.setDefaultFillColor(undefined),
          },
          allowTransparent: {
            active: currentFill === 'transparent',
            title: 'No fill (transparent)',
            onSelect: () => this.setDefaultFillColor('transparent'),
          },
          onChange: (color: string) => {
            this.setDefaultFillColor(color);
          },
        }),
        m(
          '.pf-timeline-annotations-slider-row',
          m('span', 'Fill opacity'),
          m('input[type=range]', {
            min: 0.05,
            max: 0.8,
            step: 0.05,
            value: currentOpacity,
            oninput: (event: Event) => {
              const target = event.target as HTMLInputElement;
              const val = parseFloat(target.value);
              this.setDefaultFillOpacity(val);
            },
          }),
          m(
            'span.pf-timeline-annotations-slider-val',
            `${Math.round(currentOpacity * 100)}%`,
          ),
        ),
      ),
    );

    return this.renderAnimatedPopup(
      'default-style',
      trigger,
      PopupPosition.Bottom,
      'pf-timeline-annotations__style-popup',
      content,
    );
  }

  private renderItemColorDropdown(annotation: Annotation): m.Children {
    const currentColor = annotation.color;
    const currentFill = annotation.fillColor;
    const currentOpacity = annotation.fillOpacity ?? 0.2;
    const fillCss =
      currentFill === 'transparent'
        ? 'transparent'
        : colorWithAlpha(
            currentFill ?? currentColor,
            Math.max(0.35, currentOpacity),
          );

    const sections: m.Children = [];

    if (annotation.kind === 'label') {
      const currentTextColor = annotation.textColor ?? annotation.color;
      const currentBg = annotation.backgroundColor;

      sections.push(
        m(
          '.pf-timeline-annotations-style-section',
          m(
            'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
            'Text color',
          ),
          m(ColorSwatches, {
            value: currentTextColor,
            allowMatchStroke: {
              active: annotation.textColor === undefined,
              strokeColor: annotation.color,
              title: 'Auto theme text color',
              onSelect: () => {
                this.store.update(annotation.id, {textColor: undefined});
              },
            },
            onChange: (textColor: string) => {
              this.store.update(annotation.id, {textColor});
            },
          }),
        ),
        m(
          '.pf-timeline-annotations-style-section',
          m(
            'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
            'Background',
          ),
          m(ColorSwatches, {
            value:
              currentBg && currentBg !== 'transparent'
                ? currentBg
                : (annotation.fillColor ?? annotation.color),
            allowMatchStroke: {
              active: currentBg === undefined,
              strokeColor: annotation.color,
              title: 'Tint background',
              onSelect: () => {
                this.store.update(annotation.id, {backgroundColor: undefined});
              },
            },
            allowTransparent: {
              active: currentBg === 'transparent',
              title: 'Transparent background',
              onSelect: () => {
                this.store.update(annotation.id, {
                  backgroundColor: 'transparent',
                });
              },
            },
            onChange: (backgroundColor: string) => {
              this.store.update(annotation.id, {backgroundColor});
            },
          }),
        ),
      );
    } else {
      sections.push(
        m(
          '.pf-timeline-annotations-style-section',
          m(
            'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
            'Stroke',
          ),
          m(ColorSwatches, {
            value: currentColor,
            onChange: (color: string) => {
              this.store.update(annotation.id, {color});
            },
          }),
        ),
        m(
          '.pf-timeline-annotations-style-section',
          m(
            'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
            'Fill',
          ),
          m(ColorSwatches, {
            value: currentFill ?? currentColor,
            allowMatchStroke: {
              active: currentFill === undefined,
              strokeColor: currentColor,
              title: 'Match stroke color',
              onSelect: () => {
                this.store.update(annotation.id, {fillColor: undefined});
              },
            },
            allowTransparent: {
              active: currentFill === 'transparent',
              title: 'No fill (transparent)',
              onSelect: () => {
                this.store.update(annotation.id, {fillColor: 'transparent'});
              },
            },
            onChange: (color: string) => {
              this.store.update(annotation.id, {fillColor: color});
            },
          }),
          m(
            '.pf-timeline-annotations-slider-row',
            m('span', 'Fill opacity'),
            m('input[type=range]', {
              min: 0.05,
              max: 0.8,
              step: 0.05,
              value: currentOpacity,
              oninput: (event: Event) => {
                const target = event.target as HTMLInputElement;
                const val = parseFloat(target.value);
                this.store.update(annotation.id, {fillOpacity: val});
              },
            }),
            m(
              'span.pf-timeline-annotations-slider-val',
              `${Math.round(currentOpacity * 100)}%`,
            ),
          ),
        ),
      );
    }

    if (annotation.kind === 'arrow') {
      const curVal =
        annotation.controlOffset?.normalPx ?? annotation.curvature ?? 0;
      sections.push(
        m(
          '.pf-timeline-annotations-style-section',
          m(
            'span.pf-timeline-annotations-popup-section__title.pf-timeline-annotations__label',
            'Arrow curve',
          ),
          m(
            ButtonGroup,
            m(Button, {
              compact: true,
              label: 'Straight',
              active: curVal === 0,
              onclick: () => {
                this.store.update(annotation.id, {
                  curvature: 0,
                  controlOffset: undefined,
                });
              },
            }),
            m(Button, {
              compact: true,
              label: 'Arc Up',
              active: curVal === -50,
              onclick: () => {
                this.store.update(annotation.id, {
                  curvature: -50,
                  controlOffset: {alongFrac: 0.5, normalPx: -50},
                });
              },
            }),
            m(Button, {
              compact: true,
              label: 'Arc Down',
              active: curVal === 50,
              onclick: () => {
                this.store.update(annotation.id, {
                  curvature: 50,
                  controlOffset: {alongFrac: 0.5, normalPx: 50},
                });
              },
            }),
          ),
          m(
            '.pf-timeline-annotations-slider-row',
            m('span', 'Curve:'),
            m('input[type=range]', {
              min: -160,
              max: 160,
              step: 5,
              value: curVal,
              oninput: (event: Event) => {
                const target = event.target as HTMLInputElement;
                const val = parseInt(target.value, 10);
                this.store.update(annotation.id, {
                  curvature: val,
                  controlOffset:
                    val === 0
                      ? undefined
                      : {
                          alongFrac: annotation.controlOffset?.alongFrac ?? 0.5,
                          normalPx: val,
                        },
                });
              },
            }),
            m('span.pf-timeline-annotations-slider-val', `${curVal}px`),
          ),
        ),
      );
    }

    const previewColor =
      annotation.kind === 'label'
        ? (annotation.textColor ?? annotation.color)
        : currentColor;
    const previewFill =
      annotation.kind === 'label'
        ? annotation.backgroundColor === 'transparent'
          ? 'transparent'
          : (annotation.backgroundColor ??
            colorWithAlpha(annotation.color, 0.2))
        : fillCss;

    const trigger = m(
      'button.pf-timeline-annotations__color-trigger',
      {
        type: 'button',
        title: 'Style & color options',
      },
      m('.pf-timeline-annotations__color-preview', {
        style: {
          borderColor: previewColor,
          backgroundColor: previewFill,
        },
      }),
      m(Icon, {icon: 'arrow_drop_down'}),
    );

    const content = m('.pf-timeline-annotations-style-panel', sections);

    return this.renderAnimatedPopup(
      `style-${annotation.id}`,
      trigger,
      PopupPosition.Bottom,
      'pf-timeline-annotations__style-popup',
      content,
    );
  }

  private renderClearConfirmModal(count: number): m.Children {
    const isClosing = this.closingClearConfirm;
    const overlayClass = [
      'pf-timeline-annotations-clear-overlay',
      isClosing
        ? 'pf-timeline-annotations-clear-overlay--closing pf-timeline-annotations-modal-backdrop--closing'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    const dialogClass = [
      'pf-timeline-annotations-clear-dialog',
      isClosing
        ? 'pf-timeline-annotations-clear-dialog--closing pf-timeline-annotations-modal--closing'
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    return m(
      'div',
      {
        className: overlayClass,
        onclick: () => {
          this.closeClearConfirmModal();
        },
      },
      m(
        'div',
        {
          className: dialogClass,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
          },
        },
        m(
          '.pf-timeline-annotations-clear-dialog__badge',
          m(Icon, {icon: 'delete_sweep'}),
        ),
        m(
          'h3.pf-timeline-annotations-clear-dialog__heading',
          'Clear all annotations?',
        ),
        m(
          'p.pf-timeline-annotations-clear-dialog__description',
          `Remove all ${count} annotation${count === 1 ? '' : 's'} from this trace? You can restore them with Undo.`,
        ),
        m(
          ButtonBar,
          {className: 'pf-timeline-annotations-clear-dialog__actions'},
          m(Button, {
            label: 'Cancel',
            onclick: () => {
              this.closeClearConfirmModal();
            },
          }),
          m(Button, {
            intent: Intent.Danger,
            variant: ButtonVariant.Filled,
            label: 'Confirm clear',
            onclick: () => {
              this.closeClearConfirmModal(() => {
                this.closeAllPopups();
                this.store.replaceAll([]);
              });
            },
          }),
        ),
      ),
    );
  }

  private maybeAutoFocusLabel(
    dom: HTMLElement,
    annotation: Annotation,
    isSelected: boolean,
  ): void {
    if (annotation.kind !== 'label' || !isSelected) {
      return;
    }
    const toolsWithAutoFocus = this.tools as {
      consumeAutoFocusId?: (id: string) => boolean;
    };
    const shouldFocus =
      typeof toolsWithAutoFocus.consumeAutoFocusId === 'function'
        ? toolsWithAutoFocus.consumeAutoFocusId(annotation.id)
        : !this.knownAnnotationIds.has(annotation.id);

    if (shouldFocus) {
      requestAnimationFrame(() => {
        const input = dom.querySelector(
          '.pf-timeline-annotations-title-input input, input.pf-timeline-annotations-title-input, input.pf-timeline-annotations-title',
        ) as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.select();
        }
      });
    }
  }

  private renderItemKindDropdown(annotation: Annotation): m.Children {
    const kindLabel =
      annotation.kind.charAt(0).toUpperCase() + annotation.kind.slice(1);

    const kindTrigger = m(
      'button.pf-timeline-annotations-icon.pf-timeline-annotations-kind-trigger',
      {
        type: 'button',
        title: `${kindLabel} annotation (click to change type)`,
      },
      m(Icon, {icon: getKindIcon(annotation.kind)}),
      m(Icon, {
        icon: 'arrow_drop_down',
        className: 'pf-timeline-annotations-dropdown-caret',
      }),
    );

    const kindMenu = m(
      '.pf-timeline-annotations-kind-menu',
      ANNOTATION_KINDS.map(({kind, icon, label}) =>
        m(
          `button.pf-timeline-annotations-kind-option.${Popup.DISMISS_POPUP_GROUP_CLASS}`,
          {
            key: kind,
            type: 'button',
            className: annotation.kind === kind ? 'pf-active' : '',
            onclick: () => {
              this.store.changeKind(annotation.id, kind);
            },
          },
          m(Icon, {icon}),
          m('span', label),
        ),
      ),
    );

    return this.renderAnimatedPopup(
      `kind-${annotation.id}`,
      kindTrigger,
      PopupPosition.BottomStart,
      'pf-timeline-annotations__kind-popup',
      kindMenu,
    );
  }

  private renderLabelToolbar(annotation: LabelAnnotation): m.Children {
    const currentFamily = normalizeFontFamily(annotation.fontFamily);
    const currentSize = annotation.fontSize ?? 12;

    return m(
      '.pf-timeline-annotations-label-toolbar',
      m('span.pf-timeline-annotations__label', 'Font'),
      m(
        'select.pf-timeline-annotations-select.pf-timeline-annotations-font-select',
        {
          value: currentFamily,
          title: 'Font family',
          onchange: (event: Event) => {
            const target = event.target as HTMLSelectElement;
            this.store.update(annotation.id, {
              kind: 'label',
              fontFamily: target.value as LabelFontFamily,
            });
          },
        },
        LABEL_FONT_OPTIONS.map((opt) =>
          m('option', {value: opt.value}, opt.label),
        ),
      ),
      m('span.pf-timeline-annotations__label', 'Size'),
      m(
        'select.pf-timeline-annotations-select.pf-timeline-annotations-size-select',
        {
          value: currentSize,
          title: 'Font size',
          onchange: (event: Event) => {
            const target = event.target as HTMLSelectElement;
            this.store.update(annotation.id, {
              kind: 'label',
              fontSize: Number(target.value),
            });
          },
        },
        LABEL_FONT_SIZES.map((size) => m('option', {value: size}, `${size}px`)),
      ),
    );
  }

  private renderAnnotationItem(annotation: Annotation): m.Children {
    const isSelected = this.store.selectedId === annotation.id;
    const isHidden = this.store.isHidden(annotation.id);
    const isDeleting = this.deletingIds.has(annotation.id);
    const isEntering = this.enteringItemIds.has(annotation.id);
    const renderInfo = this.overlay.lastRender.get(annotation.id);

    const headerChildren: m.Children = [
      this.renderItemKindDropdown(annotation),
      m(
        'input.pf-timeline-annotations-input.pf-timeline-annotations-title.pf-timeline-annotations-title-input',
        {
          type: 'text',
          placeholder: annotation.kind,
          value:
            annotation.title ??
            (annotation.kind === 'label' ? annotation.text : ''),
          oninput: (event: Event) => {
            const target = event.target as HTMLInputElement;
            const val = target.value;
            if (annotation.kind === 'label') {
              this.store.update(annotation.id, {title: val, text: val});
            } else {
              this.store.update(annotation.id, {title: val});
            }
          },
        },
      ),
    ];

    const badge = this.renderBadge(renderInfo);
    if (badge !== undefined && badge !== null && badge !== false) {
      headerChildren.push(badge);
    }

    headerChildren.push(this.renderItemColorDropdown(annotation));

    headerChildren.push(
      m(
        '.pf-timeline-annotations-actions',
        m(Button, {
          icon: 'my_location',
          title: 'Focus annotation on timeline',
          compact: true,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            this.jumpTo(annotation);
          },
        }),
        m(Button, {
          icon: isHidden ? 'visibility_off' : 'visibility',
          title: isHidden ? 'Show on canvas' : 'Hide from canvas',
          compact: true,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            this.store.toggleHidden(annotation.id);
          },
        }),
        m(Button, {
          icon: 'delete',
          title: 'Delete annotation',
          compact: true,
          intent: Intent.Danger,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            this.deleteAnnotationAnimated(annotation.id);
          },
        }),
      ),
    );

    const bodyChildren: m.Children = [
      m(
        'input.pf-timeline-annotations-input.pf-timeline-annotations-description.pf-timeline-annotations-desc-input',
        {
          type: 'text',
          placeholder: 'Description',
          value: annotation.description ?? '',
          oninput: (event: Event) => {
            const target = event.target as HTMLInputElement;
            this.store.update(annotation.id, {description: target.value});
          },
        },
      ),
    ];

    if (annotation.kind === 'label') {
      bodyChildren.push(this.renderLabelToolbar(annotation));
    }

    return m(
      '.pf-timeline-annotations-item',
      {
        key: annotation.id,
        className: [
          isSelected ? 'pf-timeline-annotations-item--selected' : '',
          isHidden ? 'pf-timeline-annotations-item--hidden' : '',
          isDeleting ? 'pf-timeline-annotations-item--deleting' : '',
          isEntering ? 'pf-timeline-annotations-item--entering' : '',
        ]
          .filter(Boolean)
          .join(' '),
        onclick: () => {
          this.store.select(annotation.id);
        },
        oncreate: (vnode: m.VnodeDOM) => {
          this.maybeAutoFocusLabel(
            vnode.dom as HTMLElement,
            annotation,
            isSelected,
          );
        },
        onupdate: (vnode: m.VnodeDOM) => {
          this.maybeAutoFocusLabel(
            vnode.dom as HTMLElement,
            annotation,
            isSelected,
          );
        },
      },
      m('.pf-timeline-annotations-item__header', headerChildren),
      m('.pf-timeline-annotations-item__body', bodyChildren),
    );
  }

  private renderBadge(renderInfo?: {
    readonly status: string;
    readonly missing: ReadonlyArray<string>;
  }): m.Children {
    if (!renderInfo) {
      return null;
    }

    if (renderInfo.status === 'degraded') {
      return m(
        'span.pf-timeline-annotations-badge.pf-timeline-annotations-badge--degraded',
        {title: 'Track matched by name fallback'},
        'fuzzy',
      );
    }

    if (renderInfo.status === 'unanchored') {
      const missingCount = renderInfo.missing.length;
      const title = `Missing tracks:\n${renderInfo.missing.join('\n')}`;
      return m(
        'span.pf-timeline-annotations-badge.pf-timeline-annotations-badge--unanchored',
        {title},
        `unanchored (${missingCount})`,
      );
    }

    return null;
  }

  private jumpTo(annotation: Annotation): void {
    this.store.select(annotation.id);
    const target = getJumpTarget(annotation, this.store);

    let primaryTrackUri = target.trackUris.find(
      (uri) => this.trace.currentWorkspace?.getTrackByUri?.(uri) !== undefined,
    );

    if (
      primaryTrackUri === undefined &&
      this.trace.currentWorkspace?.flatTracks !== undefined
    ) {
      const trackNames: ReadonlyArray<string> =
        annotation.kind === 'rect' || annotation.kind === 'ellipse'
          ? (annotation.anchor.trackNames ?? [])
          : annotation.kind === 'label'
            ? annotation.position.trackName
              ? [annotation.position.trackName]
              : []
            : [];
      for (const name of trackNames) {
        const matched = this.trace.currentWorkspace.flatTracks.find(
          (track: {readonly name?: string; readonly uri?: string}) =>
            track.name === name,
        );
        if (matched?.uri) {
          primaryTrackUri = matched.uri;
          break;
        }
      }
    }

    if (primaryTrackUri === undefined && target.trackUris.length > 0) {
      primaryTrackUri = target.trackUris[0];
    }

    if (typeof this.trace.scrollTo === 'function') {
      this.trace.scrollTo({
        time: {
          start: target.start,
          end: target.end,
          behavior: 'focus',
        },
        ...(primaryTrackUri !== undefined
          ? {track: {uri: primaryTrackUri, expandGroup: true}}
          : {}),
      });
    }

    this.trace.tabs?.showTab?.(ANNOTATIONS_TAB_URI);
  }
}
