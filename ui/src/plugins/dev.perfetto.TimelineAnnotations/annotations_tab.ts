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
import {Switch} from '../../widgets/switch';
import {TextInput} from '../../widgets/text_input';
import {Chip} from '../../widgets/chip';
import {Intent} from '../../widgets/common';
import {type Annotation, type AnnotationStore, normalizeColor} from './model';
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

    const children: m.Children = [this.renderToolbar(annotations.length)];
    if (this.pendingClearConfirm) {
      children.push(this.renderClearConfirmBanner());
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
          onchange: () => {
            this.tools.toggleDrawingMode();
          },
        }),
      ),
      m(
        '.pf-timeline-annotations__group',
        m('span.pf-timeline-annotations__label', 'Tool:'),
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
                this.tools.setTool(toolKind);
              },
            });
          }),
        ),
      ),
      m(
        '.pf-timeline-annotations__group',
        m(ColorSwatches, {
          label: 'New annotation color:',
          tooltip: 'Color used for annotations you create next',
          value: this.tools.color,
          onChange: (color: string) => {
            this.tools.setColor(color);
          },
        }),
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
            icon: 'file_download',
            label: 'Export',
            title: 'Export annotations to JSON',
            onclick: () => {
              exportAnnotations(this.trace, this.store);
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
            icon: 'delete_sweep',
            label: 'Clear all',
            title: 'Remove all annotations',
            disabled: count === 0,
            onclick: () => {
              this.pendingClearConfirm = true;
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

  private renderClearConfirmBanner(): m.Children {
    return m(
      '.pf-timeline-annotations-confirm-banner',
      m('span', 'Are you sure you want to clear all annotations?'),
      m(
        ButtonBar,
        m(Button, {
          intent: Intent.Danger,
          label: 'Confirm clear',
          onclick: () => {
            this.store.replaceAll([]);
            this.pendingClearConfirm = false;
          },
        }),
        m(Button, {
          label: 'Cancel',
          onclick: () => {
            this.pendingClearConfirm = false;
          },
        }),
      ),
    );
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
      },
      m(
        '.pf-timeline-annotations-icon',
        {title: `${kindLabel} annotation`},
        m(Icon, {icon: getKindIcon(annotation.kind)}),
      ),
      m(TextInput, {
        className: 'pf-timeline-annotations-title-input',
        placeholder: annotation.kind,
        value: annotation.title ?? '',
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
      m(ColorSwatches, {
        value: annotation.color,
        onChange: (color: string) => {
          this.store.update(annotation.id, {color});
        },
      }),
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
      (uri) => this.trace.currentWorkspace.getTrackByUri(uri) !== undefined,
    );
    this.trace.selection.selectArea({
      start: target.start,
      end: target.end,
      trackUris: existingTrackUris,
    });

    if (typeof this.trace.scrollTo === 'function') {
      this.trace.scrollTo({
        time: {
          start: target.start,
          end: target.end,
          behavior: 'focus',
        },
      });
    }
  }
}
