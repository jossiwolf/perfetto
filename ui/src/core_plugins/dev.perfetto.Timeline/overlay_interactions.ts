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

  const hasInteractive = overlays.some((o) => o.isInteractive?.() === true);
  if (!hasInteractive) {
    return undefined;
  }

  const gesture = args.gesture ?? {active: false};
  const cursor = getCursorForOverlays(overlays);

  function buildEvent(
    pos: Point2D,
    e: unknown,
    defaultButtons: number,
  ): OverlayPointerEvent {
    const x = pos.x;
    const y = pos.y;
    const ts = timescale.pxToHpTime(x).toTime();
    const track = findTrackAtY(tracks, y);

    const shiftKey = Boolean(
      typeof e === 'object' &&
      e !== null &&
      (e as {shiftKey?: boolean}).shiftKey,
    );
    const altKey = Boolean(
      typeof e === 'object' && e !== null && (e as {altKey?: boolean}).altKey,
    );
    const ctrlKey = Boolean(
      typeof e === 'object' && e !== null && (e as {ctrlKey?: boolean}).ctrlKey,
    );
    const metaKey = Boolean(
      typeof e === 'object' && e !== null && (e as {metaKey?: boolean}).metaKey,
    );
    const buttons = getButtons(e, defaultButtons);

    return {
      x,
      y,
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

  function emitPointerDown(pos: Point2D, e: unknown): void {
    const ev = buildEvent(pos, e, 1);
    for (const overlay of overlays) {
      if (overlay.isInteractive?.() === true) {
        overlay.onPointerDown?.(ev);
      }
    }
  }

  function emitPointerMove(pos: Point2D, e: unknown): void {
    const ev = buildEvent(pos, e, 1);
    for (const overlay of overlays) {
      if (overlay.isInteractive?.() === true) {
        overlay.onPointerMove?.(ev);
      }
    }
  }

  function emitPointerUp(pos: Point2D, e: unknown): void {
    const ev = buildEvent(pos, e, 0);
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
