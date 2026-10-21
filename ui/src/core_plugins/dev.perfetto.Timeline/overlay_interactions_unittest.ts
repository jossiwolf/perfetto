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

import {Rect2D, Vector2D} from '../../base/geom';
import {HighPrecisionTime} from '../../base/high_precision_time';
import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import {Time} from '../../base/time';
import {TimeScale} from '../../base/time_scale';
import {ZonedInteractionHandler} from '../../base/zoned_interaction_handler';
import type {
  Overlay,
  OverlayPointerEvent,
  TrackBounds,
} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import {
  createOverlayInteractionZone,
  type OverlayInteractionZoneArgs,
} from './overlay_interactions';

describe('overlay_interactions', () => {
  const rootNode = new TrackNode({name: 'root'});
  const trackNodeA = new TrackNode({name: 'trackA'});
  const trackNodeB = new TrackNode({name: 'trackB'});

  const tracks: ReadonlyArray<TrackBounds> = [
    {node: trackNodeA, verticalBounds: {top: 0, bottom: 50}},
    {node: trackNodeB, verticalBounds: {top: 50, bottom: 120}},
  ];

  const timelineRect = new Rect2D({
    left: 200,
    top: 0,
    right: 1000,
    bottom: 500,
  });

  const timescale = new TimeScale(
    new HighPrecisionTimeSpan(new HighPrecisionTime(Time.fromRaw(1000n)), 800),
    {left: 200, right: 1000},
  );

  function createArgs(
    overlays: ReadonlyArray<Overlay>,
    gesture?: {active: boolean},
  ): OverlayInteractionZoneArgs {
    return {
      overlays,
      timelineRect,
      timescale,
      tracks,
      rootNode,
      gesture,
    };
  }

  test('(a) returns undefined when there are no overlays or none is interactive', () => {
    // Empty list
    expect(createOverlayInteractionZone(createArgs([]))).toBeUndefined();

    // Overlays without isInteractive or returning false
    const renderOnlyOverlay: Overlay = {
      render: vi.fn(),
    };
    const nonInteractiveOverlay: Overlay = {
      render: vi.fn(),
      isInteractive: () => false,
    };

    expect(
      createOverlayInteractionZone(
        createArgs([renderOnlyOverlay, nonInteractiveOverlay]),
      ),
    ).toBeUndefined();
  });

  test('(b) with one interactive overlay, synthetic drag produces events with translated x, ts, track, buttons, and modifiers', () => {
    const onPointerDown = vi.fn();
    const onPointerMove = vi.fn();
    const onPointerUp = vi.fn();

    const interactiveOverlay: Overlay = {
      render: vi.fn(),
      isInteractive: () => true,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    };

    const zone = createOverlayInteractionZone(createArgs([interactiveOverlay]));
    expect(zone).toBeDefined();
    expect(zone?.id).toBe('overlay-interaction');
    expect(zone?.area).toBe(timelineRect);
    expect(zone?.cursor).toBe('crosshair');
    expect(zone?.drag?.cursorWhileDragging).toBe('crosshair');
    expect(zone?.drag?.minDistance).toBe(0);

    const syntheticDragStart = {
      dragStart: new Vector2D({x: 350, y: 30}),
      dragCurrent: new Vector2D({x: 350, y: 30}),
      dragDelta: new Vector2D({x: 0, y: 0}),
      deltaSinceLastEvent: new Vector2D({x: 0, y: 0}),
      altKey: true,
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      buttons: 1,
    };

    zone?.drag?.onDragStart?.(
      syntheticDragStart,
      document.createElement('div'),
    );

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    const downEv: OverlayPointerEvent = onPointerDown.mock.calls[0][0];
    expect(downEv.x).toBe(350);
    expect(downEv.y).toBe(30);
    expect(downEv.ts).toEqual(timescale.pxToHpTime(350).toTime());
    expect(downEv.track).toBe(tracks[0]);
    expect(downEv.tracks).toBe(tracks);
    expect(downEv.timescale).toBe(timescale);
    expect(downEv.rootNode).toBe(rootNode);
    expect(downEv.altKey).toBe(true);
    expect(downEv.shiftKey).toBe(false);
    expect(downEv.ctrlKey).toBe(true);
    expect(downEv.metaKey).toBe(false);
    expect(downEv.buttons).toBe(1);

    const syntheticDragMove = {
      dragStart: new Vector2D({x: 350, y: 30}),
      dragCurrent: new Vector2D({x: 500, y: 80}),
      dragDelta: new Vector2D({x: 150, y: 50}),
      deltaSinceLastEvent: new Vector2D({x: 150, y: 50}),
      altKey: false,
      shiftKey: true,
      ctrlKey: false,
      metaKey: true,
      buttons: 1,
    };

    zone?.drag?.onDrag?.(syntheticDragMove, document.createElement('div'));

    expect(onPointerMove).toHaveBeenCalledTimes(1);
    const moveEv: OverlayPointerEvent = onPointerMove.mock.calls[0][0];
    expect(moveEv.x).toBe(500);
    expect(moveEv.y).toBe(80);
    expect(moveEv.ts).toEqual(timescale.pxToHpTime(500).toTime());
    expect(moveEv.track).toBe(tracks[1]); // y=80 falls within trackB [50, 120)
    expect(moveEv.shiftKey).toBe(true);
    expect(moveEv.metaKey).toBe(true);
    expect(moveEv.buttons).toBe(1);

    const syntheticDragEnd = {
      dragStart: new Vector2D({x: 350, y: 30}),
      dragCurrent: new Vector2D({x: 600, y: 200}),
      dragDelta: new Vector2D({x: 250, y: 170}),
      deltaSinceLastEvent: new Vector2D({x: 100, y: 120}),
      altKey: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      buttons: 0,
    };

    zone?.drag?.onDragEnd?.(syntheticDragEnd, document.createElement('div'));

    expect(onPointerUp).toHaveBeenCalledTimes(1);
    const upEv: OverlayPointerEvent = onPointerUp.mock.calls[0][0];
    expect(upEv.x).toBe(600);
    expect(upEv.y).toBe(200);
    expect(upEv.ts).toEqual(timescale.pxToHpTime(600).toTime());
    expect(upEv.track).toBeUndefined(); // y=200 is outside any track bounds
    expect(upEv.buttons).toBe(0);
  });

  test('(c) non-interactive overlays in the same list are never called', () => {
    const interactiveOverlay: Overlay = {
      render: vi.fn(),
      isInteractive: () => true,
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
    };

    const passiveOverlayA: Overlay = {
      render: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
    };

    const passiveOverlayB: Overlay = {
      render: vi.fn(),
      isInteractive: () => false,
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
    };

    const zone = createOverlayInteractionZone(
      createArgs([passiveOverlayA, interactiveOverlay, passiveOverlayB]),
    );

    const dragStart = {
      dragStart: new Vector2D({x: 250, y: 10}),
      dragCurrent: new Vector2D({x: 250, y: 10}),
      dragDelta: new Vector2D({x: 0, y: 0}),
      deltaSinceLastEvent: new Vector2D({x: 0, y: 0}),
      altKey: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    };

    zone?.drag?.onDragStart?.(dragStart, document.createElement('div'));

    expect(interactiveOverlay.onPointerDown).toHaveBeenCalledTimes(1);
    expect(passiveOverlayA.onPointerDown).not.toHaveBeenCalled();
    expect(passiveOverlayB.onPointerDown).not.toHaveBeenCalled();
  });

  test('(d) two interactive overlays both receive events in registration order', () => {
    const callOrder: string[] = [];

    const overlayOne: Overlay = {
      render: vi.fn(),
      isInteractive: () => true,
      onPointerDown: () => callOrder.push('one-down'),
      onPointerMove: () => callOrder.push('one-move'),
      onPointerUp: () => callOrder.push('one-up'),
    };

    const overlayTwo: Overlay = {
      render: vi.fn(),
      isInteractive: () => true,
      onPointerDown: () => callOrder.push('two-down'),
      onPointerMove: () => callOrder.push('two-move'),
      onPointerUp: () => callOrder.push('two-up'),
    };

    const zone = createOverlayInteractionZone(
      createArgs([overlayOne, overlayTwo]),
    );

    const drag = {
      dragStart: new Vector2D({x: 300, y: 10}),
      dragCurrent: new Vector2D({x: 310, y: 10}),
      dragDelta: new Vector2D({x: 10, y: 0}),
      deltaSinceLastEvent: new Vector2D({x: 10, y: 0}),
      altKey: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    };

    zone?.drag?.onDragStart?.(drag, document.createElement('div'));
    zone?.drag?.onDrag?.(drag, document.createElement('div'));
    zone?.drag?.onDragEnd?.(drag, document.createElement('div'));

    expect(callOrder).toEqual([
      'one-down',
      'two-down',
      'one-move',
      'two-move',
      'one-up',
      'two-up',
    ]);
  });

  test('(e) hover moves: Zone does not support hover moves so onPointerMove is drag-only', () => {
    // Note: The Zone interface in ui/src/base/zoned_interaction_handler.ts defines:
    // id, area, cursor, keyModifier, drag, onClick, onWheel.
    // It has no onMouseMove / onHover callback. Therefore onPointerMove is invoked
    // strictly during drag gestures.
    const interactiveOverlay: Overlay = {
      render: vi.fn(),
      isInteractive: () => true,
      onPointerMove: vi.fn(),
    };
    const zone = createOverlayInteractionZone(createArgs([interactiveOverlay]));
    expect(zone).toBeDefined();
    // Verify zone has no hover callback
    expect('onMouseMove' in (zone ?? {})).toBe(false);
  });

  test('click without movement emits onPointerDown then onPointerUp', () => {
    const events: string[] = [];
    const interactiveOverlay: Overlay = {
      render: vi.fn(),
      isInteractive: () => true,
      onPointerDown: () => events.push('down'),
      onPointerUp: () => events.push('up'),
    };

    const zone = createOverlayInteractionZone(createArgs([interactiveOverlay]));

    // Click via onClick handler
    zone?.onClick?.({position: new Vector2D({x: 250, y: 20})});

    expect(events).toEqual(['down', 'up']);

    // Click without movement via onDragEnd when onDragStart was not invoked
    events.length = 0;
    const zeroDistanceDrag = {
      dragStart: new Vector2D({x: 300, y: 25}),
      dragCurrent: new Vector2D({x: 300, y: 25}),
      dragDelta: new Vector2D({x: 0, y: 0}),
      deltaSinceLastEvent: new Vector2D({x: 0, y: 0}),
      altKey: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    };
    zone?.drag?.onDragEnd?.(zeroDistanceDrag, document.createElement('div'));

    expect(events).toEqual(['down', 'up']);
  });

  describe('integration with ZonedInteractionHandler', () => {
    let div: HTMLElement;
    let handler: ZonedInteractionHandler;

    beforeEach(() => {
      div = document.createElement('div');
      div.style.width = '1000px';
      div.style.height = '500px';
      document.body.appendChild(div);
      handler = new ZonedInteractionHandler(div);
    });

    afterEach(() => {
      handler[Symbol.dispose]();
      div.remove();
    });

    function dispatchMouseEvent(
      type: string,
      clientX: number,
      clientY: number,
    ) {
      div.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          clientX,
          clientY,
        }),
      );
    }

    test('real DOM drag gesture routes down, move, up to interactive overlay', () => {
      const onPointerDown = vi.fn();
      const onPointerMove = vi.fn();
      const onPointerUp = vi.fn();

      const overlay: Overlay = {
        render: vi.fn(),
        isInteractive: () => true,
        onPointerDown,
        onPointerMove,
        onPointerUp,
      };

      const zone = createOverlayInteractionZone(createArgs([overlay]));
      expect(zone).toBeDefined();

      const fallbackClick = vi.fn();
      handler.update([
        zone,
        {
          id: 'fallback-area',
          area: timelineRect,
          onClick: fallbackClick,
        },
      ]);

      // Drag sequence
      dispatchMouseEvent('mousedown', 300, 20);
      dispatchMouseEvent('mousemove', 350, 40);
      dispatchMouseEvent('mouseup', 350, 40);

      expect(onPointerDown).toHaveBeenCalledTimes(1);
      expect(onPointerMove).toHaveBeenCalledTimes(1);
      expect(onPointerUp).toHaveBeenCalledTimes(1);
      expect(fallbackClick).not.toHaveBeenCalled();

      expect(onPointerDown.mock.calls[0][0].x).toBe(300);
      expect(onPointerMove.mock.calls[0][0].x).toBe(350);
      expect(onPointerUp.mock.calls[0][0].x).toBe(350);
    });

    test('rebuilding the zone between synthetic move events emits a single down and single up', () => {
      const onPointerDown = vi.fn();
      const onPointerMove = vi.fn();
      const onPointerUp = vi.fn();

      const overlay: Overlay = {
        render: vi.fn(),
        isInteractive: () => true,
        onPointerDown,
        onPointerMove,
        onPointerUp,
      };

      const gestureState = {active: false};
      const element = document.createElement('div');

      // Frame 1: Build zone and start drag
      const zone1 = createOverlayInteractionZone(
        createArgs([overlay], gestureState),
      );
      expect(zone1).toBeDefined();

      const moveEvent1 = {
        dragStart: new Vector2D({x: 300, y: 20}),
        dragCurrent: new Vector2D({x: 320, y: 20}),
        dragDelta: new Vector2D({x: 20, y: 0}),
        deltaSinceLastEvent: new Vector2D({x: 20, y: 0}),
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        buttons: 1,
      };
      zone1?.drag?.onDrag?.(moveEvent1, element);

      expect(onPointerDown).toHaveBeenCalledTimes(1);
      expect(onPointerMove).toHaveBeenCalledTimes(1);
      expect(gestureState.active).toBe(true);

      // Frame 2: Rebuild zone (simulating next RAF frame) with same gestureState
      const zone2 = createOverlayInteractionZone(
        createArgs([overlay], gestureState),
      );
      expect(zone2).toBeDefined();

      const moveEvent2 = {
        dragStart: new Vector2D({x: 300, y: 20}),
        dragCurrent: new Vector2D({x: 340, y: 20}),
        dragDelta: new Vector2D({x: 40, y: 0}),
        deltaSinceLastEvent: new Vector2D({x: 20, y: 0}),
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        buttons: 1,
      };
      zone2?.drag?.onDrag?.(moveEvent2, element);

      // Down should NOT have been called a second time
      expect(onPointerDown).toHaveBeenCalledTimes(1);
      expect(onPointerMove).toHaveBeenCalledTimes(2);

      // Frame 3: End drag on new zone
      const endEvent = {
        dragStart: new Vector2D({x: 300, y: 20}),
        dragCurrent: new Vector2D({x: 350, y: 20}),
        dragDelta: new Vector2D({x: 50, y: 0}),
        deltaSinceLastEvent: new Vector2D({x: 10, y: 0}),
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        buttons: 0,
      };
      zone2?.drag?.onDragEnd?.(endEvent, element);

      expect(onPointerDown).toHaveBeenCalledTimes(1);
      expect(onPointerUp).toHaveBeenCalledTimes(1);
      expect(gestureState.active).toBe(false);
    });

    test('zone obtains cursor from optional getCursor on interactive overlay', () => {
      const overlayWithCursor: Overlay & {getCursor(): string} = {
        render: vi.fn(),
        isInteractive: () => true,
        getCursor: () => 'default',
      };
      const zone = createOverlayInteractionZone(
        createArgs([overlayWithCursor]),
      );
      expect(zone?.cursor).toBe('default');
      expect(zone?.drag?.cursorWhileDragging).toBe('default');
    });

    test('built-in zones receive events when no overlay is interactive', () => {
      const overlay: Overlay = {
        render: vi.fn(),
        isInteractive: () => false,
      };

      const zone = createOverlayInteractionZone(createArgs([overlay]));
      expect(zone).toBeUndefined();

      const builtInClick = vi.fn();
      handler.update([
        zone,
        {
          id: 'built-in',
          area: timelineRect,
          onClick: builtInClick,
        },
      ]);

      dispatchMouseEvent('mousedown', 300, 20);
      dispatchMouseEvent('mouseup', 300, 20);
      dispatchMouseEvent('click', 300, 20);

      expect(builtInClick).toHaveBeenCalledTimes(1);
    });
  });
});
