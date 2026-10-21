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

import {z} from 'zod';
import type {Trace} from '../../public/trace';
import type {Setting} from '../../public/settings';
import {download} from '../../base/download_utils';
import {
  type Annotation,
  type AnnotationStore,
  fromSerialized,
  toSerialized,
} from './model';
import {SerializedAnnotationsSchema} from './schema';

export const ANNOTATIONS_STORAGE_ID = 'dev.perfetto.TimelineAnnotations';
export const AUTOSAVE_SETTING_ID = 'dev.perfetto.TimelineAnnotations#autosave';
export const AUTOSAVE_INDEX_KEY = 'dev.perfetto.TimelineAnnotations#index';
export const MAX_AUTOSAVE_ENTRIES = 20;

export function getAutosaveKey(uuid: string): string {
  return `dev.perfetto.TimelineAnnotations#${uuid}`;
}

export function wireStorage(trace: Trace, store: AnnotationStore): Disposable {
  const storage = trace.registerStorage({
    id: ANNOTATIONS_STORAGE_ID,
    schema: SerializedAnnotationsSchema,
    defaultValue: {version: 1, annotations: []},
  });

  const initialStored = storage.get();
  if (initialStored.annotations.length > 0) {
    store.replaceAll(fromSerialized(initialStored));
  }

  const subscription = store.onChange(() => {
    storage.set(toSerialized(store.list()));
  });

  return {
    [Symbol.dispose]: () => {
      subscription[Symbol.dispose]();
    },
  };
}

export class AutosaveStore {
  private readonly storage: globalThis.Storage;

  constructor(customStorage?: globalThis.Storage) {
    this.storage =
      customStorage ??
      (typeof window !== 'undefined'
        ? window.localStorage
        : ({} as globalThis.Storage));
  }

  load(uuid: string): Annotation[] | undefined {
    try {
      const raw = this.storage.getItem(getAutosaveKey(uuid));
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw);
      return fromSerialized(parsed);
    } catch (err) {
      console.warn('Failed to load autosaved annotations for trace', uuid, err);
      return undefined;
    }
  }

  save(uuid: string, annotations: ReadonlyArray<Annotation>): void {
    try {
      let index: string[] = [];
      const rawIndex = this.storage.getItem(AUTOSAVE_INDEX_KEY);
      if (rawIndex) {
        try {
          const parsed = JSON.parse(rawIndex);
          if (Array.isArray(parsed)) {
            index = parsed.filter(
              (item): item is string => typeof item === 'string',
            );
          }
        } catch (parseErr) {
          console.warn('Failed to parse autosave index, resetting:', parseErr);
          index = [];
        }
      }

      index = index.filter((existingUuid) => existingUuid !== uuid);

      while (index.length >= MAX_AUTOSAVE_ENTRIES) {
        const evictedUuid = index.pop();
        if (evictedUuid !== undefined) {
          try {
            this.storage.removeItem(getAutosaveKey(evictedUuid));
          } catch {
            // Ignore removal errors
          }
        }
      }

      const entryKey = getAutosaveKey(uuid);
      const entryValue = JSON.stringify(toSerialized(annotations));

      // Attempt to save entry first. On error (e.g. quota exceeded), evict oldest entries and retry.
      const maxRetries = MAX_AUTOSAVE_ENTRIES;
      let writeSuccess = false;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          this.storage.setItem(entryKey, entryValue);
          writeSuccess = true;
          break;
        } catch {
          if (index.length > 0) {
            const evictedUuid = index.pop();
            if (evictedUuid !== undefined) {
              try {
                this.storage.removeItem(getAutosaveKey(evictedUuid));
              } catch {
                // Ignore removal error
              }
            }
          } else {
            break;
          }
        }
      }

      if (!writeSuccess) {
        console.warn(
          'Failed to autosave annotations for trace (quota exceeded)',
          uuid,
        );
        return;
      }

      index.unshift(uuid);
      try {
        this.storage.setItem(AUTOSAVE_INDEX_KEY, JSON.stringify(index));
      } catch (indexErr) {
        console.warn('Failed to update autosave index:', indexErr);
      }
    } catch (err) {
      console.warn('Failed to autosave annotations for trace', uuid, err);
    }
  }

  clear(uuid: string): void {
    try {
      this.storage.removeItem(getAutosaveKey(uuid));
      const rawIndex = this.storage.getItem(AUTOSAVE_INDEX_KEY);
      if (rawIndex) {
        try {
          const parsed = JSON.parse(rawIndex);
          if (Array.isArray(parsed)) {
            const index = parsed.filter((item) => item !== uuid);
            this.storage.setItem(AUTOSAVE_INDEX_KEY, JSON.stringify(index));
          }
        } catch {
          // Ignore index parse error on clear
        }
      }
    } catch (err) {
      console.warn(
        'Failed to clear autosaved annotations for trace',
        uuid,
        err,
      );
    }
  }
}

export async function exportAnnotations(
  trace: Trace,
  store: AnnotationStore,
): Promise<void> {
  const traceTitle = trace.traceInfo.traceTitle || 'trace';
  const fileName = `${traceTitle}.annotations.json`;
  const content = JSON.stringify(toSerialized(store.list()), null, 2);
  await download({
    content,
    fileName,
    mimeType: 'application/json',
  });
}

export function importAnnotationsFromFile(store: AnnotationStore): void {
  if (typeof document === 'undefined') {
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';

  input.addEventListener('change', async (event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) ||
      !target.files ||
      target.files.length === 0
    ) {
      return;
    }
    const file = target.files[0];
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const annotations = fromSerialized(parsed);
      store.mergeImport(annotations);
    } catch (err) {
      console.warn('Failed to import annotations from file:', err);
    }
  });

  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
}

export function importFromPluginArgs(
  store: AnnotationStore,
  args?: {[key: string]: unknown},
): {added: number; updated: number; skipped: number} | undefined {
  if (!args) {
    return undefined;
  }

  let candidate: unknown;
  if ('version' in args && 'annotations' in args) {
    candidate = args;
  } else if (
    'annotations' in args &&
    typeof args['annotations'] === 'object' &&
    args['annotations'] !== null
  ) {
    candidate = args['annotations'];
  } else {
    return undefined;
  }

  try {
    const annotations = fromSerialized(candidate);
    return store.mergeImport(annotations);
  } catch (err) {
    console.warn('Failed to parse annotations from plugin args:', err);
    return undefined;
  }
}

export function registerAutosaveSetting(trace: Trace): Setting<boolean> {
  return trace.settings.register({
    id: AUTOSAVE_SETTING_ID,
    name: 'Autosave Timeline Annotations',
    description:
      'Automatically save timeline annotations to local browser storage',
    schema: z.boolean(),
    defaultValue: true,
  });
}

export function wireAutosave(
  trace: Trace,
  store: AnnotationStore,
  autosaveStore: AutosaveStore,
  autosaveSetting: Setting<boolean>,
): Disposable {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const subscription = store.onChange(() => {
    if (!autosaveSetting.get()) {
      return;
    }
    const uuid = trace.traceInfo.uuid;
    if (!uuid) {
      return;
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      autosaveStore.save(uuid, store.list());
      timeoutId = undefined;
    }, 500);
  });

  return {
    [Symbol.dispose]: () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      subscription[Symbol.dispose]();
    },
  };
}
