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

import type {Point2D, Rect2D} from '../../base/geom';
import type {TimeScale} from '../../base/time_scale';
import type {CSSCursor} from '../../base/dom_utils';
import type {
  ClickEvent,
  DragEvent,
  Zone,
} from '../../base/zoned_interaction_handler';
import type {
  Overlay,
  OverlayInteractionContext,
  OverlayPointerEvent,
  TrackBounds,
} from '../../public/track';
import type {TrackNode} from '../../public/workspace';

export interface OverlayGestureState {
  active: boolean;
}

export interface OverlayInteractionZoneArgs {
  readonly overlays: ReadonlyArray<Overlay>;
  readonly timelineRect: Rect2D;
  readonly timescale: TimeScale;
  readonly tracks: ReadonlyArray<TrackBounds>;
  readonly rootNode: TrackNode;
  readonly gesture?: OverlayGestureState;
}

function findTrackAtY(
  tracks: ReadonlyArray<TrackBounds>,
  y: number,
): TrackBounds | undefined {
  for (const track of tracks) {
    if (y >= track.verticalBounds.top && y < track.verticalBounds.bottom) {
      return track;
    }
  }
  return undefined;
}

function getButtons(e: unknown, defaultButtons: number): number {
  if (
    typeof e === 'object' &&
    e !== null &&
    'buttons' in e &&
    typeof (e as {buttons: unknown}).buttons === 'number'
  ) {
    return (e as {buttons: number}).buttons;
  }
  return defaultButtons;
}

function getCursorForOverlays(overlays: ReadonlyArray<Overlay>): CSSCursor {
  for (const overlay of overlays) {
    if (overlay.isInteractive?.() === true) {
      const maybeWithCursor = overlay as {getCursor?(): string | undefined};
      const customCursor = maybeWithCursor.getCursor?.();
      if (typeof customCursor === 'string') {
        return customCursor as CSSCursor;
      }
    }
  }
  return 'crosshair';
}

function buildOverlayPointerEvent(
  pos: Point2D,
  event: unknown,
  defaultButtons: number,
  timescale: TimeScale,
  tracks: ReadonlyArray<TrackBounds>,
  rootNode: TrackNode,
): OverlayPointerEvent {
  const posX = pos.x;
  const posY = pos.y;
  const ts = timescale.pxToHpTime(posX).toTime();
  const track = findTrackAtY(tracks, posY);

  const shiftKey = Boolean(
    typeof event === 'object' &&
    event !== null &&
    (event as {shiftKey?: boolean}).shiftKey,
  );
  const altKey = Boolean(
    typeof event === 'object' &&
    event !== null &&
    (event as {altKey?: boolean}).altKey,
  );
  const ctrlKey = Boolean(
    typeof event === 'object' &&
    event !== null &&
    (event as {ctrlKey?: boolean}).ctrlKey,
  );
  const metaKey = Boolean(
    typeof event === 'object' &&
    event !== null &&
    (event as {metaKey?: boolean}).metaKey,
  );
  const buttons = getButtons(event, defaultButtons);

  return {
    x: posX,
    y: posY,
    ts,
    track,
    tracks,
    timescale,
    rootNode,
    buttons,
    shiftKey,
    altKey,
    ctrlKey,
    metaKey,
  };
}

/**
 * Creates an interaction Zone for interactive overlays.
 *
 * When one or more registered overlays return isInteractive() === true,
 * this zone captures pointer gestures in the timeline content area,
 * suppressing built-in gestures (area selection, shift-drag pan, etc.)
 * and dispatching pointer events to interactive overlays in registration order.
 *
 * Returns undefined if no overlays are registered or none is interactive.
 */
export function createOverlayInteractionZone(
  args: OverlayInteractionZoneArgs,
): Zone | undefined {
  const {overlays, timelineRect, timescale, tracks, rootNode} = args;

  const hasInteractive = overlays.some(
    (overlay) => overlay.isInteractive?.() === true,
  );
  if (!hasInteractive) {
    return undefined;
  }

  const gesture = args.gesture ?? {active: false};
  const cursor = getCursorForOverlays(overlays);

  function emitPointerDown(pos: Point2D, e: unknown): void {
    const ev = buildOverlayPointerEvent(pos, e, 1, timescale, tracks, rootNode);
    for (const overlay of overlays) {
      if (overlay.isInteractive?.() === true) {
        overlay.onPointerDown?.(ev);
      }
    }
  }

  function emitPointerMove(pos: Point2D, e: unknown): void {
    const ev = buildOverlayPointerEvent(pos, e, 1, timescale, tracks, rootNode);
    for (const overlay of overlays) {
      if (overlay.isInteractive?.() === true) {
        overlay.onPointerMove?.(ev);
      }
    }
  }

  function emitPointerUp(pos: Point2D, e: unknown): void {
    const ev = buildOverlayPointerEvent(pos, e, 0, timescale, tracks, rootNode);
    for (const overlay of overlays) {
      if (overlay.isInteractive?.() === true) {
        overlay.onPointerUp?.(ev);
      }
    }
  }

  return {
    id: 'overlay-interaction',
    area: timelineRect,
    cursor,
    drag: {
      minDistance: 0,
      cursorWhileDragging: cursor,
      onDragStart: (e: DragEvent) => {
        if (!gesture.active) {
          emitPointerDown(e.dragStart, e);
          gesture.active = true;
        }
      },
      onDrag: (e: DragEvent) => {
        if (!gesture.active) {
          emitPointerDown(e.dragStart, e);
          gesture.active = true;
        }
        emitPointerMove(e.dragCurrent, e);
      },
      onDragEnd: (e: DragEvent) => {
        if (!gesture.active) {
          emitPointerDown(e.dragStart, e);
        }
        emitPointerUp(e.dragCurrent, e);
        gesture.active = false;
      },
    },
    onClick: (e: ClickEvent) => {
      if (!gesture.active) {
        emitPointerDown(e.position, e);
      }
      emitPointerUp(e.position, e);
      gesture.active = false;
    },
  };
}

/**
 * Creates interaction Zones for overlays.
 *
 * Collects fine-grained interaction zones returned by overlays via
 * getInteractionZones(), and if any overlay has isInteractive() === true,
 * also includes the full-canvas interaction zone. Fine-grained zones
 * precede the full-canvas zone so their cursors and hit detection take priority.
 */
export function createOverlayInteractionZones(
  args: OverlayInteractionZoneArgs,
): ReadonlyArray<Zone> {
  const {overlays, timelineRect, timescale, tracks, rootNode} = args;
  const gesture = args.gesture ?? {active: false};
  const context: OverlayInteractionContext = {
    timelineRect,
    timescale,
    tracks,
    rootNode,
  };

  const fineGrainedZones: Zone[] = [];
  for (const overlay of overlays) {
    const interactionZones = overlay.getInteractionZones?.(context);
    if (interactionZones) {
      for (const zoneSpec of interactionZones) {
        const zoneCursor: CSSCursor = (zoneSpec.cursor ??
          'pointer') as CSSCursor;
        fineGrainedZones.push({
          id: `overlay-zone:${zoneSpec.id}`,
          area: zoneSpec.area,
          cursor: zoneCursor,
          drag: {
            minDistance: 0,
            cursorWhileDragging: zoneCursor,
            onDragStart: (e: DragEvent) => {
              if (!gesture.active) {
                const ev = buildOverlayPointerEvent(
                  e.dragStart,
                  e,
                  1,
                  timescale,
                  tracks,
                  rootNode,
                );
                overlay.onPointerDown?.(ev);
                gesture.active = true;
              }
            },
            onDrag: (e: DragEvent) => {
              if (!gesture.active) {
                const ev = buildOverlayPointerEvent(
                  e.dragStart,
                  e,
                  1,
                  timescale,
                  tracks,
                  rootNode,
                );
                overlay.onPointerDown?.(ev);
                gesture.active = true;
              }
              const ev = buildOverlayPointerEvent(
                e.dragCurrent,
                e,
                1,
                timescale,
                tracks,
                rootNode,
              );
              overlay.onPointerMove?.(ev);
            },
            onDragEnd: (e: DragEvent) => {
              if (!gesture.active) {
                const ev = buildOverlayPointerEvent(
                  e.dragStart,
                  e,
                  1,
                  timescale,
                  tracks,
                  rootNode,
                );
                overlay.onPointerDown?.(ev);
              }
              const ev = buildOverlayPointerEvent(
                e.dragCurrent,
                e,
                0,
                timescale,
                tracks,
                rootNode,
              );
              overlay.onPointerUp?.(ev);
              gesture.active = false;
            },
          },
          onClick: (e: ClickEvent) => {
            if (!gesture.active) {
              const evDown = buildOverlayPointerEvent(
                e.position,
                e,
                1,
                timescale,
                tracks,
                rootNode,
              );
              overlay.onPointerDown?.(evDown);
            }
            const evUp = buildOverlayPointerEvent(
              e.position,
              e,
              0,
              timescale,
              tracks,
              rootNode,
            );
            overlay.onPointerUp?.(evUp);
            gesture.active = false;
          },
        });
      }
    }
  }

  const fullCanvasZone = createOverlayInteractionZone({
    ...args,
    gesture,
  });

  if (fullCanvasZone !== undefined) {
    return [...fineGrainedZones, fullCanvasZone];
  }
  return fineGrainedZones;
}
