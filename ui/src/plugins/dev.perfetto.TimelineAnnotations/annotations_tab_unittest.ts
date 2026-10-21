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
import m from 'mithril';
import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import {AnnotationStore} from './model';
import {AnnotationsOverlay} from './overlay';
import {ToolController} from './tools';
import {AnnotationsTab} from './annotations_tab';

describe('TimelineAnnotations: annotations_tab.ts', () => {
  test('renders empty state when store has no annotations', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    const root = document.createElement('div');
    expect(() => {
      m.render(root, tab.render());
    }).not.toThrow();

    expect(root.querySelector('.pf-timeline-annotations-tab')).not.toBeNull();
    expect(root.querySelectorAll('.pf-timeline-annotations-item').length).toBe(
      0,
    );
  });

  test('renders annotations list without fragment key error when annotations exist', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    store.add({
      id: 'rect_1',
      kind: 'rect',
      color: '#e53935',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    store.add({
      id: 'label_1',
      kind: 'label',
      color: '#fb8c00',
      text: 'Sample label',
      position: {ts: Time.fromRaw(150n), trackUri: 'track_1', yFrac: 0.5},
    });

    const root = document.createElement('div');
    expect(() => {
      m.render(root, tab.render());
    }).not.toThrow();

    const items = root.querySelectorAll('.pf-timeline-annotations-item');
    expect(items.length).toBe(2);

    const count = root.querySelector('.pf-timeline-annotations-count');
    expect(count?.textContent).toBe('2 annotations');

    const selectElements = root.querySelectorAll(
      'select.pf-timeline-annotations-color-select',
    );
    expect(selectElements.length).toBe(2);
  });

  test('renders custom color in color select option', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    store.add({
      id: 'rect_custom',
      kind: 'rect',
      color: '#123456',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const root = document.createElement('div');
    expect(() => {
      m.render(root, tab.render());
    }).not.toThrow();

    const select = root.querySelector(
      'select.pf-timeline-annotations-color-select',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = Array.from(select?.options ?? []);
    const customOption = options.find((opt) => opt.text === 'Custom');
    expect(customOption).toBeDefined();
    expect(customOption?.value).toBe('#123456');
  });
});
