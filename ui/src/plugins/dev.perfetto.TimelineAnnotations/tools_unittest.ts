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
import {HighPrecisionTime} from '../../base/high_precision_time';
import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import {TimeScale} from '../../base/time_scale';
import type {OverlayPointerEvent, TrackBounds} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import {AnnotationStore} from './model';
import {
  type AnnotationGeometry,
  ToolController,
  type ToolControllerOptions,
} from './tools';

describe('TimelineAnnotations: tools.ts', () => {
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

  function createPointerEvent(args: {
    posX: number;
    posY: number;
    buttons?: number;
    shiftKey?: boolean;
  }): OverlayPointerEvent {
    const matchedTrack = visibleTracks.find(
      (track) =>
        args.posY >= track.verticalBounds.top &&
        args.posY <= track.verticalBounds.bottom,
    );
    return {
      x: args.posX,
      y: args.posY,
      ts: timescale.pxToHpTime(args.posX).toTime(),
      track: matchedTrack,
      tracks: visibleTracks,
      timescale,
      rootNode,
      buttons: args.buttons ?? 0,
      shiftKey: args.shiftKey ?? false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    };
  }

  function setupController(optionsOverride?: Partial<ToolControllerOptions>): {
    store: AnnotationStore;
    controller: ToolController;
    requestRedraw: ReturnType<typeof vi.fn>;
    onAnnotationCreated: ReturnType<typeof vi.fn>;
  } {
    const store = new AnnotationStore();
    const requestRedraw = vi.fn();
    const onAnnotationCreated = vi.fn();
    const controller = new ToolController(store, {
      requestRedraw,
      onAnnotationCreated,
      ...optionsOverride,
    });
    return {store, controller, requestRedraw, onAnnotationCreated};
  }

  test('initial tool is rect and persists across drawingMode toggles', () => {
    const {controller} = setupController();
    expect(controller.tool).toBe('rect');
    expect(controller.drawingMode).toBe(false);

    controller.setDrawingMode(true);
    expect(controller.tool).toBe('rect');

    controller.setTool('pen');
    expect(controller.tool).toBe('pen');

    controller.setDrawingMode(false);
    expect(controller.tool).toBe('pen');

    controller.setDrawingMode(true);
    expect(controller.tool).toBe('pen');
  });

  test('does nothing when drawingMode is off', () => {
    const {store, controller, requestRedraw} = setupController();
    expect(controller.drawingMode).toBe(false);
    expect(controller.isInteractive()).toBe(false);

    controller.setTool('pen');
    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 150, buttons: 0}),
    );

    expect(store.list()).toHaveLength(0);
    expect(controller.preview).toBeUndefined();
    expect(requestRedraw).toHaveBeenCalledTimes(1); // from setTool
  });

  test('toggles drawingMode on and off', () => {
    const {controller, requestRedraw} = setupController();
    expect(controller.toggleDrawingMode()).toBe(true);
    expect(controller.drawingMode).toBe(true);
    expect(controller.isInteractive()).toBe(true);
    expect(requestRedraw).toHaveBeenCalledTimes(1);

    expect(controller.toggleDrawingMode()).toBe(false);
    expect(controller.drawingMode).toBe(false);
    expect(controller.isInteractive()).toBe(false);
    expect(requestRedraw).toHaveBeenCalledTimes(2);
  });

  test('creates rect annotation across tracks and supports undo', () => {
    const {store, controller, onAnnotationCreated} = setupController();
    controller.setDrawingMode(true);
    controller.setTool('rect');

    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 250, posY: 220, buttons: 1}),
    );
    expect(controller.preview).toEqual({
      kind: 'rect',
      rect: {
        left: 100,
        top: 120,
        right: 250,
        bottom: 220,
        width: 150,
        height: 100,
      },
      color: '#ff6d00',
    });

    controller.onPointerUp(
      createPointerEvent({posX: 250, posY: 220, buttons: 0}),
    );
    expect(controller.preview).toBeUndefined();

    const annotations = store.list();
    expect(annotations).toHaveLength(1);
    const rect = annotations[0];
    expect(rect.kind).toBe('rect');
    if (rect.kind === 'rect') {
      expect(rect.anchor.start).toEqual(Time.fromRaw(100n));
      expect(rect.anchor.end).toEqual(Time.fromRaw(250n));
      expect(rect.anchor.trackUris).toEqual(['track_1', 'track_2']);
    }
    expect(onAnnotationCreated).toHaveBeenCalledWith(rect.id);
    expect(store.selectedId).toBe(rect.id);

    // Verify undo removes it
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.list()).toHaveLength(0);
  });

  test('ignores rect drag under 3px', () => {
    const {store, controller} = setupController();
    controller.setDrawingMode(true);
    controller.setTool('rect');

    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 101, posY: 121, buttons: 0}),
    );

    expect(store.list()).toHaveLength(0);
  });

  test('creates ellipse annotation', () => {
    const {store, controller} = setupController();
    controller.setDrawingMode(true);
    controller.setTool('ellipse');

    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 300, posY: 180, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 300, posY: 180, buttons: 0}),
    );

    const annotations = store.list();
    expect(annotations).toHaveLength(1);
    expect(annotations[0].kind).toBe('ellipse');
  });

  describe('pen recognition paths', () => {
    test('pen recognition: 3px twitch discards stroke and stores nothing', () => {
      const {store, controller} = setupController();
      controller.setDrawingMode(true);
      controller.setTool('pen');

      controller.onPointerDown(
        createPointerEvent({posX: 100, posY: 150, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 102, posY: 151, buttons: 1}),
      );
      controller.onPointerUp(
        createPointerEvent({posX: 102, posY: 151, buttons: 0}),
      );

      expect(store.list()).toHaveLength(0);
    });

    test('pen recognition: 40px straight stroke recognizes as arrow', () => {
      const {store, controller} = setupController();
      controller.setDrawingMode(true);
      controller.setTool('pen');

      controller.onPointerDown(
        createPointerEvent({posX: 100, posY: 150, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 120, posY: 150, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 140, posY: 150, buttons: 1}),
      );
      controller.onPointerUp(
        createPointerEvent({posX: 140, posY: 150, buttons: 0}),
      );

      const annotations = store.list();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].kind).toBe('arrow');
    });

    test('pen recognition: rectangle loop recognizes as rect', () => {
      const {store, controller} = setupController();
      controller.setDrawingMode(true);
      controller.setTool('pen');

      controller.onPointerDown(
        createPointerEvent({posX: 100, posY: 110, buttons: 1}),
      );

      // Sample a clean closed rectangular loop
      for (let posX = 110; posX <= 200; posX += 10) {
        controller.onPointerMove(
          createPointerEvent({posX, posY: 110, buttons: 1}),
        );
      }
      for (let posY = 120; posY <= 180; posY += 10) {
        controller.onPointerMove(
          createPointerEvent({posX: 200, posY, buttons: 1}),
        );
      }
      for (let posX = 190; posX >= 100; posX -= 10) {
        controller.onPointerMove(
          createPointerEvent({posX, posY: 180, buttons: 1}),
        );
      }
      for (let posY = 170; posY >= 110; posY -= 10) {
        controller.onPointerMove(
          createPointerEvent({posX: 100, posY, buttons: 1}),
        );
      }

      controller.onPointerUp(
        createPointerEvent({posX: 100, posY: 110, buttons: 0}),
      );

      const annotations = store.list();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].kind).toBe('rect');
    });

    test('pen recognition: straight stroke recognizes as arrow', () => {
      const {store, controller} = setupController();
      controller.setDrawingMode(true);
      controller.setTool('pen');

      controller.onPointerDown(
        createPointerEvent({posX: 100, posY: 150, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 150, posY: 151, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 200, posY: 150, buttons: 1}),
      );
      controller.onPointerUp(
        createPointerEvent({posX: 200, posY: 150, buttons: 0}),
      );

      const annotations = store.list();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].kind).toBe('arrow');
    });

    test('pen recognition: squiggle creates path with anchored points', () => {
      const {store, controller} = setupController();
      controller.setDrawingMode(true);
      controller.setTool('pen');

      controller.onPointerDown(
        createPointerEvent({posX: 100, posY: 120, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 120, posY: 170, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 140, posY: 110, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 160, posY: 180, buttons: 1}),
      );
      controller.onPointerMove(
        createPointerEvent({posX: 180, posY: 120, buttons: 1}),
      );
      controller.onPointerUp(
        createPointerEvent({posX: 180, posY: 120, buttons: 0}),
      );

      const annotations = store.list();
      expect(annotations).toHaveLength(1);
      const annotation = annotations[0];
      expect(annotation.kind).toBe('path');
      if (annotation.kind === 'path') {
        expect(annotation.points.length).toBeGreaterThanOrEqual(2);
        expect(annotation.points[0].trackUri).toBe('track_1');
      }
    });
  });

  test('arrow tool snaps to existing annotation endpoint and creates arrow', () => {
    const {store, controller} = setupController();
    controller.setDrawingMode(true);

    const targetRect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(50n),
        end: Time.fromRaw(100n),
        trackUris: ['track_1'],
      },
    });

    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(targetRect.id, {
      id: targetRect.id,
      kind: 'rect',
      bbox: {
        left: 50,
        top: 100,
        right: 100,
        bottom: 200,
        width: 50,
        height: 100,
      },
    });
    controller.setGeometryProvider(() => geometries);

    controller.setTool('arrow');
    // Pointer down on targetRect
    controller.onPointerDown(
      createPointerEvent({posX: 75, posY: 150, buttons: 1}),
    );
    // Pointer up on empty track space
    controller.onPointerMove(
      createPointerEvent({posX: 250, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 250, posY: 150, buttons: 0}),
    );

    const arrows = store.list().filter((ann) => ann.kind === 'arrow');
    expect(arrows).toHaveLength(1);
    const arrow = arrows[0];
    if (arrow.kind === 'arrow') {
      expect(arrow.from).toEqual({kind: 'annotation', id: targetRect.id});
      expect(arrow.to.kind).toBe('point');
      if (arrow.to.kind === 'point') {
        expect(arrow.to.point.trackUri).toBe('track_1');
        expect(arrow.to.point.ts).toEqual(Time.fromRaw(250n));
      }
    }
  });

  test('label tool creates label on click', () => {
    const {store, controller, onAnnotationCreated} = setupController();
    controller.setDrawingMode(true);
    controller.setTool('label');

    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 150, posY: 150, buttons: 0}),
    );

    const annotations = store.list();
    expect(annotations).toHaveLength(1);
    const label = annotations[0];
    expect(label.kind).toBe('label');
    if (label.kind === 'label') {
      expect(label.text).toBe('Label');
      expect(label.position.trackUri).toBe('track_1');
      expect(label.position.yFrac).toBe(0.5);
    }
    expect(store.selectedId).toBe(label.id);
    expect(onAnnotationCreated).toHaveBeenCalledWith(label.id);
  });

  test('cancelGesture drops in-progress gesture', () => {
    const {store, controller, requestRedraw} = setupController();
    controller.setDrawingMode(true);
    controller.setTool('rect');

    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 180, buttons: 1}),
    );
    expect(controller.preview).toBeDefined();

    controller.cancelGesture();
    expect(controller.preview).toBeUndefined();

    // Subsequent pointer up should do nothing
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 180, buttons: 0}),
    );
    expect(store.list()).toHaveLength(0);
    expect(requestRedraw).toHaveBeenCalled();
  });

  test('select tool clicks to select, clears on empty space, and drags to move', () => {
    const {store, controller} = setupController();
    controller.setDrawingMode(true);

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(rect.id, {
      id: rect.id,
      kind: 'rect',
      bbox: {
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      },
    });
    controller.setGeometryProvider((id?: string) =>
      id ? geometries.get(id) : geometries,
    );

    controller.setTool('select');

    // 1. Click on rect selects it
    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 150, posY: 150, buttons: 0}),
    );
    expect(store.selectedId).toBe(rect.id);

    // 2. Click on empty space clears selection
    controller.onPointerDown(
      createPointerEvent({posX: 500, posY: 250, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 500, posY: 250, buttons: 0}),
    );
    expect(store.selectedId).toBeUndefined();

    // 3. Drag to move: horizontal shift and vertical re-anchoring to track2
    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 250, posY: 250, buttons: 1}),
    );
    expect(controller.preview).toEqual({
      kind: 'move',
      deltaX: 100,
      deltaY: 100,
      annotationId: rect.id,
    });
    controller.onPointerUp(
      createPointerEvent({posX: 250, posY: 250, buttons: 0}),
    );

    const updated = store.get(rect.id);
    expect(updated).toBeDefined();
    if (updated?.kind === 'rect') {
      expect(updated.anchor.start).toEqual(Time.fromRaw(200n));
      expect(updated.anchor.end).toEqual(Time.fromRaw(300n));
      expect(updated.anchor.trackUris).toEqual(['track_2']);
    }

    // Verify undo restores original anchor
    store.undo();
    const restored = store.get(rect.id);
    if (restored?.kind === 'rect') {
      expect(restored.anchor.start).toEqual(Time.fromRaw(100n));
      expect(restored.anchor.end).toEqual(Time.fromRaw(200n));
      expect(restored.anchor.trackUris).toEqual(['track_1']);
    }
  });

  test('activateTool enables drawingMode, and setDrawingMode(true) restores lastCreationTool from select', () => {
    const {controller} = setupController();
    expect(controller.tool).toBe('rect');
    expect(controller.drawingMode).toBe(false);

    // activateTool enables drawing mode
    controller.activateTool('pen');
    expect(controller.tool).toBe('pen');
    expect(controller.drawingMode).toBe(true);

    // Switching to select does not arm creation tool
    controller.setTool('select');
    expect(controller.tool).toBe('select');

    // Turning drawing mode off and back on restores pen
    controller.setDrawingMode(false);
    expect(controller.drawingMode).toBe(false);
    controller.setDrawingMode(true);
    expect(controller.drawingMode).toBe(true);
    expect(controller.tool).toBe('pen');
  });

  test('consumeAutoFocusId tracks and consumes auto-focus for label creation', () => {
    const {store, controller} = setupController();
    controller.activateTool('label');

    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 150, posY: 150, buttons: 0}),
    );

    const labels = store.list().filter((ann) => ann.kind === 'label');
    expect(labels).toHaveLength(1);
    const label = labels[0];
    expect(label.title).toBe('Label');
    expect(label.text).toBe('Label');
    expect(controller.pendingAutoFocusId).toBe(label.id);

    expect(controller.consumeAutoFocusId('non-existent-id')).toBe(false);
    expect(controller.consumeAutoFocusId(label.id)).toBe(true);
    expect(controller.pendingAutoFocusId).toBeUndefined();
    expect(controller.consumeAutoFocusId(label.id)).toBe(false);
  });

  test('dragging an arrow midpoint curve handle bends the arrow', () => {
    const {store, controller} = setupController();

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

    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(arrow.id, {
      id: arrow.id,
      kind: 'arrow',
      bbox: {
        left: 100,
        top: 150,
        right: 300,
        bottom: 150,
        width: 200,
        height: 0,
      },
      start: {x: 100, y: 150},
      end: {x: 300, y: 150},
      curveMidpoint: {x: 200, y: 150},
    });
    controller.setGeometryProvider((id?: string) =>
      id ? geometries.get(id) : geometries,
    );

    controller.setDrawingMode(false);
    controller.setTool('select');

    // Pointer down on curve handle (200, 150)
    controller.onPointerDown(
      createPointerEvent({posX: 200, posY: 150, buttons: 1}),
    );
    // Move to (200, 200) -> 50px normal displacement
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 200, buttons: 1}),
    );
    expect(controller.preview).toBeDefined();
    expect(controller.preview?.kind).toBe('arrow-curve');
    if (controller.preview?.kind === 'arrow-curve') {
      expect(controller.preview.annotationId).toBe(arrow.id);
    }

    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 200, buttons: 0}),
    );

    const curvedArrow = store.get(arrow.id);
    expect(curvedArrow?.kind).toBe('arrow');
    if (curvedArrow?.kind === 'arrow') {
      expect(curvedArrow.curvature).toBeDefined();
      expect(Math.abs(curvedArrow.curvature ?? 0)).toBeGreaterThan(10);
      expect(curvedArrow.controlOffset).toBeDefined();
    }

    // Now drag with very small displacement (< 3px) -> snaps back to straight
    controller.onPointerDown(
      createPointerEvent({posX: 200, posY: 150, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 151, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 151, buttons: 0}),
    );

    const snappedArrow = store.get(arrow.id);
    if (snappedArrow?.kind === 'arrow') {
      expect(snappedArrow.curvature).toBe(0);
      expect(snappedArrow.controlOffset).toBeUndefined();
    }
  });

  test('applies custom fillColor and fillOpacity to created annotations', () => {
    const {store, controller} = setupController();
    controller.activateTool('rect');
    controller.setFillColor('#123456');
    controller.setFillOpacity(0.4);

    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 180, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 180, buttons: 0}),
    );

    const annotations = store.list();
    expect(annotations).toHaveLength(1);
    expect(annotations[0].fillColor).toBe('#123456');
    expect(annotations[0].fillOpacity).toBe(0.4);
  });

  test('calls onAnnotationSelected when selecting annotation or curve handle', () => {
    const onAnnotationSelected = vi.fn();
    const {store, controller} = setupController({onAnnotationSelected});

    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(rect.id, {
      id: rect.id,
      kind: 'rect',
      bbox: {
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      },
    });
    controller.setGeometryProvider(() => geometries);

    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    expect(onAnnotationSelected).toHaveBeenCalledWith(rect.id);
  });

  test('hitTestPoint returns true on hit and false on miss', () => {
    const {store, controller} = setupController();
    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(rect.id, {
      id: rect.id,
      kind: 'rect',
      bbox: {
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      },
    });
    controller.setGeometryProvider(() => geometries);

    expect(controller.hitTestPoint({x: 150, y: 150}, rootNode)).toBe(true);
    expect(controller.hitTestPoint({x: 500, y: 500}, rootNode)).toBe(false);
  });

  test('consumeCreatedRect returns and clears rect recorded during creation', () => {
    const {store, controller} = setupController();
    controller.setDrawingMode(true);
    controller.setTool('rect');

    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 250, posY: 220, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 250, posY: 220, buttons: 0}),
    );

    const createdId = store.list()[0].id;
    const consumed = controller.consumeCreatedRect(createdId);
    expect(consumed).toEqual({
      left: 100,
      top: 120,
      right: 250,
      bottom: 220,
      width: 150,
      height: 100,
    });
    expect(controller.consumeCreatedRect(createdId)).toBeUndefined();
  });

  test('switches active tool to select after creating rect, ellipse, pen, arrow, label', () => {
    const {controller} = setupController();

    // 1. Rect
    controller.activateTool('rect');
    expect(controller.tool).toBe('rect');
    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 180, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 180, buttons: 0}),
    );
    expect(controller.tool).toBe('select');

    // 2. Ellipse
    controller.setTool('ellipse');
    expect(controller.tool).toBe('ellipse');
    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 180, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 180, buttons: 0}),
    );
    expect(controller.tool).toBe('select');

    // 3. Arrow
    controller.setTool('arrow');
    expect(controller.tool).toBe('arrow');
    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 250, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 250, posY: 150, buttons: 0}),
    );
    expect(controller.tool).toBe('select');

    // 4. Label
    controller.setTool('label');
    expect(controller.tool).toBe('label');
    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 150, posY: 150, buttons: 0}),
    );
    expect(controller.tool).toBe('select');

    // 5. Drag under 3px does not switch tool
    controller.setTool('rect');
    controller.onPointerDown(
      createPointerEvent({posX: 100, posY: 120, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 101, posY: 121, buttons: 0}),
    );
    expect(controller.tool).toBe('rect');
  });

  test('moves rect, label, and arrow annotations in select mode with exact drop position', () => {
    const {store, controller} = setupController();
    controller.setDrawingMode(true);

    // Test rect with topYFrac / bottomYFrac
    const rect = store.add({
      kind: 'rect',
      color: '#ff0000',
      anchor: {
        start: Time.fromRaw(100n),
        end: Time.fromRaw(200n),
        trackUris: ['track_1'],
      },
    });

    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(rect.id, {
      id: rect.id,
      kind: 'rect',
      bbox: {
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      },
    });
    controller.setGeometryProvider((id?: string) =>
      id ? geometries.get(id) : geometries,
    );

    controller.setTool('select');
    controller.onPointerDown(
      createPointerEvent({posX: 150, posY: 150, buttons: 1}),
    );
    // Shift by dx=+50, dy=+30 -> top=130, bottom=230 (intersects track1: [100, 200] and track2: [200, 300])
    controller.onPointerMove(
      createPointerEvent({posX: 200, posY: 180, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 200, posY: 180, buttons: 0}),
    );

    const updatedRect = store.get(rect.id);
    expect(updatedRect?.kind).toBe('rect');
    if (updatedRect?.kind === 'rect') {
      expect(updatedRect.anchor.trackUris).toEqual(['track_1', 'track_2']);
      expect(updatedRect.anchor.topYFrac).toBeCloseTo(0.3, 1);
      expect(updatedRect.anchor.bottomYFrac).toBeCloseTo(0.3, 1);
    }

    // Test label vertical center alignment
    const label = store.add({
      kind: 'label',
      color: '#00ff00',
      text: 'Test Label',
      position: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
    });
    geometries.set(label.id, {
      id: label.id,
      kind: 'label',
      bbox: {
        left: 100,
        top: 120,
        right: 180,
        bottom: 140,
        width: 80,
        height: 20, // vertical center is 130
      },
    });

    controller.onPointerDown(
      createPointerEvent({posX: 140, posY: 130, buttons: 1}),
    );
    // Shift by dx=+40, dy=+40 -> targetX=140, targetY=130+40=170
    // track_1 is [100, 200], so 170 corresponds to yFrac = (170-100)/100 = 0.70
    controller.onPointerMove(
      createPointerEvent({posX: 180, posY: 170, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 180, posY: 170, buttons: 0}),
    );

    const updatedLabel = store.get(label.id);
    expect(updatedLabel?.kind).toBe('label');
    if (updatedLabel?.kind === 'label') {
      expect(updatedLabel.position.yFrac).toBeCloseTo(0.7, 1);
    }

    // Test arrow moving both endpoints
    const arrow = store.add({
      kind: 'arrow',
      color: '#0000ff',
      from: {
        kind: 'point',
        point: {ts: Time.fromRaw(100n), trackUri: 'track_1', yFrac: 0.5},
      },
      to: {
        kind: 'point',
        point: {ts: Time.fromRaw(200n), trackUri: 'track_1', yFrac: 0.5},
      },
    });
    geometries.set(arrow.id, {
      id: arrow.id,
      kind: 'arrow',
      bbox: {
        left: 100,
        top: 150,
        right: 200,
        bottom: 150,
        width: 100,
        height: 0,
      },
      start: {x: 100, y: 150},
      end: {x: 200, y: 150},
    });

    controller.onPointerDown(
      createPointerEvent({posX: 125, posY: 150, buttons: 1}),
    );
    // Shift by dx=+50, dy=+80 -> start lands at y=230, end lands at y=230 (track_2 is [200, 300])
    controller.onPointerMove(
      createPointerEvent({posX: 175, posY: 230, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 175, posY: 230, buttons: 0}),
    );

    const updatedArrow = store.get(arrow.id);
    expect(updatedArrow?.kind).toBe('arrow');
    if (updatedArrow?.kind === 'arrow') {
      if (updatedArrow.from.kind === 'point') {
        expect(updatedArrow.from.point.trackUri).toBe('track_2');
        expect(updatedArrow.from.point.yFrac).toBeCloseTo(0.3, 1);
      }
      if (updatedArrow.to.kind === 'point') {
        expect(updatedArrow.to.point.trackUri).toBe('track_2');
        expect(updatedArrow.to.point.yFrac).toBeCloseTo(0.3, 1);
      }
    }
  });

  test('dragging arrow-control-1 and arrow-control-2 handles updates controlOffsets', () => {
    const {store, controller} = setupController();

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

    const cp1 = {x: 167, y: 150};
    const cp2 = {x: 233, y: 150};
    const geometries = new Map<string, AnnotationGeometry>();
    geometries.set(arrow.id, {
      id: arrow.id,
      kind: 'arrow',
      bbox: {
        left: 100,
        top: 150,
        right: 300,
        bottom: 150,
        width: 200,
        height: 0,
      },
      start: {x: 100, y: 150},
      end: {x: 300, y: 150},
      controlPoints: [cp1, cp2],
      curveMidpoint: {x: 200, y: 150},
    });
    controller.setGeometryProvider((id?: string) =>
      id ? geometries.get(id) : geometries,
    );

    controller.setDrawingMode(false);
    controller.setTool('select');

    // Drag cp1 at (167, 150) downwards by 40px to (167, 190)
    controller.onPointerDown(
      createPointerEvent({posX: 167, posY: 150, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 167, posY: 190, buttons: 1}),
    );
    expect(controller.preview?.kind).toBe('arrow-curve');

    controller.onPointerUp(
      createPointerEvent({posX: 167, posY: 190, buttons: 0}),
    );

    const curvedArrow = store.get(arrow.id);
    expect(curvedArrow?.kind).toBe('arrow');
    if (curvedArrow?.kind === 'arrow') {
      const controlOffsets = curvedArrow.controlOffsets;
      expect(controlOffsets).toBeDefined();
      expect(controlOffsets).toHaveLength(2);
      expect(controlOffsets?.[0].normalPx).toBeCloseTo(40, 0);
    }

    // Update geometry with the new cp1 for second drag
    geometries.set(arrow.id, {
      ...geometries.get(arrow.id)!,
      controlPoints: [{x: 167, y: 190}, cp2],
    });

    // Drag cp2 at (233, 150) upwards by 30px to (233, 120)
    controller.onPointerDown(
      createPointerEvent({posX: 233, posY: 150, buttons: 1}),
    );
    controller.onPointerMove(
      createPointerEvent({posX: 233, posY: 120, buttons: 1}),
    );
    controller.onPointerUp(
      createPointerEvent({posX: 233, posY: 120, buttons: 0}),
    );

    const curvedArrow2 = store.get(arrow.id);
    expect(curvedArrow2?.kind).toBe('arrow');
    if (curvedArrow2?.kind === 'arrow') {
      const controlOffsets2 = curvedArrow2.controlOffsets;
      expect(controlOffsets2).toBeDefined();
      expect(controlOffsets2?.[1].normalPx).toBeCloseTo(-30, 0);
    }
  });
});
