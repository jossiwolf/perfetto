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

import {describe, expect, test, vi} from 'vitest';
import type {Trace} from '../../public/trace';
import {Time} from '../../base/time';
import {
  type ArrowAnnotation,
  type EllipseAnnotation,
  type LabelAnnotation,
  type PathAnnotation,
  type RectAnnotation,
  AnnotationStore,
} from './model';
import {
  AnnotationTrack,
  annotationToRow,
  escapeSqlString,
  getAnnotationColorScheme,
} from './annotation_track';

describe('annotation_track', () => {
  describe('escapeSqlString', () => {
    test('escapes plain string', () => {
      expect(escapeSqlString('hello')).toBe("'hello'");
    });

    test('escapes string with single quote', () => {
      expect(escapeSqlString("it's a test")).toBe("'it''s a test'");
    });

    test('escapes string with multiple single quotes', () => {
      expect(escapeSqlString("don't won't can't")).toBe(
        "'don''t won''t can''t'",
      );
    });

    test('escapes empty string', () => {
      expect(escapeSqlString('')).toBe("''");
    });

    test('escapes quotes only', () => {
      expect(escapeSqlString("'''")).toBe("''''''''");
    });
  });

  describe('getAnnotationColorScheme', () => {
    test('uses row color to create matching color scheme', () => {
      const scheme = getAnnotationColorScheme({
        name: 'test slice',
        color: '#e53935',
      });
      expect(scheme.base.cssString).toBe('rgb(229 57 53)');
    });

    test('falls back to slice name hashing when color is empty', () => {
      const scheme = getAnnotationColorScheme({name: 'fallback slice'});
      expect(scheme.base.cssString).toBeDefined();
    });
  });

  describe('annotationToRow', () => {
    test('converts rect annotation with title and description', () => {
      const rectAnnotation: RectAnnotation = {
        id: 'rect_1',
        kind: 'rect',
        title: 'CPU Spike',
        description: 'High utilisation observed',
        color: '#ff5722',
        anchor: {
          start: Time.fromRaw(1000n),
          end: Time.fromRaw(2500n),
          trackUris: ['track_cpu_0'],
        },
        createdAt: 100,
        updatedAt: 200,
      };

      const row = annotationToRow(rectAnnotation);
      expect(row.id).toBe('rect_1');
      expect(row.ts).toBe(1000n);
      expect(row.dur).toBe(1500n);
      expect(row.name).toBe('CPU Spike');
      expect(row.kind).toBe('rect');
      expect(row.color).toBe('#ff5722');
      expect(row.description).toBe('High utilisation observed');
    });

    test('converts ellipse annotation fallback name', () => {
      const ellipseAnnotation: EllipseAnnotation = {
        id: 'ellipse_1',
        kind: 'ellipse',
        color: '#4caf50',
        anchor: {
          start: Time.fromRaw(5000n),
          end: Time.fromRaw(7000n),
          trackUris: ['track_gpu'],
        },
        createdAt: 100,
        updatedAt: 100,
      };

      const row = annotationToRow(ellipseAnnotation);
      expect(row.id).toBe('ellipse_1');
      expect(row.ts).toBe(5000n);
      expect(row.dur).toBe(2000n);
      expect(row.name).toBe('ellipse');
      expect(row.kind).toBe('ellipse');
      expect(row.color).toBe('#4caf50');
      expect(row.description).toBe('');
    });

    test('converts label annotation to instant duration 0', () => {
      const labelAnnotation: LabelAnnotation = {
        id: 'label_1',
        kind: 'label',
        color: '#2196f3',
        position: {
          ts: Time.fromRaw(3300n),
          trackUri: 'track_main',
          yFrac: 0.4,
        },
        text: 'Marker point',
        createdAt: 100,
        updatedAt: 100,
      };

      const row = annotationToRow(labelAnnotation);
      expect(row.id).toBe('label_1');
      expect(row.ts).toBe(3300n);
      expect(row.dur).toBe(0n);
      expect(row.name).toBe('Marker point');
      expect(row.kind).toBe('label');
      expect(row.description).toBe('Marker point');
    });

    test('converts path annotation to span of its points', () => {
      const pathAnnotation: PathAnnotation = {
        id: 'path_1',
        kind: 'path',
        title: 'Gesture trace',
        color: '#9c27b0',
        points: [
          {ts: Time.fromRaw(3000n), trackUri: 'track_1', yFrac: 0.1},
          {ts: Time.fromRaw(1500n), trackUri: 'track_1', yFrac: 0.2},
          {ts: Time.fromRaw(4500n), trackUri: 'track_1', yFrac: 0.3},
          {ts: Time.fromRaw(2000n), trackUri: 'track_1', yFrac: 0.4},
        ],
        createdAt: 100,
        updatedAt: 100,
      };

      const row = annotationToRow(pathAnnotation);
      expect(row.id).toBe('path_1');
      expect(row.ts).toBe(1500n);
      expect(row.dur).toBe(3000n);
      expect(row.name).toBe('Gesture trace');
      expect(row.kind).toBe('path');
    });

    test('converts empty path annotation gracefully', () => {
      const emptyPath: PathAnnotation = {
        id: 'path_empty',
        kind: 'path',
        color: '#9c27b0',
        points: [],
        createdAt: 100,
        updatedAt: 100,
      };

      const row = annotationToRow(emptyPath);
      expect(row.ts).toBe(0n);
      expect(row.dur).toBe(0n);
      expect(row.name).toBe('path');
    });

    test('converts arrow annotation with point endpoints', () => {
      const arrowAnnotation: ArrowAnnotation = {
        id: 'arrow_1',
        kind: 'arrow',
        color: '#ff9800',
        from: {
          kind: 'point',
          point: {ts: Time.fromRaw(2000n), trackUri: 'track_1', yFrac: 0.5},
        },
        to: {
          kind: 'point',
          point: {ts: Time.fromRaw(6000n), trackUri: 'track_2', yFrac: 0.5},
        },
        createdAt: 100,
        updatedAt: 100,
      };

      const row = annotationToRow(arrowAnnotation);
      expect(row.id).toBe('arrow_1');
      expect(row.ts).toBe(2000n);
      expect(row.dur).toBe(4000n);
      expect(row.name).toBe('arrow');
      expect(row.kind).toBe('arrow');
    });

    test('converts arrow annotation referencing other annotations', () => {
      const targetRect: RectAnnotation = {
        id: 'rect_target',
        kind: 'rect',
        color: '#ff5722',
        anchor: {
          start: Time.fromRaw(1000n),
          end: Time.fromRaw(2500n),
          trackUris: ['track_1'],
        },
        createdAt: 100,
        updatedAt: 100,
      };

      const arrowAnnotation: ArrowAnnotation = {
        id: 'arrow_rel',
        kind: 'arrow',
        color: '#ff9800',
        from: {
          kind: 'annotation',
          id: 'rect_target',
        },
        to: {
          kind: 'point',
          point: {ts: Time.fromRaw(8000n), trackUri: 'track_2', yFrac: 0.5},
        },
        createdAt: 100,
        updatedAt: 100,
      };

      const resolver = (lookupId: string) => {
        if (lookupId === 'rect_target') return targetRect;
        return undefined;
      };

      const row = annotationToRow(arrowAnnotation, resolver);
      expect(row.ts).toBe(1000n);
      expect(row.dur).toBe(7000n);
    });

    test('converts arrow annotation with unresolvable endpoints', () => {
      const arrowAnnotation: ArrowAnnotation = {
        id: 'arrow_orphan',
        kind: 'arrow',
        color: '#ff9800',
        from: {
          kind: 'annotation',
          id: 'missing_1',
        },
        to: {
          kind: 'annotation',
          id: 'missing_2',
        },
        createdAt: 100,
        updatedAt: 100,
      };

      const row = annotationToRow(arrowAnnotation, () => undefined);
      expect(row.ts).toBe(0n);
      expect(row.dur).toBe(0n);
    });

    test('handles mutual arrow reference cycle gracefully without infinite recursion', () => {
      const arrowA: ArrowAnnotation = {
        id: 'arrow_a',
        kind: 'arrow',
        color: '#ff0000',
        from: {
          kind: 'point',
          point: {ts: Time.fromRaw(100n), trackUri: 't1', yFrac: 0.5},
        },
        to: {kind: 'annotation', id: 'arrow_b'},
        createdAt: 100,
        updatedAt: 100,
      };

      const arrowB: ArrowAnnotation = {
        id: 'arrow_b',
        kind: 'arrow',
        color: '#00ff00',
        from: {kind: 'annotation', id: 'arrow_a'},
        to: {
          kind: 'point',
          point: {ts: Time.fromRaw(500n), trackUri: 't2', yFrac: 0.5},
        },
        createdAt: 100,
        updatedAt: 100,
      };

      const resolver = (id: string) => {
        if (id === 'arrow_a') return arrowA;
        if (id === 'arrow_b') return arrowB;
        return undefined;
      };

      const rowA = annotationToRow(arrowA, resolver);
      expect(rowA.id).toBe('arrow_a');
      expect(rowA.ts).toBe(100n);
      expect(rowA.dur).toBe(400n);
    });
  });

  describe('AnnotationTrack sync fingerprinting and onSliceClick', () => {
    test('does not execute SQL DELETE/INSERT or bump version on store.select', async () => {
      const sqlQueries: string[] = [];
      const mockEngine = {
        query: vi.fn(async (sql: string) => {
          sqlQueries.push(sql.trim());
          return {} as unknown as never;
        }),
      };
      const mockWorkspace = {
        addChildInOrder: vi.fn(),
      };
      const mockRaf = {
        scheduleFullRedraw: vi.fn(),
      };
      const mockTracks = {
        registerTrack: vi.fn(),
      };
      const mockTabs = {
        showTab: vi.fn(),
      };

      const mockTrace = {
        engine: mockEngine,
        defaultWorkspace: mockWorkspace,
        currentWorkspace: mockWorkspace,
        raf: mockRaf,
        tracks: mockTracks,
        tabs: mockTabs,
      } as unknown as Trace;

      const store = new AnnotationStore();
      const track = new AnnotationTrack(mockTrace, store);

      await track.init();

      // Initial init creates table and syncs initial empty rows
      expect(mockEngine.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'CREATE TABLE IF NOT EXISTS __timeline_annotations',
        ),
      );
      const initialQueryCount = mockEngine.query.mock.calls.length;
      const initialRedrawCount = mockRaf.scheduleFullRedraw.mock.calls.length;

      // Add one annotation -> fingerprint changes, should run SQL DELETE/INSERT and schedule redraw
      store.add({
        id: 'ann-1',
        kind: 'rect',
        color: 'red',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(200n),
          trackUris: ['cpu_0'],
        },
      });

      // Wait a microtask tick for sync promise
      await new Promise((resolve) => setTimeout(resolve, 10));

      const afterAddQueryCount = mockEngine.query.mock.calls.length;
      expect(afterAddQueryCount).toBeGreaterThan(initialQueryCount);
      expect(mockRaf.scheduleFullRedraw.mock.calls.length).toBe(
        initialRedrawCount + 1,
      );

      // Now call store.select('ann-1') -> fingerprint DOES NOT CHANGE!
      store.select('ann-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No new queries, no new redraw
      expect(mockEngine.query.mock.calls.length).toBe(afterAddQueryCount);
      expect(mockRaf.scheduleFullRedraw.mock.calls.length).toBe(
        initialRedrawCount + 1,
      );

      // Deselect -> still no change in fingerprint
      store.select(undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockEngine.query.mock.calls.length).toBe(afterAddQueryCount);
      expect(mockRaf.scheduleFullRedraw.mock.calls.length).toBe(
        initialRedrawCount + 1,
      );

      track.dispose();
    });

    test('onSliceClick selects annotation and shows AnnotationsTab', () => {
      const mockTabs = {showTab: vi.fn()};
      const mockTrace = {
        tabs: mockTabs,
      } as unknown as Trace;
      const store = new AnnotationStore();
      const track = new AnnotationTrack(mockTrace, store);

      store.add({
        id: 'target-123',
        kind: 'rect',
        color: 'blue',
        anchor: {
          start: Time.fromRaw(10n),
          end: Time.fromRaw(20n),
          trackUris: ['t'],
        },
      });

      const renderer = track.createRenderer() as unknown as {
        attrs: {
          onSliceClick: (arg: {
            slice: {
              row: {
                annotation_id: string;
              };
            };
          }) => void;
        };
      };
      expect(renderer.attrs.onSliceClick).toBeDefined();

      renderer.attrs.onSliceClick({
        slice: {
          row: {
            annotation_id: 'target-123',
          },
        },
      });

      expect(store.selectedId).toBe('target-123');
      expect(mockTabs.showTab).toHaveBeenCalledWith(
        'dev.perfetto.TimelineAnnotations#AnnotationsTab',
      );
    });
  });
});
