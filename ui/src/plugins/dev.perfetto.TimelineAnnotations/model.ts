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
  type SerializedAnnotation,
  type SerializedAnnotations,
  type SerializedAreaAnchor,
  type SerializedArrowEndpoint,
  type SerializedPoint,
  SERIALIZED_ANNOTATIONS_VERSION,
  parseSerializedAnnotations,
} from './schema';

export interface AreaAnchor {
  readonly start: time;
  readonly end: time;
  readonly trackUris: ReadonlyArray<string>;
  readonly trackNames?: ReadonlyArray<string>;
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
}

export interface PathAnnotation extends BaseAnnotation {
  readonly kind: 'path';
  readonly points: ReadonlyArray<AnchoredPoint>;
}

export interface ArrowAnnotation extends BaseAnnotation {
  readonly kind: 'arrow';
  readonly from: ArrowEndpoint;
  readonly to: ArrowEndpoint;
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

function deserializeAnnotation(annotation: SerializedAnnotation): Annotation {
  const base = {
    id: annotation.id,
    ...(annotation.title !== undefined ? {title: annotation.title} : {}),
    ...(annotation.description !== undefined
      ? {description: annotation.description}
      : {}),
    color: annotation.color,
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

    const completeAnnotation = {
      ...input,
      id: annotationId,
      createdAt,
      updatedAt,
    } as Annotation;

    this.pushUndoSnapshot();
    this.annotations.set(annotationId, completeAnnotation);
    this.notifyListeners();
    return completeAnnotation;
  }

  update(id: string, patch: Partial<Annotation>): Annotation | undefined {
    const existing = this.annotations.get(id);
    if (!existing) {
      return undefined;
    }

    this.pushUndoSnapshot();
    const updated = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? this.now(),
    } as Annotation;

    this.annotations.set(id, updated);
    this.notifyListeners();
    return updated;
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
