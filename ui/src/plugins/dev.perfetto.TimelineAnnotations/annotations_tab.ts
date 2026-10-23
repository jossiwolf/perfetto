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
import {TextInput} from '../../widgets/text_input';
import {Chip} from '../../widgets/chip';
import {Intent} from '../../widgets/common';
import {
  type Annotation,
  type AnnotationStore,
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

export interface ColorSwatchesAttrs {
  readonly value: string;
  readonly onChange: (color: string) => void;
  readonly label?: string;
  readonly tooltip?: string;
}

export class ColorSwatches implements m.ClassComponent<ColorSwatchesAttrs> {
  view({attrs}: m.CVnode<ColorSwatchesAttrs>) {
    const {value, onChange, label, tooltip} = attrs;
    const normalized = normalizeColor(value).toLowerCase();
    const isPaletteMatch = PALETTE_COLORS.some(
      (paletteColor) =>
        normalizeColor(paletteColor.value).toLowerCase() === normalized,
    );

    const swatchElements = PALETTE_COLORS.map((paletteColor) => {
      const isActive =
        normalizeColor(paletteColor.value).toLowerCase() === normalized;
      return m('button.pf-timeline-annotations__swatch', {
        key: paletteColor.value,
        type: 'button',
        className: isActive ? 'pf-timeline-annotations__swatch--active' : '',
        style: {backgroundColor: paletteColor.value},
        title: paletteColor.label,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          onChange(paletteColor.value);
        },
      });
    });

    const customInputHex = /^#[0-9a-f]{6}$/i.test(normalized)
      ? normalized
      : '#757575';
    swatchElements.push(
      m(
        'label.pf-timeline-annotations__swatch.pf-timeline-annotations__swatch--custom',
        {
          key: 'custom',
          className: !isPaletteMatch
            ? 'pf-timeline-annotations__swatch--active'
            : '',
          style: !isPaletteMatch ? {backgroundColor: normalized} : undefined,
          title: !isPaletteMatch
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

export class AnnotationsTab implements Tab {
  private readonly trace: Trace;
  private readonly store: AnnotationStore;
  private readonly tools: ToolController;
  private readonly overlay: AnnotationsOverlay;
  private pendingClearConfirm = false;
  private fallbackFillColor: string | undefined = undefined;
  private fallbackFillOpacity: number = 0.2;
  private readonly knownAnnotationIds = new Set<string>();

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

  private get defaultFillColor(): string | undefined {
    const toolsFill = (this.tools as {fillColor?: string}).fillColor;
    return toolsFill !== undefined ? toolsFill : this.fallbackFillColor;
  }

  private setDefaultFillColor(color: string | undefined): void {
    if (
      typeof (this.tools as {setFillColor?: (c?: string) => void})
        .setFillColor === 'function'
    ) {
      (this.tools as {setFillColor?: (c?: string) => void}).setFillColor!(
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
      typeof (this.tools as {setFillOpacity?: (o: number) => void})
        .setFillOpacity === 'function'
    ) {
      (this.tools as {setFillOpacity?: (o: number) => void}).setFillOpacity!(
        opacity,
      );
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

    const children: m.Children = [this.renderToolbar(annotations.length)];
    if (this.pendingClearConfirm) {
      children.push(this.renderClearConfirmModal(annotations.length));
    }
    if (annotations.length === 0) {
      children.push(
        m(
          EmptyState,
          {
            icon: 'draw',
            title: 'No annotations yet',
            fillHeight: true,
          },
          'Turn on drawing mode or select an area on the timeline to create annotations.',
        ),
      );
    } else {
      children.push(
        m(
          '.pf-timeline-annotations-list',
          annotations.map((annotation) =>
            this.renderAnnotationItem(annotation),
          ),
        ),
      );
    }

    return m('.pf-timeline-annotations-tab', children);
  }

  private renderToolbar(count: number): m.Children {
    return m(
      '.pf-timeline-annotations__toolbar.pf-timeline-annotations-toolbar',
      m(
        '.pf-timeline-annotations__group',
        m(Switch, {
          label: 'Drawing mode',
          title: 'Toggle drawing mode (Mod+Shift+D)',
          checked: this.tools.drawingMode,
          onchange: (e: Event) => {
            const target = e.target as HTMLInputElement | null;
            const next =
              target && typeof target.checked === 'boolean'
                ? target.checked
                : !this.tools.drawingMode;
            this.tools.setDrawingMode(next);
          },
        }),
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
              'className': 'pf-timeline-annotations__tool-button',
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
        m(
          ButtonBar,
          m(Button, {
            icon: 'delete_sweep',
            label: 'Clear all',
            title: 'Remove all annotations',
            disabled: count === 0,
            onclick: () => {
              this.pendingClearConfirm = true;
            },
          }),
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
        m(
          '.pf-timeline-annotations-count',
          `${count} annotation${count === 1 ? '' : 's'}`,
        ),
      ),
    );
  }

  private renderDefaultStylePopup(): m.Children {
    const currentColor = this.tools.color;
    const currentFill = this.defaultFillColor;
    const currentOpacity = this.defaultFillOpacity;

    return m(
      Popup,
      {
        fitContent: true,
        position: PopupPosition.Bottom,
        className: 'pf-timeline-annotations__style-popup',
        trigger: m(
          'button.pf-timeline-annotations__color-trigger',
          {
            type: 'button',
            title: 'Default annotation color & fill',
          },
          m('.pf-timeline-annotations__color-preview', {
            style: {
              borderColor: currentColor,
              backgroundColor:
                currentFill === 'transparent'
                  ? 'transparent'
                  : (currentFill ?? currentColor),
              opacity: currentFill === 'transparent' ? 1 : currentOpacity,
            },
          }),
          m(Icon, {icon: 'arrow_drop_down'}),
        ),
      },
      m(
        '.pf-timeline-annotations-style-panel',
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Stroke color'),
          m(ColorSwatches, {
            value: currentColor,
            onChange: (color: string) => {
              this.tools.setColor(color);
            },
          }),
        ),
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Dim / Fill color'),
          m(
            '.pf-timeline-annotations-fill-chips',
            m(Button, {
              compact: true,
              label: 'Match stroke',
              active: currentFill === undefined,
              onclick: () => this.setDefaultFillColor(undefined),
            }),
            m(Button, {
              compact: true,
              label: 'None',
              active: currentFill === 'transparent',
              onclick: () => this.setDefaultFillColor('transparent'),
            }),
          ),
          m(ColorSwatches, {
            value: currentFill ?? currentColor,
            onChange: (color: string) => {
              this.setDefaultFillColor(color);
            },
          }),
          m(
            '.pf-timeline-annotations-slider-row',
            m('span', 'Opacity:'),
            m('input[type=range]', {
              min: 0.05,
              max: 0.8,
              step: 0.05,
              value: currentOpacity,
              oninput: (e: Event) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.setDefaultFillOpacity(val);
              },
            }),
            m(
              'span.pf-timeline-annotations-slider-val',
              `${Math.round(currentOpacity * 100)}%`,
            ),
          ),
        ),
      ),
    );
  }

  private renderAnnotationStylePopup(annotation: Annotation): m.Children {
    const currentColor = annotation.color;
    const currentFill = annotation.fillColor;
    const currentOpacity = annotation.fillOpacity ?? 0.2;

    const sections: m.Children = [
      m(
        '.pf-timeline-annotations-style-section',
        m('span.pf-timeline-annotations__label', 'Stroke color'),
        m(ColorSwatches, {
          value: currentColor,
          onChange: (color: string) => {
            this.store.update(annotation.id, {color});
          },
        }),
      ),
      m(
        '.pf-timeline-annotations-style-section',
        m('span.pf-timeline-annotations__label', 'Dim / Fill color'),
        m(
          '.pf-timeline-annotations-fill-chips',
          m(Button, {
            compact: true,
            label: 'Match stroke',
            active: currentFill === undefined,
            onclick: () => {
              this.store.update(annotation.id, {fillColor: undefined});
            },
          }),
          m(Button, {
            compact: true,
            label: 'None',
            active: currentFill === 'transparent',
            onclick: () => {
              this.store.update(annotation.id, {fillColor: 'transparent'});
            },
          }),
        ),
        m(ColorSwatches, {
          value: currentFill ?? currentColor,
          onChange: (color: string) => {
            this.store.update(annotation.id, {fillColor: color});
          },
        }),
        m(
          '.pf-timeline-annotations-slider-row',
          m('span', 'Opacity:'),
          m('input[type=range]', {
            min: 0.05,
            max: 0.8,
            step: 0.05,
            value: currentOpacity,
            oninput: (e: Event) => {
              const val = parseFloat((e.target as HTMLInputElement).value);
              this.store.update(annotation.id, {fillOpacity: val});
            },
          }),
          m(
            'span.pf-timeline-annotations-slider-val',
            `${Math.round(currentOpacity * 100)}%`,
          ),
        ),
      ),
    ];

    if (annotation.kind === 'label') {
      const currentFamily = annotation.fontFamily ?? 'sans-serif';
      const currentSize = annotation.fontSize ?? 12;
      const currentTextColor = annotation.textColor ?? annotation.color;
      const currentBg = annotation.backgroundColor;

      sections.push(
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Font family'),
          m(
            ButtonGroup,
            (['sans-serif', 'monospace', 'serif'] as const).map(
              (family: LabelFontFamily) => {
                const label =
                  family === 'sans-serif'
                    ? 'Sans'
                    : family === 'monospace'
                      ? 'Mono'
                      : 'Serif';
                return m(Button, {
                  compact: true,
                  label,
                  active: currentFamily === family,
                  onclick: () => {
                    this.store.update(annotation.id, {fontFamily: family});
                  },
                });
              },
            ),
          ),
        ),
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Font size'),
          m(
            ButtonGroup,
            [11, 12, 14, 16, 20, 24].map((size) =>
              m(Button, {
                compact: true,
                label: `${size}`,
                active: currentSize === size,
                onclick: () => {
                  this.store.update(annotation.id, {fontSize: size});
                },
              }),
            ),
          ),
        ),
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Text color'),
          m(Button, {
            compact: true,
            label: 'Auto',
            active: annotation.textColor === undefined,
            onclick: () => {
              this.store.update(annotation.id, {textColor: undefined});
            },
          }),
          m(ColorSwatches, {
            value: currentTextColor,
            onChange: (textColor: string) => {
              this.store.update(annotation.id, {textColor});
            },
          }),
        ),
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Background'),
          m(
            '.pf-timeline-annotations-fill-chips',
            m(Button, {
              compact: true,
              label: 'Tint',
              active: currentBg === undefined,
              onclick: () => {
                this.store.update(annotation.id, {backgroundColor: undefined});
              },
            }),
            m(Button, {
              compact: true,
              label: 'Transparent',
              active: currentBg === 'transparent',
              onclick: () => {
                this.store.update(annotation.id, {
                  backgroundColor: 'transparent',
                });
              },
            }),
          ),
          m(ColorSwatches, {
            value:
              currentBg && currentBg !== 'transparent'
                ? currentBg
                : (annotation.fillColor ?? annotation.color),
            onChange: (backgroundColor: string) => {
              this.store.update(annotation.id, {backgroundColor});
            },
          }),
        ),
      );
    }

    if (annotation.kind === 'arrow') {
      const curVal =
        annotation.controlOffset?.normalPx ?? annotation.curvature ?? 0;
      sections.push(
        m(
          '.pf-timeline-annotations-style-section',
          m('span.pf-timeline-annotations__label', 'Arrow curve'),
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
              oninput: (e: Event) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10);
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

    return m(
      Popup,
      {
        fitContent: true,
        position: PopupPosition.Bottom,
        className: 'pf-timeline-annotations__style-popup',
        trigger: m(
          'button.pf-timeline-annotations__color-trigger',
          {
            type: 'button',
            title: 'Style & color options',
          },
          m('.pf-timeline-annotations__color-preview', {
            style: {
              borderColor: currentColor,
              backgroundColor:
                currentFill === 'transparent'
                  ? 'transparent'
                  : (currentFill ?? currentColor),
              opacity: currentFill === 'transparent' ? 1 : currentOpacity,
            },
          }),
          m(Icon, {icon: 'arrow_drop_down'}),
        ),
      },
      m('.pf-timeline-annotations-style-panel', sections),
    );
  }

  private renderClearConfirmModal(count: number): m.Children {
    return m(
      '.pf-timeline-annotations-clear-overlay',
      {
        onclick: () => {
          this.pendingClearConfirm = false;
        },
      },
      m(
        '.pf-timeline-annotations-clear-dialog',
        {
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
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
              this.pendingClearConfirm = false;
            },
          }),
          m(Button, {
            intent: Intent.Danger,
            variant: ButtonVariant.Filled,
            label: 'Confirm clear',
            onclick: () => {
              this.store.replaceAll([]);
              this.pendingClearConfirm = false;
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
        : !this.knownAnnotationIds.has(annotation.id) &&
          this.tools.tool === 'label';

    if (shouldFocus) {
      requestAnimationFrame(() => {
        const input = dom.querySelector(
          '.pf-timeline-annotations-title-input input, input.pf-timeline-annotations-title-input',
        ) as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.select();
        }
      });
    }
  }

  private renderAnnotationItem(annotation: Annotation): m.Children {
    const isSelected = this.store.selectedId === annotation.id;
    const isHidden = this.store.isHidden(annotation.id);
    const renderInfo = this.overlay.lastRender.get(annotation.id);
    const kindLabel =
      annotation.kind.charAt(0).toUpperCase() + annotation.kind.slice(1);

    return m(
      '.pf-timeline-annotations-item',
      {
        key: annotation.id,
        className: [
          isSelected ? 'pf-timeline-annotations-item--selected' : '',
          isHidden ? 'pf-timeline-annotations-item--hidden' : '',
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
      m(
        Popup,
        {
          fitContent: true,
          position: PopupPosition.BottomStart,
          className: 'pf-timeline-annotations__kind-popup',
          trigger: m(
            'button.pf-timeline-annotations-icon.pf-timeline-annotations-kind-trigger',
            {
              type: 'button',
              title: `${kindLabel} annotation (click to change type)`,
            },
            m(Icon, {icon: getKindIcon(annotation.kind)}),
          ),
        },
        m(
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
        ),
      ),
      m(TextInput, {
        className: 'pf-timeline-annotations-title-input',
        placeholder: annotation.kind,
        value:
          annotation.title ??
          (annotation.kind === 'label' ? annotation.text : ''),
        onInput: (value: string) => {
          if (annotation.kind === 'label') {
            this.store.update(annotation.id, {title: value, text: value});
          } else {
            this.store.update(annotation.id, {title: value});
          }
        },
      }),
      m(TextInput, {
        className: 'pf-timeline-annotations-desc-input',
        placeholder: 'Description',
        value: annotation.description ?? '',
        onInput: (value: string) => {
          this.store.update(annotation.id, {description: value});
        },
      }),
      this.renderAnnotationStylePopup(annotation),
      this.renderBadge(renderInfo),
      m(
        '.pf-timeline-annotations-actions',
        m(Button, {
          icon: 'my_location',
          title: 'Jump to annotation on timeline',
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
            this.store.remove(annotation.id);
          },
        }),
      ),
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
      return m(Chip, {
        className: 'pf-timeline-annotations-badge',
        intent: Intent.Warning,
        compact: true,
        label: 'degraded',
        title: 'Resolved via ancestor track or fuzzy name match',
      });
    }

    if (renderInfo.status === 'unanchored') {
      const missingCount = renderInfo.missing.length;
      const title = `Missing tracks:\n${renderInfo.missing.join('\n')}`;
      return m(Chip, {
        className: 'pf-timeline-annotations-badge',
        intent: Intent.Danger,
        compact: true,
        label: `unanchored: ${missingCount} missing`,
        title,
      });
    }

    return null;
  }

  private jumpTo(annotation: Annotation): void {
    const target = getJumpTarget(annotation, this.store);
    const existingTrackUris = target.trackUris.filter(
      (uri) => this.trace.currentWorkspace?.getTrackByUri?.(uri) !== undefined,
    );
    this.trace.selection?.selectArea?.({
      start: target.start,
      end: target.end,
      trackUris: existingTrackUris,
    });

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
  }
}
