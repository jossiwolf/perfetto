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
import {Time} from '../../base/time';
import {type RectAnnotation, AnnotationStore, toSerialized} from './model';
import {
  AUTOSAVE_INDEX_KEY,
  AutosaveStore,
  getAutosaveKey,
  importFromPluginArgs,
  MAX_AUTOSAVE_ENTRIES,
} from './persistence';

class MockStorage implements globalThis.Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('persistence', () => {
  describe('getAutosaveKey', () => {
    test('formats key correctly with trace uuid', () => {
      expect(getAutosaveKey('trace-uuid-123')).toBe(
        'dev.perfetto.TimelineAnnotations#trace-uuid-123',
      );
    });
  });

  describe('AutosaveStore LRU and eviction', () => {
    test('caps index at 20 entries and evicts oldest items', () => {
      const storage = new MockStorage();
      const autosave = new AutosaveStore(storage);

      const sampleAnnotation: RectAnnotation = {
        id: 'rect_test',
        kind: 'rect',
        color: '#ff0000',
        anchor: {
          start: Time.fromRaw(100n),
          end: Time.fromRaw(200n),
          trackUris: ['cpu'],
        },
        createdAt: 1,
        updatedAt: 1,
      };

      for (let index = 0; index < 25; index += 1) {
        autosave.save(`uuid_${index}`, [sampleAnnotation]);
      }

      const indexRaw = storage.getItem(AUTOSAVE_INDEX_KEY);
      expect(indexRaw).not.toBeNull();
      const indexList: string[] = JSON.parse(indexRaw!);
      expect(indexList.length).toBe(MAX_AUTOSAVE_ENTRIES);

      // Entries 0..4 should have been evicted
      for (let index = 0; index < 5; index += 1) {
        expect(storage.getItem(getAutosaveKey(`uuid_${index}`))).toBeNull();
      }

      // Entries 5..24 should be present
      for (let index = 5; index < 25; index += 1) {
        expect(storage.getItem(getAutosaveKey(`uuid_${index}`))).not.toBeNull();
      }

      // Most recent should be at the front
      expect(indexList[0]).toBe('uuid_24');
    });

    test('evicts oldest entries when quota is exceeded and retries', () => {
      let evictionsCount = 0;
      const K = 3;

      class QuotaStorage extends MockStorage {
        override setItem(key: string, value: string): void {
          if (key.includes('uuid_new') && evictionsCount < K) {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
          }
          super.setItem(key, value);
        }

        override removeItem(key: string): void {
          evictionsCount += 1;
          super.removeItem(key);
        }
      }

      const storage = new QuotaStorage();
      const autosave = new AutosaveStore(storage);

      // Pre-fill with 5 items
      for (let i = 0; i < 5; i += 1) {
        storage.setItem(
          getAutosaveKey(`existing_${i}`),
          JSON.stringify({version: 1, annotations: []}),
        );
      }
      storage.setItem(
        AUTOSAVE_INDEX_KEY,
        JSON.stringify([
          'existing_4',
          'existing_3',
          'existing_2',
          'existing_1',
          'existing_0',
        ]),
      );

      autosave.save('uuid_new', []);

      expect(evictionsCount).toBe(K);
      expect(storage.getItem(getAutosaveKey('uuid_new'))).not.toBeNull();
      const indexList: string[] = JSON.parse(
        storage.getItem(AUTOSAVE_INDEX_KEY)!,
      );
      expect(indexList[0]).toBe('uuid_new');
      expect(indexList).not.toContain('existing_0');
      expect(indexList).not.toContain('existing_1');
      expect(indexList).not.toContain('existing_2');
    });

    test('re-saving existing uuid moves it to the front without duplicating', () => {
      const storage = new MockStorage();
      const autosave = new AutosaveStore(storage);

      autosave.save('uuid_a', []);
      autosave.save('uuid_b', []);
      autosave.save('uuid_c', []);
      autosave.save('uuid_a', []);

      const indexList: string[] = JSON.parse(
        storage.getItem(AUTOSAVE_INDEX_KEY)!,
      );
      expect(indexList).toEqual(['uuid_a', 'uuid_c', 'uuid_b']);
    });
  });

  describe('corrupt entries handling', () => {
    test('load ignores corrupt JSON with a warning and does not throw', () => {
      const storage = new MockStorage();
      const autosave = new AutosaveStore(storage);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      storage.setItem(getAutosaveKey('corrupt_uuid'), '{ not valid json');
      const loaded = autosave.load('corrupt_uuid');

      expect(loaded).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('load ignores invalid schema with a warning and does not throw', () => {
      const storage = new MockStorage();
      const autosave = new AutosaveStore(storage);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      storage.setItem(
        getAutosaveKey('invalid_schema_uuid'),
        JSON.stringify({version: 999, annotations: 'invalid'}),
      );
      const loaded = autosave.load('invalid_schema_uuid');

      expect(loaded).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('save handles corrupt index gracefully without throwing', () => {
      const storage = new MockStorage();
      const autosave = new AutosaveStore(storage);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      storage.setItem(AUTOSAVE_INDEX_KEY, 'corrupted index string');
      autosave.save('uuid_new', []);

      const indexList: string[] = JSON.parse(
        storage.getItem(AUTOSAVE_INDEX_KEY)!,
      );
      expect(indexList).toEqual(['uuid_new']);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('export and serialization', () => {
    test('export payload equals toSerialized output', () => {
      const store = new AnnotationStore();
      const rectAnnotation = store.add({
        kind: 'rect',
        color: '#123456',
        title: 'Region A',
        anchor: {
          start: Time.fromRaw(1000n),
          end: Time.fromRaw(2000n),
          trackUris: ['t_0'],
        },
      });

      const serialized = toSerialized(store.list());
      expect(serialized.version).toBe(1);
      expect(serialized.annotations.length).toBe(1);
      expect(serialized.annotations[0].id).toBe(rectAnnotation.id);
    });
  });

  describe('importFromPluginArgs', () => {
    test('returns undefined when args or annotations field is missing', () => {
      const store = new AnnotationStore();
      expect(importFromPluginArgs(store, undefined)).toBeUndefined();
      expect(importFromPluginArgs(store, {})).toBeUndefined();
    });

    test('merges valid serialized annotations from plugin args directly ({version, annotations})', () => {
      const store = new AnnotationStore();
      const result = importFromPluginArgs(store, {
        version: 1,
        annotations: [
          {
            id: 'imported_direct',
            kind: 'rect',
            color: '#00ff00',
            createdAt: 100,
            updatedAt: 100,
            anchor: {
              start: '1000',
              end: '2000',
              trackUris: ['t_1'],
            },
          },
        ],
      });

      expect(result).toBeDefined();
      expect(result?.added).toBe(1);
      expect(store.get('imported_direct')).toBeDefined();
    });

    test('merges valid serialized annotations from wrapped plugin args ({annotations: {version, annotations}})', () => {
      const store = new AnnotationStore();
      const result = importFromPluginArgs(store, {
        annotations: {
          version: 1,
          annotations: [
            {
              id: 'imported_rect',
              kind: 'rect',
              color: '#00ff00',
              createdAt: 100,
              updatedAt: 100,
              anchor: {
                start: '1000',
                end: '2000',
                trackUris: ['t_1'],
              },
            },
          ],
        },
      });

      expect(result).toBeDefined();
      expect(result?.added).toBe(1);
      expect(store.get('imported_rect')).toBeDefined();
    });

    test('handles invalid plugin args with warning and does not throw', () => {
      const store = new AnnotationStore();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = importFromPluginArgs(store, {
        annotations: {version: 1, annotations: [{id: 123}]},
      });

      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
