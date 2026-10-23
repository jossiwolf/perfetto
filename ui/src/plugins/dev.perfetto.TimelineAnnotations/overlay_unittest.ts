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
import {Rect2D} from '../../base/geom';
import {Time} from '../../base/time';
import {HighPrecisionTime} from '../../base/high_precision_time';
import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import {TimeScale} from '../../base/time_scale';
import type {CanvasColors} from '../../public/canvas_colors';
import type {TrackBounds} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import {AnnotationStore} from './model';
import {
  AnnotationsOverlay,
  colorWithAlpha,
  drawSmoothPolyline,
  resolveCanvasFontFamily,
} from './overlay';
import {ToolController} from './tools';

interface DrawCallRecord {
  method: string;
  args: unknown[];
  fillStyle?: unknown;
  strokeStyle?: unknown;
  lineWidth?: unknown;
}

function createFakeCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  calls: DrawCallRecord[];
  lineDashes: number[][];
} {
  const calls: DrawCallRecord[] = [];
  const lineDashes: number[][] = [];
  let currentFillStyle: unknown = '#000000';
  let currentStrokeStyle: unknown = '#000000';
  let currentLineWidth: unknown = 1;

  const fakeCtx = {
    get fillStyle() {
      return currentFillStyle;
    },
    set fillStyle(val) {
      currentFillStyle = val;
    },
    get strokeStyle() {
      return currentStrokeStyle;
    },
    set strokeStyle(val) {
      currentStrokeStyle = val;
    },
    get lineWidth() {
      return currentLineWidth;
    },
    set lineWidth(val) {
      currentLineWidth = val;
    },
    font: '12px sans-serif',
    textBaseline: 'alphabetic',

    save: vi.fn(() => calls.push({method: 'save', args: []})),
    restore: vi.fn(() => calls.push({method: 'restore', args: []})),
    beginPath: vi.fn(() => calls.push({method: 'beginPath', args: []})),
    closePath: vi.fn(() => calls.push({method: 'closePath', args: []})),
    clip: vi.fn(() => calls.push({method: 'clip', args: []})),
    rect: vi.fn((x: number, y: number, w: number, h: number) =>
      calls.push({method: 'rect', args: [x, y, w, h]}),
    ),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) =>
      calls.push({
        method: 'fillRect',
        args: [x, y, w, h],
        fillStyle: currentFillStyle,
      }),
    ),
    strokeRect: vi.fn((x: number, y: number, w: number, h: number) =>
      calls.push({
        method: 'strokeRect',
        args: [x, y, w, h],
        strokeStyle: currentStrokeStyle,
        lineWidth: currentLineWidth,
      }),
    ),
    setLineDash: vi.fn((segments: number[]) => {
      lineDashes.push([...segments]);
      calls.push({method: 'setLineDash', args: [[...segments]]});
    }),
    ellipse: vi.fn(
      (
        x: number,
        y: number,
        rx: number,
        ry: number,
        rot: number,
        start: number,
        end: number,
      ) =>
        calls.push({
          method: 'ellipse',
          args: [x, y, rx, ry, rot, start, end],
        }),
    ),
    fill: vi.fn(() =>
      calls.push({method: 'fill', args: [], fillStyle: currentFillStyle}),
    ),
    stroke: vi.fn(() =>
      calls.push({
        method: 'stroke',
        args: [],
        strokeStyle: currentStrokeStyle,
        lineWidth: currentLineWidth,
      }),
    ),
    moveTo: vi.fn((x: number, y: number) =>
      calls.push({method: 'moveTo', args: [x, y]}),
    ),
    lineTo: vi.fn((x: number, y: number) =>
      calls.push({method: 'lineTo', args: [x, y]}),
    ),
    quadraticCurveTo: vi.fn((cpx: number, cpy: number, x: number, y: number) =>
      calls.push({method: 'quadraticCurveTo', args: [cpx, cpy, x, y]}),
    ),
    arc: vi.fn(
      (
        x: number,
        y: number,
        radius: number,
        startAngle: number,
        endAngle: number,
      ) =>
        calls.push({
          method: 'arc',
          args: [x, y, radius, startAngle, endAngle],
        }),
    ),
    arcTo: vi.fn(
      (x1: number, y1: number, x2: number, y2: number, radius: number) =>
        calls.push({method: 'arcTo', args: [x1, y1, x2, y2, radius]}),
    ),
    measureText: vi.fn((text: string) => ({
      width: text.length * 6,
    })),
    fillText: vi.fn((text: string, x: number, y: number) =>
      calls.push({
        method: 'fillText',
        args: [text, x, y],
        fillStyle: currentFillStyle,
      }),
    ),
  } as unknown as CanvasRenderingContext2D;

  return {ctx: fakeCtx, calls, lineDashes};
}

describe('TimelineAnnotations: overlay.ts', () => {
  const rootNode = new TrackNode({name: 'Root'});
  const group1 = new TrackNode({uri: 'group_1', name: 'Process Group 1'});
  const track1 = new TrackNode({uri: 'track_1', name: 'Main Thread'});
  const track2 = new TrackNode({uri: 'track_2', name: 'Render Thread'});
  group1.addChildLast(track1);
  group1.addChildLast(track2);
  rootNode.addChildLast(group1);

  const visibleTracks: TrackBounds[] = [
    {node: track1, verticalBounds: {top: 100, bottom: 200}},
    {node: track2, verticalBounds: {top: 200, bottom: 300}},
  ];

  const timeSpan = new HighPrecisionTimeSpan(
    new HighPrecisionTime(Time.fromRaw(0n)),
    1000,
  );
  const pxBounds = {left: 0, right: 1000};
  const timescale = new TimeScale(timeSpan, pxBounds);
  const size = {width: 1000, height: 600};

  const theme: CanvasColors = {
    COLOR_BORDER: '#444444',
    COLOR_BORDER_SECONDARY: '#666666',
    COLOR_BACKGROUND_SECONDARY: '#222222',
    COLOR_ACCENT: '#00e5ff',
    COLOR_BACKGROUND: '#111111',
    COLOR_TEXT: '#ffffff',
    COLOR_TEXT_MUTED: '#999999',
    COLOR_NEUTRAL: '#888888',
    COLOR_TIMELINE_OVERLAY: '#ff00ff',
  };

  test('renders exact rect at resolved vertical and timescale bounds', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(300n),
        trackUris: ['track_1'],
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    // Track 1 verticalBounds: [100, 200], timescale: [100, 300] -> x: 100, y: 100, w: 200, h: 100
    const fillRectCall = calls.find(
      (item) =>
        item.method === 'fillRect' &&
        item.args[0] === 100 &&
        item.args[1] === 100 &&
        item.args[2] === 200 &&
        item.args[3] === 100,
    );
    expect(fillRectCall).toBeDefined();

    const strokeRectCall = calls.find(
      (item) =>
        item.method === 'strokeRect' &&
        item.args[0] === 100 &&
        item.args[1] === 100 &&
        item.args[2] === 200 &&
        item.args[3] === 100,
    );
    expect(strokeRectCall).toBeDefined();

    expect(overlay.lastRender.get(rect.id)).toEqual({
      status: 'exact',
      missing: [],
    });
  });

  test('renders dashed stroke for degraded ancestor resolution', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    // Only group1 is visible, track1 is collapsed
    const collapsedVisibleTracks: TrackBounds[] = [
      {node: group1, verticalBounds: {top: 50, bottom: 250}},
    ];

    const rect = store.add({
      kind: 'rect',
      color: '#00ff00',
      anchor: {
        start: Time.fromRaw(200n),
        end: Time.fromRaw(400n),
        trackUris: ['track_1'],
        trackNames: ['Main Thread'],
      },
    });

    const {ctx, lineDashes} = createFakeCanvasContext();
    overlay.render(
      ctx,
      timescale,
      size,
      collapsedVisibleTracks,
      theme,
      rootNode,
    );

    expect(overlay.lastRender.get(rect.id)?.status).toBe('degraded');
    const hasDashedStroke = lineDashes.some(
      (segments) =>
        segments.length === 2 && segments[0] === 4 && segments[1] === 4,
    );
    expect(hasDashedStroke).toBe(true);
  });

  test('renders translucent full-height band for unanchored annotation', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    const rect = store.add({
      kind: 'rect',
      title: 'Missing Track Rect',
      color: '#0000ff',
      anchor: {
        start: Time.fromRaw(150n),
        end: Time.fromRaw(350n),
        trackUris: ['completely_unknown_track'],
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    // Unanchored should draw full-height vertical band: x=150, y=0, w=200, h=600
    const fullHeightBand = calls.find(
      (item) =>
        item.method === 'fillRect' &&
        item.args[0] === 150 &&
        item.args[1] === 0 &&
        item.args[2] === 200 &&
        item.args[3] === 600,
    );
    expect(fullHeightBand).toBeDefined();

    expect(overlay.lastRender.get(rect.id)).toEqual({
      status: 'unanchored',
      missing: ['completely_unknown_track'],
    });
  });

  test('skips hidden annotations and does not draw them', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(300n),
        trackUris: ['track_1'],
      },
    });
    store.setHidden(rect.id, true);

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const rectDrawCall = calls.find(
      (item) =>
        (item.method === 'fillRect' || item.method === 'strokeRect') &&
        item.args[0] === 100 &&
        item.args[1] === 100,
    );
    expect(rectDrawCall).toBeUndefined();
    expect(overlay.lastRender.has(rect.id)).toBe(false);
  });

  test('renders selected annotation accent outline and handles', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });
    store.select(rect.id);

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    // Accent outline around [100, 100, 100, 100]
    const accentStroke = calls.find(
      (item) =>
        item.method === 'strokeRect' &&
        item.strokeStyle === theme.COLOR_ACCENT &&
        item.args[0] === 99 &&
        item.args[1] === 99,
    );
    expect(accentStroke).toBeDefined();
  });

  test('renders gesture preview when tools preview is active', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    tools.setDrawingMode(true);
    tools.setTool('rect');
    tools.onPointerDown({
      x: 50,
      y: 120,
      ts: Time.fromRaw(50n),
      tracks: visibleTracks,
      timescale,
      rootNode,
      buttons: 1,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
    tools.onPointerMove({
      x: 180,
      y: 160,
      ts: Time.fromRaw(180n),
      tracks: visibleTracks,
      timescale,
      rootNode,
      buttons: 1,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const previewRect = calls.find(
      (item) =>
        item.method === 'strokeRect' &&
        item.args[0] === 50 &&
        item.args[1] === 120 &&
        item.args[2] === 130 &&
        item.args[3] === 40,
    );
    expect(previewRect).toBeDefined();
  });

  test('skips drawing track present in the other tree without classifying as unanchored', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools, {
      trackExists: (uri) => uri === 'track_in_scrolling_tree',
    });

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(300n),
        trackUris: ['track_in_scrolling_tree'],
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    // visibleTracks has only track1 and track2, not track_in_scrolling_tree
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    // Should NOT be drawn as unanchored band (x=100, y=0, w=200, h=600)
    const bandCall = calls.find(
      (item) =>
        item.method === 'fillRect' &&
        item.args[0] === 100 &&
        item.args[1] === 0 &&
        item.args[2] === 200 &&
        item.args[3] === 600,
    );
    expect(bandCall).toBeUndefined();
    expect(overlay.lastRender.get(rect.id)?.status).not.toBe('unanchored');
  });

  test('renders label using title ?? text', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'label',
      title: 'Custom Title',
      text: 'Original Text',
      color: '#00ff00',
      position: {
        ts: Time.fromRaw(200n),
        trackUri: 'track_1',
        yFrac: 0.5,
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const textCall = calls.find(
      (item) => item.method === 'fillText' && item.args[0] === 'Custom Title',
    );
    expect(textCall).toBeDefined();
  });

  test('renders move preview by stroking hit annotation bbox shifted by drag delta', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    // First render to populate geometries
    const {ctx: ctx1} = createFakeCanvasContext();
    overlay.render(ctx1, timescale, size, visibleTracks, theme, rootNode);

    // Simulate select tool drag move
    tools.setDrawingMode(true);
    tools.setTool('select');
    tools.onPointerDown({
      x: 150,
      y: 150,
      ts: Time.fromRaw(150n),
      tracks: visibleTracks,
      timescale,
      rootNode,
      buttons: 1,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
    tools.onPointerMove({
      x: 180,
      y: 170,
      ts: Time.fromRaw(180n),
      tracks: visibleTracks,
      timescale,
      rootNode,
      buttons: 1,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });

    expect(tools.preview?.kind).toBe('move');

    const {ctx: ctx2, calls} = createFakeCanvasContext();
    overlay.render(ctx2, timescale, size, visibleTracks, theme, rootNode);

    // Original rect was [100, 100, 100, 100]. Shift delta is +30, +20 -> [130, 120, 100, 100]
    const moveStroke = calls.find(
      (item) =>
        item.method === 'strokeRect' &&
        item.args[0] === 130 &&
        item.args[1] === 120 &&
        item.args[2] === 100 &&
        item.args[3] === 100,
    );
    expect(moveStroke).toBeDefined();
  });

  test('colorWithAlpha handles named CSS colors and short hex without fallback', () => {
    expect(colorWithAlpha('red', 0.12)).toBe('rgba(229, 57, 53, 0.12)');
    expect(colorWithAlpha('#0f0', 0.5)).toBe('rgba(0, 255, 0, 0.5)');
    expect(colorWithAlpha('#1e88e5', 0.2)).toBe('rgba(30, 136, 229, 0.2)');
  });

  test('each kind strokes and fills with the annotation color', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    // rect
    store.add({
      id: 'rect_test',
      kind: 'rect',
      color: '#e53935',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });
    // ellipse
    store.add({
      id: 'ellipse_test',
      kind: 'ellipse',
      color: '#43a047',
      anchor: {
        start: Time.fromRaw(200n),
        end: Time.fromRaw(300n),
        trackUris: ['track_1'],
      },
    });
    // path
    store.add({
      id: 'path_test',
      kind: 'path',
      color: '#8e24aa',
      points: [
        {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.2},
        {ts: Time.fromRaw(300n), trackUri: 'track_1', yFrac: 0.8},
      ],
    });
    // label
    store.add({
      id: 'label_test',
      kind: 'label',
      color: '#fb8c00',
      text: 'My Label',
      position: {ts: Time.fromRaw(150n), trackUri: 'track_1', yFrac: 0.5},
    });
    // arrow
    store.add({
      id: 'arrow_test',
      kind: 'arrow',
      color: '#00897b',
      from: {
        kind: 'point',
        point: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
      },
      to: {
        kind: 'point',
        point: {ts: Time.fromRaw(200n), trackUri: 'track_2', yFrac: 0.5},
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    // rect fills and strokes with #e53935
    expect(
      calls.some(
        (c) =>
          c.method === 'fillRect' && c.fillStyle === 'rgba(229, 57, 53, 0.2)',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.method === 'strokeRect' && c.strokeStyle === '#e53935',
      ),
    ).toBe(true);

    // ellipse fills and strokes with #43a047
    expect(
      calls.some(
        (c) => c.method === 'fill' && c.fillStyle === 'rgba(67, 160, 71, 0.2)',
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === 'stroke' && c.strokeStyle === '#43a047'),
    ).toBe(true);

    // path strokes with #8e24aa
    expect(
      calls.some((c) => c.method === 'stroke' && c.strokeStyle === '#8e24aa'),
    ).toBe(true);

    // label fills with rgba and strokes with #fb8c00
    expect(
      calls.some(
        (c) => c.method === 'fill' && c.fillStyle === 'rgba(251, 140, 0, 0.12)',
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === 'stroke' && c.strokeStyle === '#fb8c00'),
    ).toBe(true);

    // arrow strokes with #00897b
    expect(
      calls.some((c) => c.method === 'stroke' && c.strokeStyle === '#00897b'),
    ).toBe(true);
  });

  test('renders custom fillColor and fillOpacity for rect', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'rect',
      color: '#ff0000',
      fillColor: '#00ff00',
      fillOpacity: 0.3,
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const fillCall = calls.find(
      (c) =>
        c.method === 'fillRect' &&
        c.fillStyle === 'rgba(0, 255, 0, 0.3)' &&
        c.args[0] === 100 &&
        c.args[1] === 100,
    );
    expect(fillCall).toBeDefined();
  });

  test('renders LabelAnnotation custom typography and background color', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'label',
      color: '#ff00ff',
      text: 'Custom Styled Label',
      fontFamily: 'monospace',
      fontSize: 16,
      textColor: '#ffffff',
      backgroundColor: '#00ffff',
      fillOpacity: 0.5,
      position: {
        ts: Time.fromRaw(150n),
        trackUri: 'track_1',
        yFrac: 0.5,
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    expect(ctx.font).toBe('16px monospace');
    const bgFill = calls.find(
      (c) => c.method === 'fill' && c.fillStyle === 'rgba(0, 255, 255, 0.5)',
    );
    expect(bgFill).toBeDefined();

    const textCall = calls.find(
      (c) =>
        c.method === 'fillText' &&
        c.args[0] === 'Custom Styled Label' &&
        c.fillStyle === '#ffffff',
    );
    expect(textCall).toBeDefined();
  });

  test('renders curved arrow with quadraticCurveTo and under-glow when fillColor is set', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'arrow',
      color: '#e53935',
      fillColor: '#00e5ff',
      curvature: 40,
      controlOffset: {alongFrac: 0.5, normalPx: 40},
      from: {
        kind: 'point',
        point: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
      },
      to: {
        kind: 'point',
        point: {ts: Time.fromRaw(300n), trackUri: 'track_1', yFrac: 0.5},
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const quadCall = calls.find((c) => c.method === 'quadraticCurveTo');
    expect(quadCall).toBeDefined();

    const underglowStroke = calls.find(
      (c) => c.method === 'stroke' && c.lineWidth === 6,
    );
    expect(underglowStroke).toBeDefined();
  });

  test('multi-tree rootNode geometry preservation and getInteractionZones', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools, {
      trackExists: (uri) => uri === 'pinned_track' || uri === 'scroll_track',
    });

    const pinnedRoot = new TrackNode({name: 'Pinned Root'});
    const pinnedTrack = new TrackNode({uri: 'pinned_track', name: 'Pinned 1'});
    pinnedRoot.addChildLast(pinnedTrack);

    const scrollRoot = new TrackNode({name: 'Scrolling Root'});
    const scrollTrack = new TrackNode({uri: 'scroll_track', name: 'Scroll 1'});
    scrollRoot.addChildLast(scrollTrack);

    const ann1 = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['pinned_track'],
      },
    });

    const ann2 = store.add({
      kind: 'rect',
      color: '#00ff00',
      anchor: {
        start: Time.fromRaw(150n),
        end: Time.fromRaw(250n),
        trackUris: ['scroll_track'],
      },
    });

    const pinnedTracks: TrackBounds[] = [
      {node: pinnedTrack, verticalBounds: {top: 10, bottom: 60}},
    ];
    const scrollTracks: TrackBounds[] = [
      {node: scrollTrack, verticalBounds: {top: 100, bottom: 200}},
    ];

    const {ctx: ctxPinned} = createFakeCanvasContext();
    overlay.render(ctxPinned, timescale, size, pinnedTracks, theme, pinnedRoot);

    const {ctx: ctxScroll} = createFakeCanvasContext();
    overlay.render(ctxScroll, timescale, size, scrollTracks, theme, scrollRoot);

    const timelineRect = new Rect2D({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
    });
    const pinnedZones = overlay.getInteractionZones({
      timelineRect,
      timescale,
      tracks: pinnedTracks,
      rootNode: pinnedRoot,
    });
    expect(pinnedZones.some((z) => z.id === `annotation:${ann1.id}`)).toBe(
      true,
    );
    expect(pinnedZones.some((z) => z.id === `annotation:${ann2.id}`)).toBe(
      false,
    );

    const scrollZones = overlay.getInteractionZones({
      timelineRect,
      timescale,
      tracks: scrollTracks,
      rootNode: scrollRoot,
    });
    expect(scrollZones.some((z) => z.id === `annotation:${ann2.id}`)).toBe(
      true,
    );
    expect(scrollZones.some((z) => z.id === `annotation:${ann1.id}`)).toBe(
      false,
    );
  });

  test('isInteractive and getInteractionZones respect tool mode', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    const arrow = store.add({
      kind: 'arrow',
      color: '#ff0000',
      from: {
        kind: 'point',
        point: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
      },
      to: {
        kind: 'point',
        point: {ts: Time.fromRaw(300n), trackUri: 'track_1', yFrac: 0.5},
      },
    });

    const {ctx} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const timelineRect = new Rect2D({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
    });
    const interactionCtx = {
      timelineRect,
      timescale,
      tracks: visibleTracks,
      rootNode,
    };

    // When drawingMode is false: overlay is not full-canvas interactive, but interaction zones are provided
    expect(overlay.isInteractive()).toBe(false);
    const zonesNonDrawing = overlay.getInteractionZones(interactionCtx);
    expect(zonesNonDrawing.length).toBeGreaterThan(0);
    expect(
      zonesNonDrawing.some((z) => z.id === `arrow-curve:${arrow.id}`),
    ).toBe(true);

    // When drawingMode is on with creation tool (e.g. rect):
    tools.setDrawingMode(true);
    expect(tools.tool).toBe('rect');
    expect(overlay.isInteractive()).toBe(true);
    // When full-canvas interactive creation tool is armed, getInteractionZones returns empty
    expect(overlay.getInteractionZones(interactionCtx)).toEqual([]);

    // When tool is switched to select in drawingMode:
    tools.setTool('select');
    expect(overlay.isInteractive()).toBe(false);
    expect(overlay.getInteractionZones(interactionCtx).length).toBeGreaterThan(
      0,
    );
  });

  test('renders title pill badges on canvas for annotations with title', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'rect',
      title: 'Active Rect Title',
      color: '#e53935',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    store.add({
      kind: 'arrow',
      title: 'Arrow Flow',
      color: '#00897b',
      from: {
        kind: 'point',
        point: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
      },
      to: {
        kind: 'point',
        point: {ts: Time.fromRaw(300n), trackUri: 'track_1', yFrac: 0.5},
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const rectTitleCall = calls.find(
      (c) => c.method === 'fillText' && c.args[0] === 'Active Rect Title',
    );
    expect(rectTitleCall).toBeDefined();

    const arrowTitleCall = calls.find(
      (c) => c.method === 'fillText' && c.args[0] === 'Arrow Flow',
    );
    expect(arrowTitleCall).toBeDefined();
  });

  test('renders contrast halo casing before colored strokes', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    store.add({
      kind: 'rect',
      color: '#e53935',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const {ctx, calls} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    // Halo casing strokeRect with lineWidth 5 and theme.COLOR_BACKGROUND with alpha 0.85
    const haloStroke = calls.find(
      (c) =>
        c.method === 'strokeRect' &&
        c.lineWidth === 5 &&
        c.strokeStyle === 'rgba(17, 17, 17, 0.85)',
    );
    expect(haloStroke).toBeDefined();

    // Primary strokeRect with lineWidth 2.5
    const primaryStroke = calls.find(
      (c) =>
        c.method === 'strokeRect' &&
        c.lineWidth === 2.5 &&
        c.strokeStyle === '#e53935',
    );
    expect(primaryStroke).toBeDefined();
  });

  test('drawSmoothPolyline connects with lineTo for 2 points and quadraticCurveTo for >= 3 points', () => {
    const {ctx, calls} = createFakeCanvasContext();
    drawSmoothPolyline(ctx, [
      {x: 0, y: 0},
      {x: 10, y: 10},
    ]);
    expect(calls.some((c) => c.method === 'lineTo')).toBe(true);
    expect(calls.some((c) => c.method === 'quadraticCurveTo')).toBe(false);

    const {ctx: ctx3, calls: calls3} = createFakeCanvasContext();
    drawSmoothPolyline(ctx3, [
      {x: 0, y: 0},
      {x: 10, y: 20},
      {x: 20, y: 0},
    ]);
    expect(calls3.some((c) => c.method === 'quadraticCurveTo')).toBe(true);
    expect(calls3.some((c) => c.method === 'lineTo')).toBe(true);
  });

  test('resolveCanvasFontFamily maps font families properly', () => {
    expect(resolveCanvasFontFamily('Roboto')).toBe(
      '"Roboto", "Inter", system-ui, sans-serif',
    );
    expect(resolveCanvasFontFamily('sans-serif')).toBe(
      '"Roboto", "Inter", system-ui, sans-serif',
    );
    expect(resolveCanvasFontFamily(undefined)).toBe(
      '"Roboto", "Inter", system-ui, sans-serif',
    );
    expect(resolveCanvasFontFamily('Roboto Condensed')).toBe(
      '"Roboto Condensed", "Roboto", sans-serif',
    );
    expect(resolveCanvasFontFamily('Roboto Mono')).toBe(
      '"Roboto Mono", "JetBrains Mono", monospace',
    );
    expect(resolveCanvasFontFamily('monospace')).toBe(
      '"Roboto Mono", "JetBrains Mono", monospace',
    );
    expect(resolveCanvasFontFamily('Google Sans')).toBe(
      '"Google Sans", "Roboto", system-ui, sans-serif',
    );
    expect(resolveCanvasFontFamily('Inter')).toBe(
      '"Inter", "Roboto", system-ui, sans-serif',
    );
    expect(resolveCanvasFontFamily('Georgia')).toBe(
      'Georgia, "Times New Roman", serif',
    );
    expect(resolveCanvasFontFamily('serif')).toBe(
      'Georgia, "Times New Roman", serif',
    );
  });

  test('preserves exact resolution status when track exists across secondary rootNode render passes', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools, {
      trackExists: (uri) => uri === 'scroll_track' || uri === 'pinned_track',
    });

    const pinnedRoot = new TrackNode({name: 'Pinned Root'});
    const pinnedTrack = new TrackNode({uri: 'pinned_track', name: 'Pinned 1'});
    pinnedRoot.addChildLast(pinnedTrack);

    const scrollRoot = new TrackNode({name: 'Scrolling Root'});
    const scrollTrack = new TrackNode({uri: 'scroll_track', name: 'Scroll 1'});
    scrollRoot.addChildLast(scrollTrack);

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['scroll_track'],
      },
    });

    const pinnedTracks: TrackBounds[] = [
      {node: pinnedTrack, verticalBounds: {top: 10, bottom: 60}},
    ];
    const scrollTracks: TrackBounds[] = [
      {node: scrollTrack, verticalBounds: {top: 100, bottom: 200}},
    ];

    // Pass 1: Render pinned tracks tree (scroll_track is not present here)
    const {ctx: ctxPinned1} = createFakeCanvasContext();
    overlay.render(
      ctxPinned1,
      timescale,
      size,
      pinnedTracks,
      theme,
      pinnedRoot,
    );

    // Because scroll_track exists in the workspace, status must be 'exact' (not degraded or unanchored)
    expect(overlay.lastRender.get(rect.id)?.status).toBe('exact');

    // Pass 2: Render scrolling tracks tree (scroll_track is present here)
    const {ctx: ctxScroll} = createFakeCanvasContext();
    overlay.render(ctxScroll, timescale, size, scrollTracks, theme, scrollRoot);
    expect(overlay.lastRender.get(rect.id)?.status).toBe('exact');

    // Pass 3: Next frame renders pinned tracks tree again
    const {ctx: ctxPinned2} = createFakeCanvasContext();
    overlay.render(
      ctxPinned2,
      timescale,
      size,
      pinnedTracks,
      theme,
      pinnedRoot,
    );
    // Must STILL be 'exact' and not degraded
    expect(overlay.lastRender.get(rect.id)?.status).toBe('exact');
  });

  test('uses grab cursor and segmented interaction zones for arrow and path', () => {
    const store = new AnnotationStore();
    const tools = new ToolController(store, {requestRedraw: () => {}});
    const overlay = new AnnotationsOverlay(store, tools);

    const arrow = store.add({
      kind: 'arrow',
      color: '#00897b',
      from: {
        kind: 'point',
        point: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
      },
      to: {
        kind: 'point',
        point: {ts: Time.fromRaw(300n), trackUri: 'track_1', yFrac: 0.5},
      },
    });

    const path = store.add({
      kind: 'path',
      color: '#8e24aa',
      points: [
        {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.2},
        {ts: Time.fromRaw(200n), trackUri: 'track_1', yFrac: 0.8},
        {ts: Time.fromRaw(300n), trackUri: 'track_1', yFrac: 0.5},
      ],
    });

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const {ctx} = createFakeCanvasContext();
    overlay.render(ctx, timescale, size, visibleTracks, theme, rootNode);

    const timelineRect = new Rect2D({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
    });
    const zones = overlay.getInteractionZones({
      timelineRect,
      timescale,
      tracks: visibleTracks,
      rootNode,
    });

    // Check arrow zones
    const arrowZones = zones.filter((z) => z.id === `annotation:${arrow.id}`);
    expect(arrowZones.length).toBeGreaterThanOrEqual(8);
    for (const z of arrowZones) {
      expect(z.cursor).toBe('grab');
      expect(z.area.width).toBe(14);
      expect(z.area.height).toBe(14);
    }

    // Check path zones
    const pathZones = zones.filter((z) => z.id === `annotation:${path.id}`);
    expect(pathZones.length).toBeGreaterThan(0);
    for (const z of pathZones) {
      expect(z.cursor).toBe('grab');
      expect(z.area.width).toBe(14);
      expect(z.area.height).toBe(14);
    }

    // Check rect zone
    const rectZone = zones.find((z) => z.id === `annotation:${rect.id}`);
    expect(rectZone).toBeDefined();
    expect(rectZone?.cursor).toBe('grab');
  });
});
