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
import {AnnotationStore, normalizeColor} from './model';
import {AnnotationsOverlay} from './overlay';
import {ToolController, TOOL_KINDS} from './tools';
import {
  AnnotationsTab,
  PALETTE_COLORS,
  getToolIcon,
  getToolLabel,
} from './annotations_tab';

describe('TimelineAnnotations: annotations_tab.ts', () => {
  test('renders empty state and drawing toolbar when store has no annotations', () => {
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
    expect(
      root.querySelector('.pf-timeline-annotations__toolbar'),
    ).not.toBeNull();

    // Check all tool buttons are rendered in the toolbar
    const toolButtons = root.querySelectorAll(
      '.pf-timeline-annotations__tools button',
    );
    expect(toolButtons.length).toBe(TOOL_KINDS.length);

    // Active tool ('rect' by default) has active class
    const activeToolButton = root.querySelector(
      '.pf-timeline-annotations__tools button.pf-active',
    );
    expect(activeToolButton).not.toBeNull();
    expect(activeToolButton?.getAttribute('data-tool')).toBe('rect');

    // No annotation items in empty state
    expect(root.querySelectorAll('.pf-timeline-annotations-item').length).toBe(
      0,
    );
  });

  test('clicking a tool button switches the active tool', () => {
    const store = new AnnotationStore();
    let redrawCalled = false;
    const tools = new ToolController(store, {
      requestRedraw: () => {
        redrawCalled = true;
      },
    });
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    const root = document.createElement('div');
    m.render(root, tab.render());

    const penButton = root.querySelector(
      '.pf-timeline-annotations__tools button[data-tool="pen"]',
    ) as HTMLButtonElement | null;
    expect(penButton).not.toBeNull();
    penButton?.click();

    expect(tools.tool).toBe('pen');
    expect(redrawCalled).toBe(true);
  });

  test('renders annotations list with swatches and no select dropdowns in rows', () => {
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

    // Confirm ZERO select elements exist in the entire tab
    const selectElements = root.querySelectorAll('select');
    expect(selectElements.length).toBe(0);

    // Each row renders color swatches
    const rowSwatches = root.querySelectorAll(
      '.pf-timeline-annotations-item .pf-timeline-annotations__swatches',
    );
    expect(rowSwatches.length).toBe(2);

    // Kind icon has title tooltip naming the kind
    const firstIcon = root.querySelector(
      '.pf-timeline-annotations-item .pf-timeline-annotations-icon',
    );
    expect(firstIcon?.getAttribute('title')).toContain('Rect');
  });

  test('renders custom color in swatch with active state and input[type=color]', () => {
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

    const customSwatch = root.querySelector(
      '.pf-timeline-annotations-item .pf-timeline-annotations__swatch--custom',
    );
    expect(customSwatch).not.toBeNull();
    expect(
      customSwatch?.classList.contains(
        'pf-timeline-annotations__swatch--active',
      ),
    ).toBe(true);

    const colorInput = root.querySelector(
      '.pf-timeline-annotations-item input[type=color]',
    ) as HTMLInputElement | null;
    expect(colorInput).not.toBeNull();
    expect(colorInput?.value).toBe('#123456');
  });

  test('clicking palette swatch updates annotation color in store', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    store.add({
      id: 'rect_to_change',
      kind: 'rect',
      color: '#e53935', // red
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const root = document.createElement('div');
    m.render(root, tab.render());

    // Target the green palette swatch in the row
    const greenColor = PALETTE_COLORS.find(
      (paletteColor) => paletteColor.label === 'Green',
    );
    expect(greenColor).toBeDefined();

    const swatches = root.querySelectorAll(
      '.pf-timeline-annotations-item .pf-timeline-annotations__swatch',
    );
    const greenSwatch = Array.from(swatches).find(
      (swatchElement) =>
        (swatchElement as HTMLElement).title === greenColor?.label,
    ) as HTMLElement | undefined;

    expect(greenSwatch).toBeDefined();
    greenSwatch?.click();

    expect(store.get('rect_to_change')?.color).toBe(greenColor?.value);
  });

  test('toolbar swatch click updates tool color', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    const root = document.createElement('div');
    m.render(root, tab.render());

    const blueColor = PALETTE_COLORS.find(
      (paletteColor) => paletteColor.label === 'Blue',
    );
    expect(blueColor).toBeDefined();

    const toolbarSwatches = root.querySelectorAll(
      '.pf-timeline-annotations__toolbar .pf-timeline-annotations__swatch',
    );
    const blueSwatch = Array.from(toolbarSwatches).find(
      (swatchElement) =>
        (swatchElement as HTMLElement).title === blueColor?.label,
    ) as HTMLElement | undefined;

    expect(blueSwatch).toBeDefined();
    blueSwatch?.click();

    expect(tools.color).toBe(blueColor?.value);
  });

  test('tool icon and label helpers return expected values', () => {
    expect(getToolIcon('select')).toBe('near_me');
    expect(getToolIcon('rect')).toBe('crop_square');
    expect(getToolIcon('ellipse')).toBe('circle');
    expect(getToolIcon('pen')).toBe('draw');
    expect(getToolIcon('arrow')).toBe('arrow_forward');
    expect(getToolIcon('label')).toBe('text_fields');

    expect(getToolLabel('select')).toBe('Select');
    expect(getToolLabel('rect')).toBe('Rectangle');
    expect(getToolLabel('ellipse')).toBe('Ellipse');
    expect(getToolLabel('pen')).toBe('Pen');
    expect(getToolLabel('arrow')).toBe('Arrow');
    expect(getToolLabel('label')).toBe('Label');
  });

  test('default tool color is in the palette and matches orange swatch', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);
    const trace = {} as Trace;
    const tab = new AnnotationsTab(trace, store, tools, overlay);

    const root = document.createElement('div');
    m.render(root, tab.render());

    // Assert tools.color is in PALETTE_COLORS
    const defaultPaletteMatch = PALETTE_COLORS.find(
      (paletteColor) =>
        normalizeColor(paletteColor.value).toLowerCase() ===
        normalizeColor(tools.color).toLowerCase(),
    );
    expect(defaultPaletteMatch).toBeDefined();
    expect(defaultPaletteMatch?.label).toBe('Orange');
    expect(tools.color).toBe(PALETTE_COLORS[1].value);

    // Assert that the orange palette swatch in the toolbar has the active class
    const activeSwatch = root.querySelector(
      '.pf-timeline-annotations__toolbar .pf-timeline-annotations__swatch--active',
    ) as HTMLElement | null;
    expect(activeSwatch).not.toBeNull();
    expect(activeSwatch?.title).toBe('Orange');
    expect(
      activeSwatch?.classList.contains(
        'pf-timeline-annotations__swatch--custom',
      ),
    ).toBe(false);
  });
});
