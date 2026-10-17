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
import type {Trace} from '../../public/trace';
import {TrackNode} from '../../public/workspace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, STR} from '../../trace_processor/query_result';
import {SliceTrack} from '../../components/tracks/slice_track';
import {getColorForSlice} from '../../components/colorizer';
import type {Annotation, AnnotationStore, ArrowEndpoint} from './model';

export const ANNOTATION_TRACK_URI = 'dev.perfetto.TimelineAnnotations#track';

export interface AnnotationRow {
  readonly id: string;
  readonly ts: bigint;
  readonly dur: bigint;
  readonly name: string;
  readonly kind: string;
  readonly color: string;
  readonly description: string;
}

export function escapeSqlString(text: string): string {
  const escaped = text.replace(/'/g, "''");
  return `'${escaped}'`;
}

interface EndpointRange {
  readonly start: bigint;
  readonly end: bigint;
}

function resolveEndpointRange(
  endpoint: ArrowEndpoint,
  resolver?: (id: string) => Annotation | undefined,
  visited: Set<string> = new Set(),
): EndpointRange | undefined {
  if (endpoint.kind === 'point') {
    return {
      start: endpoint.point.ts,
      end: endpoint.point.ts,
    };
  }

  if (visited.has(endpoint.id)) {
    return undefined;
  }
  visited.add(endpoint.id);

  const target = resolver?.(endpoint.id);
  if (!target) {
    return undefined;
  }

  const row = annotationToRow(target, resolver, visited);
  return {
    start: row.ts,
    end: row.ts + row.dur,
  };
}

export function annotationToRow(
  annotation: Annotation,
  resolver?: (id: string) => Annotation | undefined,
  visited: Set<string> = new Set(),
): AnnotationRow {
  visited.add(annotation.id);
  const id = annotation.id;
  const kind = annotation.kind;
  const color = annotation.color;
  const description = annotation.description ?? '';

  switch (annotation.kind) {
    case 'rect':
    case 'ellipse': {
      const start = annotation.anchor.start;
      const end = annotation.anchor.end;
      const dur = end >= start ? end - start : 0n;
      const name = annotation.title ?? kind;
      return {id, ts: start, dur, name, kind, color, description};
    }
    case 'label': {
      const start = annotation.position.ts;
      const dur = 0n;
      const name = annotation.title ?? (annotation.text || 'label');
      const resolvedDesc = annotation.description ?? annotation.text;
      return {
        id,
        ts: start,
        dur,
        name,
        kind,
        color,
        description: resolvedDesc,
      };
    }
    case 'path': {
      const points = annotation.points;
      if (points.length === 0) {
        const name = annotation.title ?? 'path';
        return {id, ts: 0n, dur: 0n, name, kind, color, description};
      }
      let minTs = points[0].ts;
      let maxTs = points[0].ts;
      for (let index = 1; index < points.length; index += 1) {
        const pointTs = points[index].ts;
        if (pointTs < minTs) minTs = pointTs;
        if (pointTs > maxTs) maxTs = pointTs;
      }
      const dur = maxTs >= minTs ? maxTs - minTs : 0n;
      const name = annotation.title ?? 'path';
      return {id, ts: minTs, dur, name, kind, color, description};
    }
    case 'arrow': {
      const fromRange = resolveEndpointRange(
        annotation.from,
        resolver,
        visited,
      );
      const toRange = resolveEndpointRange(annotation.to, resolver, visited);
      let start = 0n;
      let dur = 0n;

      if (fromRange !== undefined && toRange !== undefined) {
        const minTs =
          fromRange.start < toRange.start ? fromRange.start : toRange.start;
        const maxTs = fromRange.end > toRange.end ? fromRange.end : toRange.end;
        start = minTs;
        dur = maxTs >= minTs ? maxTs - minTs : 0n;
      } else if (fromRange !== undefined) {
        start = fromRange.start;
        dur =
          fromRange.end >= fromRange.start ? fromRange.end - fromRange.start : 0n;
      } else if (toRange !== undefined) {
        start = toRange.start;
        dur = toRange.end >= toRange.start ? toRange.end - toRange.start : 0n;
      }

      const name = annotation.title ?? 'arrow';
      return {id, ts: start, dur, name, kind, color, description};
    }
  }
}

export class AnnotationTrack {
  private readonly trace: Trace;
  private readonly store: AnnotationStore;
  private version = 0;
  private syncPromise = Promise.resolve();
  private storeSubscription?: Disposable;
  private isDisposed = false;

  constructor(trace: Trace, store: AnnotationStore) {
    this.trace = trace;
    this.store = store;
  }

  async init(): Promise<void> {
    await this.trace.engine.query(`
      CREATE TABLE IF NOT EXISTS __timeline_annotations (
        id TEXT,
        ts INT64,
        dur INT64,
        name TEXT,
        kind TEXT,
        color TEXT,
        description TEXT
      );
    `);

    const dataset = () =>
      new SourceDataset({
        src: `SELECT rowid AS id, ts, dur, name, kind, color, description, id AS annotation_id FROM __timeline_annotations /* v${this.version} */`,
        schema: {
          id: NUM,
          ts: LONG,
          dur: LONG,
          name: STR,
          kind: STR,
          color: STR,
          description: STR,
        },
      });

    const sliceTrack = SliceTrack.create({
      trace: this.trace,
      uri: ANNOTATION_TRACK_URI,
      dataset,
      getKey: () => String(this.version),
      colorizer: (row) => getColorForSlice(row.color || row.name),
      detailsPanel: (row) => ({
        render: () =>
          m(
            '.pf-timeline-annotations-details',
            m('h2', row.name),
            m('p', m('strong', 'Kind: '), row.kind),
            row.description
              ? m('p', m('strong', 'Description: '), row.description)
              : null,
            m('p', m('strong', 'Color: '), row.color),
          ),
      }),
    });

    this.trace.tracks.registerTrack({
      uri: ANNOTATION_TRACK_URI,
      renderer: sliceTrack,
    });

    const trackNode = new TrackNode({
      uri: ANNOTATION_TRACK_URI,
      name: 'Annotations',
      sortOrder: -100,
    });

    this.trace.defaultWorkspace.addChildInOrder(trackNode);
    if (this.trace.currentWorkspace !== this.trace.defaultWorkspace) {
      const currentWorkspaceNode = new TrackNode({
        uri: ANNOTATION_TRACK_URI,
        name: 'Annotations',
        sortOrder: -100,
      });
      this.trace.currentWorkspace.addChildInOrder(currentWorkspaceNode);
    }

    this.storeSubscription = this.store.onChange(() => {
      this.queueSync();
    });

    await this.queueSync();
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.storeSubscription !== undefined) {
      this.storeSubscription[Symbol.dispose]();
      this.storeSubscription = undefined;
    }
  }

  private queueSync(): Promise<void> {
    this.syncPromise = this.syncPromise
      .then(async () => {
        if (this.isDisposed) return;
        await this.syncToTable();
      })
      .catch((err) => {
        console.warn('Failed to sync annotations to table:', err);
      });
    return this.syncPromise;
  }

  private async syncToTable(): Promise<void> {
    await this.trace.engine.query('DELETE FROM __timeline_annotations;');
    if (this.isDisposed) return;

    const annotations = this.store.list();
    if (annotations.length > 0) {
      const resolver = (lookupId: string) => this.store.get(lookupId);
      const rows = annotations.map((annotation) =>
        annotationToRow(annotation, resolver),
      );

      const batchSize = 100;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const valueClauses = batch.map(
          (row) =>
            `(${escapeSqlString(row.id)}, ${row.ts.toString()}, ${row.dur.toString()}, ${escapeSqlString(row.name)}, ${escapeSqlString(row.kind)}, ${escapeSqlString(row.color)}, ${escapeSqlString(row.description)})`,
        );

        const sql = `INSERT INTO __timeline_annotations (id, ts, dur, name, kind, color, description) VALUES ${valueClauses.join(', ')};`;
        await this.trace.engine.query(sql);
        if (this.isDisposed) return;
      }
    }

    if (this.isDisposed) return;
    this.version += 1;
    this.trace.raf.scheduleFullRedraw();
  }
}
