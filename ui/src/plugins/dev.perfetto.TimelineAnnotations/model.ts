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

import {Time, type time} from '../../base/time';
import {
  type ArrowControlOffset,
  type LabelFontFamily,
  type SerializedAnnotation,
  type SerializedAnnotations,
  type SerializedAreaAnchor,
  type SerializedArrowEndpoint,
  type SerializedPoint,
  SERIALIZED_ANNOTATIONS_VERSION,
  parseSerializedAnnotations,
} from './schema';

export type {ArrowControlOffset, LabelFontFamily};

export interface AreaAnchor {
  readonly start: time;
  readonly end: time;
  readonly trackUris: ReadonlyArray<string>;
  readonly trackNames?: ReadonlyArray<string>;
  readonly topYFrac?: number;
  readonly bottomYFrac?: number;
}

export interface AnchoredPoint {
  readonly ts: time;
  readonly trackUri: string;
  readonly trackName?: string;
  readonly yFrac: number;
}

export type ArrowEndpoint =
  | {readonly kind: 'annotation'; readonly id: string}
  | {readonly kind: 'point'; readonly point: AnchoredPoint};

export interface BaseAnnotation {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly color: string;
  readonly fillColor?: string;
  readonly fillOpacity?: number;
  readonly author?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RectAnnotation extends BaseAnnotation {
  readonly kind: 'rect';
  readonly anchor: AreaAnchor;
}

export interface EllipseAnnotation extends BaseAnnotation {
  readonly kind: 'ellipse';
  readonly anchor: AreaAnchor;
}

export interface LabelAnnotation extends BaseAnnotation {
  readonly kind: 'label';
  readonly position: AnchoredPoint;
  readonly text: string;
  readonly fontFamily?: LabelFontFamily;
  readonly fontSize?: number;
  readonly textColor?: string;
  readonly backgroundColor?: string;
}

export interface PathAnnotation extends BaseAnnotation {
  readonly kind: 'path';
  readonly points: ReadonlyArray<AnchoredPoint>;
}

export interface ArrowAnnotation extends BaseAnnotation {
  readonly kind: 'arrow';
  readonly from: ArrowEndpoint;
  readonly to: ArrowEndpoint;
  readonly curvature?: number;
  readonly controlOffset?: ArrowControlOffset;
  readonly controlOffsets?: readonly [ArrowControlOffset, ArrowControlOffset];
}

export type Annotation =
  | RectAnnotation
  | EllipseAnnotation
  | LabelAnnotation
  | PathAnnotation
  | ArrowAnnotation;

export type NewAnnotationInput =
  | (Omit<RectAnnotation, 'id' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<BaseAnnotation, 'id' | 'createdAt' | 'updatedAt'>>)
  | (Omit<EllipseAnnotation, 'id' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<BaseAnnotation, 'id' | 'createdAt' | 'updatedAt'>>)
  | (Omit<LabelAnnotation, 'id' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<BaseAnnotation, 'id' | 'createdAt' | 'updatedAt'>>)
  | (Omit<PathAnnotation, 'id' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<BaseAnnotation, 'id' | 'createdAt' | 'updatedAt'>>)
  | (Omit<ArrowAnnotation, 'id' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<BaseAnnotation, 'id' | 'createdAt' | 'updatedAt'>>);

export function clampArrowControlOffset(
  offset:
    | ArrowControlOffset
    | {
        readonly dxFrac?: number;
        readonly dyPx?: number;
        readonly alongFrac?: number;
        readonly normalPx?: number;
      },
): ArrowControlOffset {
  const o = offset as {
    readonly alongFrac?: number;
    readonly normalPx?: number;
    readonly dxFrac?: number;
    readonly dyPx?: number;
  };
  if (o.dxFrac !== undefined || o.dyPx !== undefined) {
    const dx = Math.max(-2, Math.min(2, o.dxFrac ?? 0));
    const dy = Math.max(-1000, Math.min(1000, o.dyPx ?? 0));
    return {
      alongFrac: dx,
      normalPx: dy,
      dxFrac: dx,
      dyPx: dy,
    } as ArrowControlOffset;
  }
  const along = o.alongFrac ?? 0;
  const normal = o.normalPx ?? 0;
  return {
    alongFrac: Math.max(-2, Math.min(2, along)),
    normalPx: Math.max(-1000, Math.min(1000, normal)),
  };
}

export interface CreateArrowInput extends Omit<
  ArrowAnnotation,
  'id' | 'createdAt' | 'updatedAt'
> {
  readonly id?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly controlOffsets?: readonly [ArrowControlOffset, ArrowControlOffset];
}

export interface UpdateArrowInput extends Partial<
  Omit<
    ArrowAnnotation,
    'kind' | 'id' | 'createdAt' | 'controlOffset' | 'controlOffsets'
  >
> {
  readonly controlOffset?: ArrowControlOffset | null;
  readonly controlOffsets?:
    readonly [ArrowControlOffset, ArrowControlOffset] | null;
}

export function createAnnotation(input: NewAnnotationInput): Annotation {
  const currentTime = Date.now();
  const id = input.id && input.id.length > 0 ? input.id : defaultIdGen();
  const createdAt = input.createdAt ?? currentTime;
  const updatedAt = input.updatedAt ?? currentTime;

  if (input.kind === 'arrow' && input.controlOffsets !== undefined) {
    const clampedOffsets: readonly [ArrowControlOffset, ArrowControlOffset] = [
      clampArrowControlOffset(input.controlOffsets[0]),
      clampArrowControlOffset(input.controlOffsets[1]),
    ];
    return {
      ...input,
      id,
      createdAt,
      updatedAt,
      color: normalizeColor(input.color),
      controlOffsets: clampedOffsets,
    } as Annotation;
  }

  return {
    ...input,
    id,
    createdAt,
    updatedAt,
    color: normalizeColor(input.color),
  } as Annotation;
}

export function updateAnnotation(
  existing: Annotation,
  patch: Partial<Annotation> & {
    readonly controlOffsets?:
      readonly [ArrowControlOffset, ArrowControlOffset] | null;
  },
): Annotation {
  const updated = {
    ...existing,
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
  } as Record<string, unknown>;

  if (existing.kind === 'arrow' || updated.kind === 'arrow') {
    if (patch.controlOffsets === null) {
      delete updated.controlOffsets;
    } else if (patch.controlOffsets !== undefined) {
      updated.controlOffsets = [
        clampArrowControlOffset(patch.controlOffsets[0]),
        clampArrowControlOffset(patch.controlOffsets[1]),
      ];
    }
  }

  return updated as unknown as Annotation;
}

function serializePoint(point: AnchoredPoint): SerializedPoint {
  return {
    ts: point.ts.toString(),
    trackUri: point.trackUri,
    ...(point.trackName !== undefined ? {trackName: point.trackName} : {}),
    yFrac: point.yFrac,
  };
}

function serializeAnchor(anchor: AreaAnchor): SerializedAreaAnchor {
  return {
    start: anchor.start.toString(),
    end: anchor.end.toString(),
    trackUris: [...anchor.trackUris],
    ...(anchor.trackNames !== undefined
      ? {trackNames: [...anchor.trackNames]}
      : {}),
    ...(anchor.topYFrac !== undefined ? {topYFrac: anchor.topYFrac} : {}),
    ...(anchor.bottomYFrac !== undefined
      ? {bottomYFrac: anchor.bottomYFrac}
      : {}),
  };
}

function serializeArrowEndpoint(
  endpoint: ArrowEndpoint,
): SerializedArrowEndpoint {
  if (endpoint.kind === 'annotation') {
    return {
      kind: 'annotation',
      id: endpoint.id,
    };
  }
  return {
    kind: 'point',
    point: serializePoint(endpoint.point),
  };
}

function serializeAnnotation(annotation: Annotation): SerializedAnnotation {
  const base = {
    id: annotation.id,
    ...(annotation.title !== undefined ? {title: annotation.title} : {}),
    ...(annotation.description !== undefined
      ? {description: annotation.description}
      : {}),
    color: annotation.color,
    ...(annotation.fillColor !== undefined
      ? {fillColor: normalizeColor(annotation.fillColor)}
      : {}),
    ...(annotation.fillOpacity !== undefined
      ? {fillOpacity: annotation.fillOpacity}
      : {}),
    ...(annotation.author !== undefined ? {author: annotation.author} : {}),
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
  switch (annotation.kind) {
    case 'rect':
      return {
        ...base,
        kind: 'rect',
        anchor: serializeAnchor(annotation.anchor),
      };
    case 'ellipse':
      return {
        ...base,
        kind: 'ellipse',
        anchor: serializeAnchor(annotation.anchor),
      };
    case 'label':
      return {
        ...base,
        kind: 'label',
        position: serializePoint(annotation.position),
        text: annotation.text,
        ...(annotation.fontFamily !== undefined
          ? {fontFamily: annotation.fontFamily}
          : {}),
        ...(annotation.fontSize !== undefined
          ? {fontSize: annotation.fontSize}
          : {}),
        ...(annotation.textColor !== undefined
          ? {textColor: normalizeColor(annotation.textColor)}
          : {}),
        ...(annotation.backgroundColor !== undefined
          ? {backgroundColor: normalizeColor(annotation.backgroundColor)}
          : {}),
      };
    case 'path':
      return {
        ...base,
        kind: 'path',
        points: annotation.points.map(serializePoint),
      };
    case 'arrow':
      return {
        ...base,
        kind: 'arrow',
        from: serializeArrowEndpoint(annotation.from),
        to: serializeArrowEndpoint(annotation.to),
        ...(annotation.curvature !== undefined
          ? {curvature: annotation.curvature}
          : {}),
        ...(annotation.controlOffset !== undefined
          ? {controlOffset: annotation.controlOffset}
          : {}),
        ...(annotation.controlOffsets !== undefined
          ? {
              controlOffsets: [
                annotation.controlOffsets[0],
                annotation.controlOffsets[1],
              ],
            }
          : {}),
      };
  }
}

export function toSerialized(
  annotations: ReadonlyArray<Annotation>,
): SerializedAnnotations {
  return {
    version: SERIALIZED_ANNOTATIONS_VERSION,
    annotations: annotations.map(serializeAnnotation),
  };
}

function deserializePoint(point: SerializedPoint): AnchoredPoint {
  return {
    ts: Time.fromRaw(BigInt(point.ts)),
    trackUri: point.trackUri,
    ...(point.trackName !== undefined ? {trackName: point.trackName} : {}),
    yFrac: point.yFrac,
  };
}

function deserializeAnchor(anchor: SerializedAreaAnchor): AreaAnchor {
  return {
    start: Time.fromRaw(BigInt(anchor.start)),
    end: Time.fromRaw(BigInt(anchor.end)),
    trackUris: [...anchor.trackUris],
    ...(anchor.trackNames !== undefined
      ? {trackNames: [...anchor.trackNames]}
      : {}),
    ...(anchor.topYFrac !== undefined ? {topYFrac: anchor.topYFrac} : {}),
    ...(anchor.bottomYFrac !== undefined
      ? {bottomYFrac: anchor.bottomYFrac}
      : {}),
  };
}

function deserializeArrowEndpoint(
  endpoint: SerializedArrowEndpoint,
): ArrowEndpoint {
  if (endpoint.kind === 'annotation') {
    return {
      kind: 'annotation',
      id: endpoint.id,
    };
  }
  return {
    kind: 'point',
    point: deserializePoint(endpoint.point),
  };
}

export function normalizeColor(input: string): string {
  if (!input) return '#757575';
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'transparent') {
    return 'transparent';
  }

  const NAMED_COLORS: Record<string, string> = {
    red: '#e53935',
    orange: '#fb8c00',
    yellow: '#fdd835',
    green: '#43a047',
    teal: '#00897b',
    blue: '#1e88e5',
    purple: '#8e24aa',
    grey: '#757575',
    gray: '#757575',
    black: '#000000',
    white: '#ffffff',
    cyan: '#00ffff',
    magenta: '#ff00ff',
  };

  if (NAMED_COLORS[trimmed] !== undefined) {
    return NAMED_COLORS[trimmed];
  }

  // 3-digit hex without #
  if (/^[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[0]}${trimmed[0]}${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}`;
  }

  // 6-digit hex without #
  if (/^[0-9a-f]{6}$/.test(trimmed)) {
    return `#${trimmed}`;
  }

  // 3-digit hex with #
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }

  // 4-digit hex with # (#rgba -> #rrggbb)
  if (/^#[0-9a-f]{4}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }

  // 6-digit hex with #
  if (/^#[0-9a-f]{6}$/.test(trimmed)) {
    return trimmed;
  }

  // 8-digit hex with # (#rrggbbaa -> #rrggbb)
  if (/^#[0-9a-f]{8}$/.test(trimmed)) {
    return trimmed.substring(0, 7);
  }

  // rgb(r, g, b)
  const rgbMatch = trimmed.match(
    /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/,
  );
  if (rgbMatch) {
    const r = Math.min(255, Math.max(0, parseInt(rgbMatch[1], 10)))
      .toString(16)
      .padStart(2, '0');
    const g = Math.min(255, Math.max(0, parseInt(rgbMatch[2], 10)))
      .toString(16)
      .padStart(2, '0');
    const b = Math.min(255, Math.max(0, parseInt(rgbMatch[3], 10)))
      .toString(16)
      .padStart(2, '0');
    return `#${r}${g}${b}`;
  }

  return input;
}

function deserializeAnnotation(annotation: SerializedAnnotation): Annotation {
  const base = {
    id: annotation.id,
    ...(annotation.title !== undefined ? {title: annotation.title} : {}),
    ...(annotation.description !== undefined
      ? {description: annotation.description}
      : {}),
    color: normalizeColor(annotation.color),
    ...(annotation.fillColor !== undefined
      ? {fillColor: normalizeColor(annotation.fillColor)}
      : {}),
    ...(annotation.fillOpacity !== undefined
      ? {fillOpacity: annotation.fillOpacity}
      : {}),
    ...(annotation.author !== undefined ? {author: annotation.author} : {}),
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
  switch (annotation.kind) {
    case 'rect':
      return {
        ...base,
        kind: 'rect',
        anchor: deserializeAnchor(annotation.anchor),
      };
    case 'ellipse':
      return {
        ...base,
        kind: 'ellipse',
        anchor: deserializeAnchor(annotation.anchor),
      };
    case 'label':
      return {
        ...base,
        kind: 'label',
        position: deserializePoint(annotation.position),
        text: annotation.text,
        ...(annotation.fontFamily !== undefined
          ? {fontFamily: annotation.fontFamily}
          : {}),
        ...(annotation.fontSize !== undefined
          ? {fontSize: annotation.fontSize}
          : {}),
        ...(annotation.textColor !== undefined
          ? {textColor: normalizeColor(annotation.textColor)}
          : {}),
        ...(annotation.backgroundColor !== undefined
          ? {backgroundColor: normalizeColor(annotation.backgroundColor)}
          : {}),
      };
    case 'path':
      return {
        ...base,
        kind: 'path',
        points: annotation.points.map(deserializePoint),
      };
    case 'arrow':
      return {
        ...base,
        kind: 'arrow',
        from: deserializeArrowEndpoint(annotation.from),
        to: deserializeArrowEndpoint(annotation.to),
        ...(annotation.curvature !== undefined
          ? {curvature: annotation.curvature}
          : {}),
        ...(annotation.controlOffset !== undefined
          ? {controlOffset: annotation.controlOffset}
          : {}),
        ...(annotation.controlOffsets !== undefined
          ? {
              controlOffsets: [
                annotation.controlOffsets[0],
                annotation.controlOffsets[1],
              ],
            }
          : {}),
      };
  }
}

export function fromSerialized(serialized: unknown): Annotation[] {
  const parsed = parseSerializedAnnotations(serialized);
  return parsed.annotations.map(deserializeAnnotation);
}

let fallbackCounter = 0;
function defaultIdGen(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `annotation_${fallbackCounter}_${Date.now()}`;
}

export interface AnnotationStoreOptions {
  readonly idGen?: () => string;
  readonly now?: () => number;
}

export class AnnotationStore {
  private static readonly MAX_HISTORY = 100;

  private readonly idGen: () => string;
  private readonly now: () => number;
  private readonly annotations = new Map<string, Annotation>();
  private readonly listeners = new Set<(store: AnnotationStore) => void>();
  private readonly undoStack: Array<ReadonlyArray<Annotation>> = [];
  private readonly redoStack: Array<ReadonlyArray<Annotation>> = [];
  private readonly _hidden = new Set<string>();
  private _selectedId: string | undefined = undefined;

  constructor(options?: AnnotationStoreOptions) {
    this.idGen = options?.idGen ?? defaultIdGen;
    this.now = options?.now ?? (() => Date.now());
  }

  list(): ReadonlyArray<Annotation> {
    return Array.from(this.annotations.values());
  }

  get(id: string): Annotation | undefined {
    return this.annotations.get(id);
  }

  add(input: NewAnnotationInput): Annotation {
    const currentTime = this.now();
    const annotationId =
      input.id && input.id.length > 0 ? input.id : this.idGen();
    const createdAt = input.createdAt ?? currentTime;
    const updatedAt = input.updatedAt ?? currentTime;

    if (this.annotations.has(annotationId)) {
      throw new Error(`Annotation with id ${annotationId} already exists`);
    }

    const inputObj = input as unknown as Record<string, unknown>;
    const normalizedFillColor =
      typeof inputObj.fillColor === 'string'
        ? normalizeColor(inputObj.fillColor)
        : undefined;
    const normalizedTextColor =
      typeof inputObj.textColor === 'string'
        ? normalizeColor(inputObj.textColor)
        : undefined;
    const normalizedBackgroundColor =
      typeof inputObj.backgroundColor === 'string'
        ? normalizeColor(inputObj.backgroundColor)
        : undefined;

    let clampedControlOffsets:
      readonly [ArrowControlOffset, ArrowControlOffset] | undefined;
    if (input.kind === 'arrow' && input.controlOffsets !== undefined) {
      clampedControlOffsets = [
        clampArrowControlOffset(input.controlOffsets[0]),
        clampArrowControlOffset(input.controlOffsets[1]),
      ];
    }

    const completeAnnotation = {
      ...input,
      color: normalizeColor(input.color),
      ...(normalizedFillColor !== undefined
        ? {fillColor: normalizedFillColor}
        : {}),
      ...(normalizedTextColor !== undefined
        ? {textColor: normalizedTextColor}
        : {}),
      ...(normalizedBackgroundColor !== undefined
        ? {backgroundColor: normalizedBackgroundColor}
        : {}),
      ...(clampedControlOffsets !== undefined
        ? {controlOffsets: clampedControlOffsets}
        : {}),
      id: annotationId,
      createdAt,
      updatedAt,
    } as Annotation;

    this.pushUndoSnapshot();
    this.annotations.set(annotationId, completeAnnotation);
    this.notifyListeners();
    return completeAnnotation;
  }

  update(
    id: string,
    patch: Partial<Annotation> & {
      readonly controlOffsets?:
        readonly [ArrowControlOffset, ArrowControlOffset] | null;
    },
  ): Annotation | undefined {
    const existing = this.annotations.get(id);
    if (!existing) {
      return undefined;
    }

    const patchObj = patch as Record<string, unknown>;
    const normalizedPatch: Record<string, unknown> = {...patch};

    if (patch.color !== undefined) {
      normalizedPatch.color = normalizeColor(patch.color);
    }
    if ('fillColor' in patchObj) {
      normalizedPatch.fillColor =
        typeof patchObj.fillColor === 'string'
          ? normalizeColor(patchObj.fillColor)
          : undefined;
    }
    if ('textColor' in patchObj) {
      normalizedPatch.textColor =
        typeof patchObj.textColor === 'string'
          ? normalizeColor(patchObj.textColor)
          : undefined;
    }
    if ('backgroundColor' in patchObj) {
      normalizedPatch.backgroundColor =
        typeof patchObj.backgroundColor === 'string'
          ? normalizeColor(patchObj.backgroundColor)
          : undefined;
    }
    if ('controlOffsets' in patchObj) {
      if (patchObj.controlOffsets === null) {
        delete normalizedPatch.controlOffsets;
      } else if (patchObj.controlOffsets !== undefined) {
        const offsets = patchObj.controlOffsets as [
          ArrowControlOffset,
          ArrowControlOffset,
        ];
        normalizedPatch.controlOffsets = [
          clampArrowControlOffset(offsets[0]),
          clampArrowControlOffset(offsets[1]),
        ];
      }
    }

    this.pushUndoSnapshot();
    const updated = {
      ...existing,
      ...normalizedPatch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? this.now(),
    } as Record<string, unknown>;

    for (const key of Object.keys(normalizedPatch)) {
      if (normalizedPatch[key] === undefined) {
        delete updated[key];
      }
    }
    if ('controlOffsets' in patchObj && patchObj.controlOffsets === null) {
      delete updated.controlOffsets;
    }

    const finalAnnotation = updated as unknown as Annotation;
    this.annotations.set(id, finalAnnotation);
    this.notifyListeners();
    return finalAnnotation;
  }

  remove(id: string): boolean {
    if (!this.annotations.has(id)) {
      return false;
    }

    this.pushUndoSnapshot();
    this.annotations.delete(id);
    if (this._selectedId === id) {
      this._selectedId = undefined;
    }
    this._hidden.delete(id);

    // Cascades to arrows referencing it
    for (const [key, candidate] of this.annotations.entries()) {
      if (candidate.kind === 'arrow') {
        const referencesTarget =
          (candidate.from.kind === 'annotation' && candidate.from.id === id) ||
          (candidate.to.kind === 'annotation' && candidate.to.id === id);
        if (referencesTarget) {
          this.annotations.delete(key);
          if (this._selectedId === key) {
            this._selectedId = undefined;
          }
          this._hidden.delete(key);
        }
      }
    }

    this.notifyListeners();
    return true;
  }

  changeKind(id: string, newKind: Annotation['kind']): Annotation | undefined {
    const existing = this.annotations.get(id);
    if (!existing) {
      return undefined;
    }
    if (existing.kind === newKind) {
      return existing;
    }

    this.pushUndoSnapshot();

    const bounds = this.computeSpatialBounds(existing);
    const baseFields = {
      id: existing.id,
      ...(existing.title !== undefined ? {title: existing.title} : {}),
      ...(existing.description !== undefined
        ? {description: existing.description}
        : {}),
      color: existing.color,
      ...(existing.fillColor !== undefined
        ? {fillColor: existing.fillColor}
        : {}),
      ...(existing.fillOpacity !== undefined
        ? {fillOpacity: existing.fillOpacity}
        : {}),
      ...(existing.author !== undefined ? {author: existing.author} : {}),
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };

    let converted: Annotation;
    switch (newKind) {
      case 'rect':
        converted = {
          ...baseFields,
          kind: 'rect',
          anchor: {
            start: bounds.start,
            end: bounds.end,
            trackUris: bounds.trackUris,
            ...(bounds.trackNames ? {trackNames: bounds.trackNames} : {}),
          },
        };
        break;
      case 'ellipse':
        converted = {
          ...baseFields,
          kind: 'ellipse',
          anchor: {
            start: bounds.start,
            end: bounds.end,
            trackUris: bounds.trackUris,
            ...(bounds.trackNames ? {trackNames: bounds.trackNames} : {}),
          },
        };
        break;
      case 'label':
        converted = {
          ...baseFields,
          kind: 'label',
          position: bounds.startPoint,
          text:
            existing.title ??
            (existing.kind === 'label' ? existing.text : 'Label'),
        };
        break;
      case 'arrow':
        converted = {
          ...baseFields,
          kind: 'arrow',
          from: {kind: 'point', point: bounds.startPoint},
          to: {kind: 'point', point: bounds.endPoint},
        };
        break;
      case 'path':
        converted = {
          ...baseFields,
          kind: 'path',
          points: [bounds.startPoint, bounds.endPoint],
        };
        break;
    }

    this.annotations.set(id, converted);
    this.notifyListeners();
    return converted;
  }

  private computeSpatialBounds(
    existing: Annotation,
    visited = new Set<string>(),
  ): {
    start: time;
    end: time;
    trackUris: string[];
    trackNames?: string[];
    startPoint: AnchoredPoint;
    endPoint: AnchoredPoint;
  } {
    switch (existing.kind) {
      case 'rect':
      case 'ellipse': {
        const start = existing.anchor.start;
        const end = existing.anchor.end;
        const trackUris = [...existing.anchor.trackUris];
        const trackNames = existing.anchor.trackNames
          ? [...existing.anchor.trackNames]
          : undefined;
        const firstUri = trackUris[0] ?? 'unknown';
        const lastUri = trackUris[trackUris.length - 1] ?? firstUri;
        const firstName = trackNames?.[0];
        const lastName = trackNames?.[trackNames.length - 1] ?? firstName;
        const startPoint: AnchoredPoint = {
          ts: start,
          trackUri: firstUri,
          ...(firstName ? {trackName: firstName} : {}),
          yFrac: 0.5,
        };
        const endTs =
          end > start ? end : Time.add(start, Time.fromRaw(10_000_000n));
        const endPoint: AnchoredPoint = {
          ts: endTs,
          trackUri: lastUri,
          ...(lastName ? {trackName: lastName} : {}),
          yFrac: 0.5,
        };
        return {
          start,
          end: endTs,
          trackUris,
          trackNames,
          startPoint,
          endPoint,
        };
      }
      case 'label': {
        const startPoint = existing.position;
        const start = existing.position.ts;
        const end = Time.add(start, Time.fromRaw(10_000_000n));
        const trackUris = [existing.position.trackUri];
        const trackNames = existing.position.trackName
          ? [existing.position.trackName]
          : undefined;
        const endPoint: AnchoredPoint = {
          ...existing.position,
          ts: end,
        };
        return {
          start,
          end,
          trackUris,
          trackNames,
          startPoint,
          endPoint,
        };
      }
      case 'path': {
        if (existing.points.length === 0) {
          const start = Time.fromRaw(0n);
          const end = Time.fromRaw(10_000_000n);
          const trackUris = ['unknown'];
          const startPoint: AnchoredPoint = {
            ts: start,
            trackUri: 'unknown',
            yFrac: 0.5,
          };
          const endPoint: AnchoredPoint = {
            ts: end,
            trackUri: 'unknown',
            yFrac: 0.5,
          };
          return {start, end, trackUris, startPoint, endPoint};
        }
        let minTs = existing.points[0].ts;
        let maxTs = existing.points[0].ts;
        const trackUriSet = new Set<string>();
        const trackUris: string[] = [];
        const trackNameMap = new Map<string, string>();

        for (const pt of existing.points) {
          if (pt.ts < minTs) minTs = pt.ts;
          if (pt.ts > maxTs) maxTs = pt.ts;
          if (!trackUriSet.has(pt.trackUri)) {
            trackUriSet.add(pt.trackUri);
            trackUris.push(pt.trackUri);
          }
          if (pt.trackName !== undefined && !trackNameMap.has(pt.trackUri)) {
            trackNameMap.set(pt.trackUri, pt.trackName);
          }
        }
        const start = minTs;
        const end =
          maxTs > minTs ? maxTs : Time.add(minTs, Time.fromRaw(10_000_000n));
        const startPoint = existing.points[0];
        const endPoint = existing.points[existing.points.length - 1];
        const hasTrackNames = trackUris.some((uri) => trackNameMap.has(uri));
        const trackNames = hasTrackNames
          ? trackUris.map((uri) => trackNameMap.get(uri) ?? '')
          : undefined;
        return {start, end, trackUris, trackNames, startPoint, endPoint};
      }
      case 'arrow': {
        const resolveEndpoint = (
          ep: ArrowEndpoint,
          visitedIds: Set<string>,
        ): AnchoredPoint => {
          if (ep.kind === 'point') {
            return ep.point;
          }
          if (visitedIds.has(ep.id)) {
            return {ts: Time.fromRaw(0n), trackUri: 'unknown', yFrac: 0.5};
          }
          const target = this.get(ep.id);
          if (!target) {
            return {ts: Time.fromRaw(0n), trackUri: 'unknown', yFrac: 0.5};
          }
          const nextVisited = new Set(visitedIds);
          nextVisited.add(ep.id);
          return this.computeSpatialBounds(target, nextVisited).startPoint;
        };

        const fromPt = resolveEndpoint(existing.from, visited);
        const toPt = resolveEndpoint(existing.to, visited);
        const minTs = Time.min(fromPt.ts, toPt.ts);
        const maxTs = Time.max(fromPt.ts, toPt.ts);
        const start = minTs;
        const end =
          maxTs > start ? maxTs : Time.add(start, Time.fromRaw(10_000_000n));
        const trackUris = Array.from(new Set([fromPt.trackUri, toPt.trackUri]));
        const trackNamesList: string[] = [];
        if (fromPt.trackName) trackNamesList.push(fromPt.trackName);
        if (toPt.trackName && toPt.trackName !== fromPt.trackName) {
          trackNamesList.push(toPt.trackName);
        }
        const trackNames =
          trackNamesList.length > 0 ? trackNamesList : undefined;
        const startPoint = fromPt;
        const endPoint =
          toPt.ts === fromPt.ts && toPt.trackUri === fromPt.trackUri
            ? {...toPt, ts: end}
            : toPt;
        return {start, end, trackUris, trackNames, startPoint, endPoint};
      }
    }
  }

  replaceAll(list: ReadonlyArray<Annotation>): void {
    this.pushUndoSnapshot();
    this.annotations.clear();
    for (const annotation of list) {
      this.annotations.set(annotation.id, annotation);
    }
    if (this._selectedId && !this.annotations.has(this._selectedId)) {
      this._selectedId = undefined;
    }
    this.notifyListeners();
  }

  mergeImport(list: ReadonlyArray<Annotation>): {
    added: number;
    updated: number;
    skipped: number;
  } {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const toApply: Annotation[] = [];

    for (const incoming of list) {
      const existing = this.annotations.get(incoming.id);
      if (!existing) {
        toApply.push(incoming);
        added += 1;
      } else if (incoming.updatedAt > existing.updatedAt) {
        toApply.push(incoming);
        updated += 1;
      } else {
        // Equal or older updatedAt: keep existing
        skipped += 1;
      }
    }

    if (added > 0 || updated > 0) {
      this.pushUndoSnapshot();
      for (const item of toApply) {
        this.annotations.set(item.id, item);
      }
      this.notifyListeners();
    }

    return {added, updated, skipped};
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    if (this.undoStack.length === 0) {
      return false;
    }
    const previousSnapshot = this.undoStack.pop()!;
    this.redoStack.push(this.list());
    this.restoreSnapshot(previousSnapshot);
    this.notifyListeners();
    return true;
  }

  redo(): boolean {
    if (this.redoStack.length === 0) {
      return false;
    }
    const nextSnapshot = this.redoStack.pop()!;
    this.undoStack.push(this.list());
    this.restoreSnapshot(nextSnapshot);
    this.notifyListeners();
    return true;
  }

  onChange(callback: (store: AnnotationStore) => void): Disposable {
    this.listeners.add(callback);
    return {
      [Symbol.dispose]: () => {
        this.listeners.delete(callback);
      },
    };
  }

  get selectedId(): string | undefined {
    return this._selectedId;
  }

  select(id: string | undefined): void {
    if (this._selectedId !== id) {
      this._selectedId = id;
      this.notifyListeners();
    }
  }

  get hidden(): ReadonlySet<string> {
    return new Set(this._hidden);
  }

  isHidden(id: string): boolean {
    return this._hidden.has(id);
  }

  setHidden(id: string, isHiddenState: boolean): void {
    const wasHidden = this._hidden.has(id);
    if (isHiddenState) {
      this._hidden.add(id);
    } else {
      this._hidden.delete(id);
    }
    if (wasHidden !== isHiddenState) {
      this.notifyListeners();
    }
  }

  toggleHidden(id: string): boolean {
    const newState = !this._hidden.has(id);
    this.setHidden(id, newState);
    return newState;
  }

  private pushUndoSnapshot(): void {
    this.undoStack.push(this.list());
    if (this.undoStack.length > AnnotationStore.MAX_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  private restoreSnapshot(snapshot: ReadonlyArray<Annotation>): void {
    this.annotations.clear();
    for (const annotation of snapshot) {
      this.annotations.set(annotation.id, annotation);
    }
    if (this._selectedId && !this.annotations.has(this._selectedId)) {
      this._selectedId = undefined;
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this);
    }
  }
}
