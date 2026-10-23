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

import {describe, expect, test} from 'vitest';
import {Time} from '../../base/time';
import {
  type Annotation,
  type RectAnnotation,
  AnnotationStore,
  fromSerialized,
  normalizeColor,
  toSerialized,
} from './model';

describe('model.ts', () => {
  describe('AnnotationStore basic operations', () => {
    test('starts empty and canAdd/get/list annotations', () => {
      let counter = 0;
      const store = new AnnotationStore({
        idGen: () => `id_${++counter}`,
        now: () => 5000,
      });

      expect(store.list()).toEqual([]);
      expect(store.canUndo).toBe(false);
      expect(store.canRedo).toBe(false);
      expect(store.selectedId).toBeUndefined();

      const created = store.add({
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(200n),
          trackUris: ['cpu_0'],
        },
      });

      expect(created.id).toBe('id_1');
      expect(created.createdAt).toBe(5000);
      expect(created.updatedAt).toBe(5000);
      expect(store.get('id_1')).toEqual(created);
      expect(store.list().length).toBe(1);
    });

    test('updates existing annotation and sets updatedAt', () => {
      let currentTime = 1000;
      const store = new AnnotationStore({
        idGen: () => 'fixed-id',
        now: () => currentTime,
      });

      store.add({
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(200n),
          trackUris: ['cpu_0'],
        },
      });

      currentTime = 2500;
      const updated = store.update('fixed-id', {
        title: 'New Title',
      });

      expect(updated?.title).toBe('New Title');
      expect(updated?.createdAt).toBe(1000);
      expect(updated?.updatedAt).toBe(2500);
      expect(store.update('non-existent', {title: 'X'})).toBeUndefined();
    });

    test('remove cascades to arrows referencing the removed annotation', () => {
      const store = new AnnotationStore();

      store.add({
        id: 'rect_target',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(200n),
          trackUris: ['track_1'],
        },
      });

      store.add({
        id: 'rect_other',
        kind: 'rect',
        color: '#00ff00',
        anchor: {
          start: Time.fromRaw(300n),
          end: Time.fromRaw(400n),
          trackUris: ['track_2'],
        },
      });

      store.add({
        id: 'arrow_from_target',
        kind: 'arrow',
        color: '#0000ff',
        from: {kind: 'annotation', id: 'rect_target'},
        to: {kind: 'annotation', id: 'rect_other'},
      });

      store.add({
        id: 'arrow_to_target',
        kind: 'arrow',
        color: '#ffff00',
        from: {
          kind: 'point',
          point: {ts: Time.fromRaw(50n), trackUri: 'track_1', yFrac: 0.5},
        },
        to: {kind: 'annotation', id: 'rect_target'},
      });

      store.add({
        id: 'arrow_unrelated',
        kind: 'arrow',
        color: '#ffffff',
        from: {kind: 'annotation', id: 'rect_other'},
        to: {
          kind: 'point',
          point: {ts: Time.fromRaw(500n), trackUri: 'track_2', yFrac: 0.5},
        },
      });

      expect(store.list().length).toBe(5);

      const removed = store.remove('rect_target');
      expect(removed).toBe(true);

      expect(store.get('rect_target')).toBeUndefined();
      expect(store.get('arrow_from_target')).toBeUndefined();
      expect(store.get('arrow_to_target')).toBeUndefined();
      expect(store.get('rect_other')).toBeDefined();
      expect(store.get('arrow_unrelated')).toBeDefined();
      expect(store.list().length).toBe(2);
    });

    test('remove on non-existent id returns false', () => {
      const store = new AnnotationStore();
      expect(store.remove('non_existent')).toBe(false);
    });
  });

  describe('Undo/Redo and Snapshots', () => {
    test('handles undo past the beginning and redo past the end safely', () => {
      const store = new AnnotationStore();
      expect(store.undo()).toBe(false);
      expect(store.redo()).toBe(false);

      store.add({
        id: 'first',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(10n),
          end: Time.fromRaw(20n),
          trackUris: ['track_a'],
        },
      });

      expect(store.list().length).toBe(1);
      expect(store.canUndo).toBe(true);
      expect(store.canRedo).toBe(false);

      expect(store.undo()).toBe(true);
      expect(store.list().length).toBe(0);
      expect(store.canUndo).toBe(false);
      expect(store.canRedo).toBe(true);

      // Undo again past the beginning returns false
      expect(store.undo()).toBe(false);

      // Redo restores item
      expect(store.redo()).toBe(true);
      expect(store.list().length).toBe(1);
      expect(store.get('first')).toBeDefined();

      // Redo again past the end returns false
      expect(store.redo()).toBe(false);
    });

    test('clears redo stack on new mutation', () => {
      const store = new AnnotationStore();
      store.add({
        id: 'item-1',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(10n),
          end: Time.fromRaw(20n),
          trackUris: ['track_a'],
        },
      });

      store.undo();
      expect(store.canRedo).toBe(true);

      // New mutation clears redo
      store.add({
        id: 'item-2',
        kind: 'rect',
        color: '#00ff00',
        anchor: {
          start: Time.fromRaw(30n),
          end: Time.fromRaw(40n),
          trackUris: ['track_a'],
        },
      });
      expect(store.canRedo).toBe(false);
    });
  });

  describe('onChange listener and selection', () => {
    test('invokes onChange once per mutation and supports disposal', () => {
      const store = new AnnotationStore();
      let callCount = 0;

      const disposable = store.onChange(() => {
        callCount += 1;
      });

      store.add({
        id: 'test-1',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['t'],
        },
      });
      expect(callCount).toBe(1);

      store.update('test-1', {color: '#0000ff'});
      expect(callCount).toBe(2);

      store.select('test-1');
      expect(callCount).toBe(3);
      expect(store.selectedId).toBe('test-1');

      disposable[Symbol.dispose]();
      store.remove('test-1');
      expect(callCount).toBe(3);
    });

    test('hidden toggles work defensively and notify listeners', () => {
      const store = new AnnotationStore();
      let notifications = 0;
      store.onChange(() => {
        notifications += 1;
      });

      expect(store.isHidden('a')).toBe(false);
      expect(store.toggleHidden('a')).toBe(true);
      expect(store.isHidden('a')).toBe(true);
      expect(notifications).toBe(1);

      expect(store.toggleHidden('a')).toBe(false);
      expect(store.isHidden('a')).toBe(false);
      expect(notifications).toBe(2);
    });
  });

  describe('mergeImport and replaceAll', () => {
    test('mergeImport resolves union by id, newer updatedAt wins, equal updatedAt keeps existing', () => {
      const store = new AnnotationStore();
      store.add({
        id: 'existing-1',
        kind: 'rect',
        title: 'Original Title',
        color: '#111111',
        createdAt: 1000,
        updatedAt: 2000,
        anchor: {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['t'],
        },
      });

      store.add({
        id: 'existing-2',
        kind: 'rect',
        title: 'Original Title 2',
        color: '#222222',
        createdAt: 1000,
        updatedAt: 3000,
        anchor: {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['t'],
        },
      });

      const incoming: Annotation[] = [
        // Brand new -> added
        {
          id: 'new-1',
          kind: 'rect',
          color: '#333333',
          createdAt: 1000,
          updatedAt: 1500,
          anchor: {
            start: Time.fromRaw(0n),
            end: Time.fromRaw(10n),
            trackUris: ['t'],
          },
        },
        // Newer updatedAt (2500 > 2000) -> updated
        {
          id: 'existing-1',
          kind: 'rect',
          title: 'Imported Title',
          color: '#444444',
          createdAt: 1000,
          updatedAt: 2500,
          anchor: {
            start: Time.fromRaw(0n),
            end: Time.fromRaw(10n),
            trackUris: ['t'],
          },
        },
        // Equal updatedAt (3000 === 3000) -> skipped, keep existing
        {
          id: 'existing-2',
          kind: 'rect',
          title: 'Conflicting Title',
          color: '#555555',
          createdAt: 1000,
          updatedAt: 3000,
          anchor: {
            start: Time.fromRaw(0n),
            end: Time.fromRaw(10n),
            trackUris: ['t'],
          },
        },
      ];

      const counts = store.mergeImport(incoming);
      expect(counts).toEqual({added: 1, updated: 1, skipped: 1});

      expect(store.get('new-1')).toBeDefined();
      expect(store.get('existing-1')?.title).toBe('Imported Title');
      expect(store.get('existing-2')?.title).toBe('Original Title 2');
    });

    test('replaceAll clears and replaces annotations', () => {
      const store = new AnnotationStore();
      store.add({
        id: 'old-1',
        kind: 'rect',
        color: '#000',
        anchor: {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(1n),
          trackUris: ['t'],
        },
      });

      const nextList: RectAnnotation[] = [
        {
          id: 'new-a',
          kind: 'rect',
          color: '#fff',
          createdAt: 1,
          updatedAt: 1,
          anchor: {
            start: Time.fromRaw(2n),
            end: Time.fromRaw(3n),
            trackUris: ['u'],
          },
        },
      ];

      store.replaceAll(nextList);
      expect(store.get('old-1')).toBeUndefined();
      expect(store.get('new-a')).toBeDefined();
    });
  });

  describe('normalizeColor', () => {
    test('normalizes named colors, hex variants, and rgb', () => {
      expect(normalizeColor('red')).toBe('#e53935');
      expect(normalizeColor('RED')).toBe('#e53935');
      expect(normalizeColor('blue')).toBe('#1e88e5');
      expect(normalizeColor('#f00')).toBe('#ff0000');
      expect(normalizeColor('#0f0')).toBe('#00ff00');
      expect(normalizeColor('#E53935')).toBe('#e53935');
      expect(normalizeColor('e53935')).toBe('#e53935');
      expect(normalizeColor('rgb(255, 0, 0)')).toBe('#ff0000');
      expect(normalizeColor('unknown-color')).toBe('unknown-color');
    });

    test('normalizes transparent to transparent', () => {
      expect(normalizeColor('transparent')).toBe('transparent');
      expect(normalizeColor('  TRANSPARENT  ')).toBe('transparent');
      expect(normalizeColor('Transparent')).toBe('transparent');
    });

    test('AnnotationStore normalizes color on add and update', () => {
      const store = new AnnotationStore();
      const added = store.add({
        kind: 'rect',
        color: 'red',
        anchor: {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['t'],
        },
      });
      expect(added.color).toBe('#e53935');

      const updated = store.update(added.id, {color: '#f00'});
      expect(updated?.color).toBe('#ff0000');
    });

    test('AnnotationStore normalizes fillColor, textColor, backgroundColor and allows clearing', () => {
      const store = new AnnotationStore();
      const added = store.add({
        kind: 'label',
        color: 'blue',
        fillColor: 'transparent',
        textColor: 'red',
        backgroundColor: 'yellow',
        text: 'hello',
        position: {ts: Time.fromRaw(0n), trackUri: 't', yFrac: 0.5},
      });
      expect(added.fillColor).toBe('transparent');
      const labelAdded = store.get(added.id) as any;
      expect(labelAdded.textColor).toBe('#e53935');
      expect(labelAdded.backgroundColor).toBe('#fdd835');

      const updated = store.update(added.id, {
        fillColor: undefined,
        textColor: '#00ff00',
      });
      expect(updated?.fillColor).toBeUndefined();
      expect((updated as any)?.textColor).toBe('#00ff00');
    });
  });

  describe('changeKind', () => {
    test('returns undefined for non-existent annotation', () => {
      const store = new AnnotationStore();
      expect(store.changeKind('missing', 'rect')).toBeUndefined();
    });

    test('returns existing unmodified if newKind is identical', () => {
      const store = new AnnotationStore();
      const created = store.add({
        id: 'r1',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(200n),
          trackUris: ['t1'],
        },
      });
      const result = store.changeKind('r1', 'rect');
      expect(result).toBe(created);
      expect(store.canUndo).toBe(true); // only 1 add on undo stack
      expect(store.undo()).toBe(true);
      expect(store.list().length).toBe(0);
    });

    test('converts rect -> ellipse -> label -> arrow -> path -> rect correctly with undo/redo', () => {
      let currentTime = 1000;
      const store = new AnnotationStore({now: () => currentTime});

      const initial = store.add({
        id: 'shape-1',
        kind: 'rect',
        title: 'My Shape',
        description: 'Test shape',
        color: '#123456',
        fillColor: 'red',
        fillOpacity: 0.8,
        author: 'Tester',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(500n),
          trackUris: ['t_start', 't_end'],
          trackNames: ['Track Start', 'Track End'],
        },
      });

      expect(initial.fillColor).toBe('#e53935');

      // 1. Rect -> Ellipse
      currentTime = 2000;
      const asEllipse = store.changeKind('shape-1', 'ellipse');
      expect(asEllipse?.kind).toBe('ellipse');
      expect(asEllipse?.id).toBe('shape-1');
      expect(asEllipse?.title).toBe('My Shape');
      expect(asEllipse?.description).toBe('Test shape');
      expect(asEllipse?.color).toBe('#123456');
      expect(asEllipse?.fillColor).toBe('#e53935');
      expect(asEllipse?.fillOpacity).toBe(0.8);
      expect(asEllipse?.author).toBe('Tester');
      expect(asEllipse?.updatedAt).toBe(2000);
      if (asEllipse?.kind === 'ellipse') {
        expect(asEllipse.anchor.start).toEqual(Time.fromRaw(100n));
        expect(asEllipse.anchor.end).toEqual(Time.fromRaw(500n));
        expect(asEllipse.anchor.trackUris).toEqual(['t_start', 't_end']);
        expect(asEllipse.anchor.trackNames).toEqual([
          'Track Start',
          'Track End',
        ]);
      }

      // 2. Ellipse -> Label
      currentTime = 3000;
      const asLabel = store.changeKind('shape-1', 'label');
      expect(asLabel?.kind).toBe('label');
      if (asLabel?.kind === 'label') {
        expect(asLabel.text).toBe('My Shape'); // uses existing title
        expect(asLabel.position.ts).toEqual(Time.fromRaw(100n));
        expect(asLabel.position.trackUri).toBe('t_start');
        expect(asLabel.position.trackName).toBe('Track Start');
      }

      // 3. Label -> Arrow
      currentTime = 4000;
      const asArrow = store.changeKind('shape-1', 'arrow');
      expect(asArrow?.kind).toBe('arrow');
      if (asArrow?.kind === 'arrow') {
        expect(asArrow.from.kind).toBe('point');
        expect(asArrow.to.kind).toBe('point');
        if (asArrow.from.kind === 'point' && asArrow.to.kind === 'point') {
          expect(asArrow.from.point.ts).toEqual(Time.fromRaw(100n));
          expect(asArrow.to.point.ts).toEqual(
            Time.add(Time.fromRaw(100n), Time.fromRaw(10_000_000n)),
          );
        }
      }

      // 4. Arrow -> Path
      currentTime = 5000;
      const asPath = store.changeKind('shape-1', 'path');
      expect(asPath?.kind).toBe('path');
      if (asPath?.kind === 'path') {
        expect(asPath.points.length).toBe(2);
        expect(asPath.points[0].ts).toEqual(Time.fromRaw(100n));
      }

      // 5. Path -> Rect
      currentTime = 6000;
      const asRectAgain = store.changeKind('shape-1', 'rect');
      expect(asRectAgain?.kind).toBe('rect');

      // Test Undo stack rewinds through kinds
      expect(store.undo()).toBe(true);
      expect(store.get('shape-1')?.kind).toBe('path');
      expect(store.undo()).toBe(true);
      expect(store.get('shape-1')?.kind).toBe('arrow');
      expect(store.undo()).toBe(true);
      expect(store.get('shape-1')?.kind).toBe('label');
      expect(store.undo()).toBe(true);
      expect(store.get('shape-1')?.kind).toBe('ellipse');
      expect(store.undo()).toBe(true);
      expect(store.get('shape-1')?.kind).toBe('rect');

      // Test Redo
      expect(store.redo()).toBe(true);
      expect(store.get('shape-1')?.kind).toBe('ellipse');
    });

    test('converts arrow referencing another annotation and handles fallback', () => {
      const store = new AnnotationStore();
      store.add({
        id: 'target-rect',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(1000n),
          end: Time.fromRaw(2000n),
          trackUris: ['cpu_0'],
        },
      });

      store.add({
        id: 'arrow-ref',
        kind: 'arrow',
        color: '#00ff00',
        from: {kind: 'annotation', id: 'target-rect'},
        to: {
          kind: 'point',
          point: {ts: Time.fromRaw(3000n), trackUri: 'cpu_1', yFrac: 0.5},
        },
      });

      const converted = store.changeKind('arrow-ref', 'rect');
      expect(converted?.kind).toBe('rect');
      if (converted?.kind === 'rect') {
        expect(converted.anchor.start).toEqual(Time.fromRaw(1000n));
        expect(converted.anchor.end).toEqual(Time.fromRaw(3000n));
        expect(converted.anchor.trackUris).toEqual(['cpu_0', 'cpu_1']);
      }
    });
  });

  describe('toSerialized and fromSerialized round-trip', () => {
    test('round-trips all annotation kinds and extreme int64 timestamps', () => {
      const annotations: Annotation[] = [
        {
          id: 'rect-roundtrip',
          kind: 'rect',
          title: 'Extreme Timestamps',
          color: '#123456',
          fillColor: '#654321',
          fillOpacity: 0.5,
          createdAt: 1000,
          updatedAt: 2000,
          anchor: {
            start: Time.fromRaw(-9223372036854775808n),
            end: Time.fromRaw(9223372036854775807n),
            trackUris: ['track_extreme'],
            trackNames: ['Extreme Track'],
          },
        },
        {
          id: 'label-roundtrip',
          kind: 'label',
          color: '#abcdef',
          fontFamily: 'monospace',
          fontSize: 20,
          textColor: '#111111',
          backgroundColor: '#eeeeee',
          createdAt: 3000,
          updatedAt: 4000,
          text: 'Hello Label',
          position: {
            ts: Time.fromRaw(1234567890n),
            trackUri: 'track_label',
            trackName: 'Track Label',
            yFrac: 0.75,
          },
        },
        {
          id: 'arrow-roundtrip',
          kind: 'arrow',
          color: '#654321',
          curvature: 250,
          controlOffset: {alongFrac: 0.6, normalPx: -50},
          createdAt: 5000,
          updatedAt: 6000,
          from: {kind: 'annotation', id: 'rect-roundtrip'},
          to: {
            kind: 'point',
            point: {
              ts: Time.fromRaw(9999n),
              trackUri: 'track_arrow',
              yFrac: 0.1,
            },
          },
        },
      ];

      const serialized = toSerialized(annotations);
      expect(serialized.version).toBe(1);
      expect(serialized.annotations[0].kind).toBe('rect');

      const restored = fromSerialized(serialized);
      expect(restored).toEqual(annotations);
    });
  });
});
