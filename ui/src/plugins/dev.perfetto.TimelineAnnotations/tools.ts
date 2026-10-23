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

import {Time} from '../../base/time';
import type {Point2D} from '../../base/geom';
import type {OverlayPointerEvent, TrackBounds} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import type {
  AnchoredPoint,
  Annotation,
  AreaAnchor,
  ArrowControlOffset,
  ArrowEndpoint,
  AnnotationStore,
} from './model';
import {areaForTrackRange, pointAtY, resolveTrackY} from './anchor';
import * as geomModule from './geometry';
import {
  bboxOf,
  computeQuadraticControlPoint,
  curvatureFromMidpoint,
  hitTestEllipse,
  hitTestPolyline,
  hitTestQuadraticBezier,
  hitTestRect,
  hitTestSegment,
  recognizeShape,
  type RectBounds,
  simplifyPath,
  smoothPath,
} from './geometry';

// Local cubic bezier helpers with fallback to geometry.ts exports if available
export function localComputeCubicBaseControlPoints(
  start: Point2D,
  end: Point2D,
): [Point2D, Point2D] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= 24) {
    const base1 = {x: start.x + dx * 0.38, y: start.y + dy * 0.08};
    const base2 = {x: end.x - dx * 0.38, y: end.y - dy * 0.08};
    return [base1, base2];
  } else {
    const base1 = {x: start.x + dx * 0.33, y: start.y + dy * 0.33};
    const base2 = {x: start.x + dx * 0.67, y: start.y + dy * 0.67};
    return [base1, base2];
  }
}

export function localComputeCubicControlPoints(
  start: Point2D,
  end: Point2D,
  controlOffsets?: readonly [
    {
      readonly dxFrac?: number;
      readonly dyPx?: number;
      readonly alongFrac?: number;
      readonly normalPx?: number;
    },
    {
      readonly dxFrac?: number;
      readonly dyPx?: number;
      readonly alongFrac?: number;
      readonly normalPx?: number;
    },
  ],
  legacyControlOffset?: {
    readonly dxFrac?: number;
    readonly dyPx?: number;
    readonly alongFrac?: number;
    readonly normalPx?: number;
  },
): [Point2D, Point2D] {
  const [base1, base2] = localComputeCubicBaseControlPoints(start, end);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const span = Math.max(Math.hypot(dx, dy), 1);

  if (controlOffsets && controlOffsets.length === 2) {
    const off0Dx = controlOffsets[0].dxFrac ?? controlOffsets[0].alongFrac ?? 0;
    const off0Dy = controlOffsets[0].dyPx ?? controlOffsets[0].normalPx ?? 0;
    const off1Dx = controlOffsets[1].dxFrac ?? controlOffsets[1].alongFrac ?? 0;
    const off1Dy = controlOffsets[1].dyPx ?? controlOffsets[1].normalPx ?? 0;
    return [
      {
        x: base1.x + off0Dx * span,
        y: base1.y + off0Dy,
      },
      {
        x: base2.x + off1Dx * span,
        y: base2.y + off1Dy,
      },
    ];
  }

  if (legacyControlOffset !== undefined) {
    const normalPx =
      legacyControlOffset.normalPx ?? legacyControlOffset.dyPx ?? 0;
    let nx = 0;
    let ny = -1;
    if (span > 1e-6) {
      nx = -dy / span;
      ny = dx / span;
    }
    const dispX = nx * normalPx;
    const dispY = ny * normalPx;
    return [
      {x: base1.x + dispX, y: base1.y + dispY},
      {x: base2.x + dispX, y: base2.y + dispY},
    ];
  }

  return [base1, base2];
}

export function localEvaluateCubicBezier(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  t: number,
): Point2D {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

export function localEvaluateCubicBezierTangent(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  t: number,
): Point2D {
  const u = 1 - t;
  const tangentX =
    3 * u * u * (p1.x - p0.x) +
    6 * u * t * (p2.x - p1.x) +
    3 * t * t * (p3.x - p2.x);
  const tangentY =
    3 * u * u * (p1.y - p0.y) +
    6 * u * t * (p2.y - p1.y) +
    3 * t * t * (p3.y - p2.y);
  if (Math.hypot(tangentX, tangentY) < 1e-4) {
    return {x: p3.x - p0.x, y: p3.y - p0.y};
  }
  return {x: tangentX, y: tangentY};
}

export function localSampleCubicBezier(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  steps = 24,
): Point2D[] {
  const count = Math.max(2, steps);
  const points: Point2D[] = [];
  for (let index = 0; index <= count; index += 1) {
    points.push(localEvaluateCubicBezier(p0, p1, p2, p3, index / count));
  }
  return points;
}

export function localHitTestCubicBezier(
  pt: Point2D,
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  tolerancePx: number,
  steps = 32,
): boolean {
  const sampled = localSampleCubicBezier(p0, p1, p2, p3, steps);
  return hitTestPolyline(pt, sampled, tolerancePx);
}

export function localComputeCubicBezierBoundingBox(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  paddingPx = 12,
): RectBounds {
  const sampled = localSampleCubicBezier(p0, p1, p2, p3, 24);
  const baseBox = bboxOf(sampled);
  return {
    left: baseBox.left - paddingPx,
    top: baseBox.top - paddingPx,
    right: baseBox.right + paddingPx,
    bottom: baseBox.bottom + paddingPx,
    width: baseBox.width + 2 * paddingPx,
    height: baseBox.height + 2 * paddingPx,
  };
}

const computeCubicBaseControlPoints =
  (
    geomModule as {
      computeCubicBaseControlPoints?: typeof localComputeCubicBaseControlPoints;
    }
  ).computeCubicBaseControlPoints ?? localComputeCubicBaseControlPoints;

const hitTestCubicBezier =
  (geomModule as {hitTestCubicBezier?: typeof localHitTestCubicBezier})
    .hitTestCubicBezier ?? localHitTestCubicBezier;

export type ToolKind =
  'select' | 'rect' | 'ellipse' | 'pen' | 'arrow' | 'label';

export const TOOL_KINDS: ReadonlyArray<ToolKind> = [
  'select',
  'rect',
  'ellipse',
  'pen',
  'arrow',
  'label',
] as const;

export type GesturePreview =
  | {
      readonly kind: 'rect';
      readonly rect: RectBounds;
      readonly color: string;
    }
  | {
      readonly kind: 'ellipse';
      readonly rect: RectBounds;
      readonly color: string;
    }
  | {
      readonly kind: 'pen';
      readonly points: ReadonlyArray<Point2D>;
      readonly color: string;
    }
  | {
      readonly kind: 'arrow';
      readonly from: Point2D;
      readonly to: Point2D;
      readonly color: string;
    }
  | {
      readonly kind: 'move';
      readonly deltaX: number;
      readonly deltaY: number;
      readonly annotationId: string;
    }
  | {
      readonly kind: 'arrow-curve';
      readonly annotationId: string;
      readonly start: Point2D;
      readonly control: Point2D;
      readonly controlPoints?: readonly [Point2D, Point2D];
      readonly end: Point2D;
      readonly color: string;
    };

export interface ToolControllerOptions {
  readonly requestRedraw: () => void;
  readonly defaultColor?: () => string;
  readonly onAnnotationCreated?: (id: string) => void;
  readonly onAnnotationSelected?: (id: string) => void;
}

export interface AnnotationGeometry {
  readonly id: string;
  readonly kind: Annotation['kind'];
  readonly bbox: RectBounds;
  readonly polyline?: ReadonlyArray<Point2D>;
  readonly start?: Point2D;
  readonly end?: Point2D;
  readonly control?: Point2D;
  readonly controlPoints?: readonly [Point2D, Point2D];
  readonly curveMidpoint?: Point2D;
}

export type GeometryProvider = (
  id?: string,
  rootNode?: TrackNode,
) => AnnotationGeometry | ReadonlyMap<string, AnnotationGeometry> | undefined;

interface ActiveGesture {
  readonly tool: ToolKind | 'arrow-curve';
  readonly startEvent: OverlayPointerEvent;
  currentEvent: OverlayPointerEvent;
  penPoints?: Point2D[];
  arrowFrom?: ArrowEndpoint;
  selectedTargetId?: string;
  initialAnchor?: AreaAnchor;
  initialPosition?: AnchoredPoint;
  initialPoints?: ReadonlyArray<AnchoredPoint>;
  isDrag: boolean;
  curveTargetId?: string;
  arrowStartPx?: Point2D;
  arrowEndPx?: Point2D;
  controlHandleId?: 'arrow-control-1' | 'arrow-control-2' | 'arrow-midpoint';
  origControlPoints?: [Point2D, Point2D];
}

import {PALETTE_COLORS} from './annotations_tab';

export const DEFAULT_TOOL_COLOR = PALETTE_COLORS[1].value;
const MIN_DRAG_DISTANCE_PX = 3;
const HIT_TEST_TOLERANCE_PX = 5;
const MAX_PATH_POINTS_COUNT = 256;
const PEN_LINE_MIN_CHORD_PX = 15;
const PEN_SHAPE_MIN_DIMENSION_PX = 10;

export class ToolController {
  private readonly store: AnnotationStore;
  private readonly opts: ToolControllerOptions;
  private readonly createdFromRects = new Map<string, RectBounds>();
  private isDrawingModeActive: boolean = false;
  private activeToolKind: ToolKind = 'rect';
  private lastCreationTool: Exclude<ToolKind, 'select'> = 'rect';
  private activeStrokeColor: string;
  private activeFillColor?: string;
  private activeFillOpacity?: number;
  private pendingAutoFocusAnnotationId?: string;
  private activeGesturePreview?: GesturePreview;
  private activeGestureState?: ActiveGesture;
  private geometryProviderFn?: GeometryProvider;

  constructor(store: AnnotationStore, opts: ToolControllerOptions) {
    this.store = store;
    this.opts = opts;
    this.activeStrokeColor = opts.defaultColor?.() ?? DEFAULT_TOOL_COLOR;
  }

  get drawingMode(): boolean {
    return this.isDrawingModeActive;
  }

  setDrawingMode(on: boolean): void {
    let changed = false;
    if (this.isDrawingModeActive !== on) {
      this.isDrawingModeActive = on;
      changed = true;
      if (!on) {
        this.cancelGesture();
      }
    }
    if (on && this.activeToolKind === 'select') {
      this.activeToolKind = this.lastCreationTool;
      changed = true;
    }
    if (changed) {
      this.opts.requestRedraw();
    }
  }

  toggleDrawingMode(): boolean {
    this.setDrawingMode(!this.isDrawingModeActive);
    return this.isDrawingModeActive;
  }

  get tool(): ToolKind {
    return this.activeToolKind;
  }

  setTool(tool: ToolKind): void {
    if (tool !== 'select') {
      this.lastCreationTool = tool;
    }
    if (this.activeToolKind !== tool) {
      this.cancelGesture();
      this.activeToolKind = tool;
      this.opts.requestRedraw();
    }
  }

  activateTool(tool: ToolKind): void {
    this.setTool(tool);
    if (tool !== 'select') {
      this.setDrawingMode(true);
    }
  }

  get color(): string {
    return this.activeStrokeColor;
  }

  setColor(color: string): void {
    if (this.activeStrokeColor !== color) {
      this.activeStrokeColor = color;
      this.opts.requestRedraw();
    }
  }

  get fillColor(): string | undefined {
    return this.activeFillColor;
  }

  setFillColor(fillColor: string | undefined): void {
    if (this.activeFillColor !== fillColor) {
      this.activeFillColor = fillColor;
      this.opts.requestRedraw();
    }
  }

  get fillOpacity(): number | undefined {
    return this.activeFillOpacity;
  }

  setFillOpacity(fillOpacity: number | undefined): void {
    if (this.activeFillOpacity !== fillOpacity) {
      this.activeFillOpacity = fillOpacity;
      this.opts.requestRedraw();
    }
  }

  get pendingAutoFocusId(): string | undefined {
    return this.pendingAutoFocusAnnotationId;
  }

  requestAutoFocus(id: string): void {
    this.pendingAutoFocusAnnotationId = id;
  }

  consumeAutoFocusId(id: string): boolean {
    if (this.pendingAutoFocusAnnotationId === id) {
      this.pendingAutoFocusAnnotationId = undefined;
      return true;
    }
    return false;
  }

  isInteractive(): boolean {
    return this.isDrawingModeActive;
  }

  get preview(): GesturePreview | undefined {
    return this.activeGesturePreview;
  }

  get hoverCursor(): string | undefined {
    if (!this.isDrawingModeActive) {
      return undefined;
    }
    switch (this.activeToolKind) {
      case 'select':
        return 'default';
      case 'rect':
      case 'ellipse':
      case 'pen':
      case 'arrow':
      case 'label':
        return 'crosshair';
    }
  }

  setGeometryProvider(provider: GeometryProvider | undefined): void {
    this.geometryProviderFn = provider;
  }

  cancelGesture(): void {
    if (
      this.activeGestureState !== undefined ||
      this.activeGesturePreview !== undefined
    ) {
      this.activeGestureState = undefined;
      this.activeGesturePreview = undefined;
      this.opts.requestRedraw();
    }
  }

  consumeCreatedRect(id: string): RectBounds | undefined {
    const rect = this.createdFromRects.get(id);
    if (rect !== undefined) {
      this.createdFromRects.delete(id);
    }
    return rect;
  }

  readonly requestRedraw = (): void => {
    this.opts.requestRedraw();
  };

  hitTestPoint(point: Point2D, rootNode?: TrackNode): boolean {
    return (
      this.hitTestCurveHandle(point, rootNode) !== undefined ||
      this.hitTestAnnotation(point, rootNode) !== undefined
    );
  }

  onPointerDown(event: OverlayPointerEvent): void {
    const pointerPos: Point2D = {x: event.x, y: event.y};

    if (!this.isDrawingModeActive || this.activeToolKind === 'select') {
      const hitCurveInfo = this.hitTestCurveHandle(pointerPos, event.rootNode);
      if (
        hitCurveInfo !== undefined &&
        hitCurveInfo.geom.start !== undefined &&
        hitCurveInfo.geom.end !== undefined
      ) {
        this.store.select(hitCurveInfo.geom.id);
        this.opts.onAnnotationSelected?.(hitCurveInfo.geom.id);

        const [cp1, cp2] =
          hitCurveInfo.geom.controlPoints ??
          computeCubicBaseControlPoints(
            hitCurveInfo.geom.start,
            hitCurveInfo.geom.end,
          );

        this.activeGestureState = {
          tool: 'arrow-curve',
          startEvent: event,
          currentEvent: event,
          curveTargetId: hitCurveInfo.geom.id,
          arrowStartPx: hitCurveInfo.geom.start,
          arrowEndPx: hitCurveInfo.geom.end,
          controlHandleId: hitCurveInfo.handleId,
          origControlPoints: [cp1, cp2],
          isDrag: false,
        };
        this.opts.requestRedraw();
        return;
      }

      const hitAnnotation = this.hitTestAnnotation(pointerPos, event.rootNode);
      if (!this.isDrawingModeActive && hitAnnotation === undefined) {
        if (!event.shiftKey && this.store.selectedId !== undefined) {
          this.store.select(undefined);
          this.opts.requestRedraw();
        }
        return;
      }

      if (hitAnnotation !== undefined) {
        if (event.shiftKey) {
          if (this.store.selectedId === hitAnnotation.id) {
            this.store.select(undefined);
          } else {
            this.store.select(hitAnnotation.id);
            this.opts.onAnnotationSelected?.(hitAnnotation.id);
          }
        } else {
          this.store.select(hitAnnotation.id);
          this.opts.onAnnotationSelected?.(hitAnnotation.id);
        }

        const targetAnnotation = this.store.get(hitAnnotation.id);
        let initialAnchor: AreaAnchor | undefined;
        let initialPosition: AnchoredPoint | undefined;
        let initialPoints: ReadonlyArray<AnchoredPoint> | undefined;

        if (
          targetAnnotation?.kind === 'rect' ||
          targetAnnotation?.kind === 'ellipse'
        ) {
          initialAnchor = targetAnnotation.anchor;
        } else if (targetAnnotation?.kind === 'label') {
          initialPosition = targetAnnotation.position;
        } else if (targetAnnotation?.kind === 'path') {
          initialPoints = targetAnnotation.points;
        }

        this.activeGestureState = {
          tool: 'select',
          startEvent: event,
          currentEvent: event,
          selectedTargetId: hitAnnotation.id,
          initialAnchor,
          initialPosition,
          initialPoints,
          isDrag: false,
        };
      } else {
        if (!event.shiftKey) {
          this.store.select(undefined);
        }
        this.activeGestureState = {
          tool: 'select',
          startEvent: event,
          currentEvent: event,
          selectedTargetId: undefined,
          isDrag: false,
        };
      }
      this.opts.requestRedraw();
      return;
    }

    switch (this.activeToolKind) {
      case 'rect':
      case 'ellipse': {
        this.activeGestureState = {
          tool: this.activeToolKind,
          startEvent: event,
          currentEvent: event,
          isDrag: false,
        };
        this.activeGesturePreview = {
          kind: this.activeToolKind,
          rect: {
            left: event.x,
            top: event.y,
            right: event.x,
            bottom: event.y,
            width: 0,
            height: 0,
          },
          color: this.activeStrokeColor,
        };
        this.opts.requestRedraw();
        break;
      }
      case 'pen': {
        const initialPenPoints: Point2D[] = [pointerPos];
        this.activeGestureState = {
          tool: 'pen',
          startEvent: event,
          currentEvent: event,
          penPoints: initialPenPoints,
          isDrag: false,
        };
        this.activeGesturePreview = {
          kind: 'pen',
          points: initialPenPoints,
          color: this.activeStrokeColor,
        };
        this.opts.requestRedraw();
        break;
      }
      case 'arrow': {
        const hitAnnotation = this.hitTestAnnotation(
          pointerPos,
          event.rootNode,
        );
        let arrowFrom: ArrowEndpoint | undefined;
        if (hitAnnotation !== undefined) {
          arrowFrom = {kind: 'annotation', id: hitAnnotation.id};
        } else {
          const availableTracks = event.tracks.filter(
            (t) => t.node.uri !== '/timeline_annotations',
          );
          const anchorAtPointer = pointAtY(event.y, availableTracks);
          if (anchorAtPointer !== undefined) {
            arrowFrom = {
              kind: 'point',
              point: {
                ts: event.ts,
                trackUri: anchorAtPointer.trackUri,
                trackName: anchorAtPointer.trackName,
                yFrac: anchorAtPointer.yFrac,
              },
            };
          }
        }

        if (arrowFrom !== undefined) {
          this.activeGestureState = {
            tool: 'arrow',
            startEvent: event,
            currentEvent: event,
            arrowFrom,
            isDrag: false,
          };
          this.activeGesturePreview = {
            kind: 'arrow',
            from: pointerPos,
            to: pointerPos,
            color: this.activeStrokeColor,
          };
          this.opts.requestRedraw();
        }
        break;
      }
      case 'label': {
        this.activeGestureState = {
          tool: 'label',
          startEvent: event,
          currentEvent: event,
          isDrag: false,
        };
        break;
      }
    }
  }

  onPointerMove(event: OverlayPointerEvent): void {
    if (!this.activeGestureState || event.buttons === 0) {
      return;
    }

    const pointerPos: Point2D = {x: event.x, y: event.y};
    const startEvent = this.activeGestureState.startEvent;
    const distanceMoved = Math.hypot(
      event.x - startEvent.x,
      event.y - startEvent.y,
    );

    if (distanceMoved >= MIN_DRAG_DISTANCE_PX) {
      this.activeGestureState.isDrag = true;
    }

    this.activeGestureState.currentEvent = event;

    switch (this.activeGestureState.tool) {
      case 'arrow-curve': {
        const {
          curveTargetId,
          arrowStartPx,
          arrowEndPx,
          controlHandleId,
          origControlPoints,
        } = this.activeGestureState;
        if (curveTargetId && arrowStartPx && arrowEndPx) {
          const arrowAnn = this.store.get(curveTargetId);
          const [base1, base2] =
            origControlPoints ??
            computeCubicBaseControlPoints(arrowStartPx, arrowEndPx);

          let newCp1 = base1;
          let newCp2 = base2;

          if (controlHandleId === 'arrow-control-1') {
            newCp1 = pointerPos;
          } else if (controlHandleId === 'arrow-control-2') {
            newCp2 = pointerPos;
          } else {
            // Midpoint dragging: bend both control points symmetrically
            const {curvature, alongFrac} = curvatureFromMidpoint(
              arrowStartPx,
              arrowEndPx,
              pointerPos,
            );
            const quadCp = computeQuadraticControlPoint(
              arrowStartPx,
              arrowEndPx,
              curvature,
              alongFrac,
            );
            newCp1 = {
              x: (arrowStartPx.x + 2 * quadCp.x) / 3,
              y: (arrowStartPx.y + 2 * quadCp.y) / 3,
            };
            newCp2 = {
              x: (arrowEndPx.x + 2 * quadCp.x) / 3,
              y: (arrowEndPx.y + 2 * quadCp.y) / 3,
            };
          }

          this.activeGesturePreview = {
            kind: 'arrow-curve',
            annotationId: curveTargetId,
            start: arrowStartPx,
            control: newCp1,
            controlPoints: [newCp1, newCp2],
            end: arrowEndPx,
            color: arrowAnn?.color ?? this.activeStrokeColor,
          };
          this.opts.requestRedraw();
        }
        break;
      }
      case 'rect':
      case 'ellipse': {
        const minX = Math.min(startEvent.x, event.x);
        const maxX = Math.max(startEvent.x, event.x);
        const minY = Math.min(startEvent.y, event.y);
        const maxY = Math.max(startEvent.y, event.y);
        this.activeGesturePreview = {
          kind: this.activeGestureState.tool,
          rect: {
            left: minX,
            top: minY,
            right: maxX,
            bottom: maxY,
            width: maxX - minX,
            height: maxY - minY,
          },
          color: this.activeStrokeColor,
        };
        this.opts.requestRedraw();
        break;
      }
      case 'pen': {
        const penPoints = this.activeGestureState.penPoints;
        if (penPoints !== undefined) {
          penPoints.push(pointerPos);
          this.activeGesturePreview = {
            kind: 'pen',
            points: [...penPoints],
            color: this.activeStrokeColor,
          };
          this.opts.requestRedraw();
        }
        break;
      }
      case 'arrow': {
        this.activeGesturePreview = {
          kind: 'arrow',
          from: {x: startEvent.x, y: startEvent.y},
          to: pointerPos,
          color: this.activeStrokeColor,
        };
        this.opts.requestRedraw();
        break;
      }
      case 'select': {
        const targetId = this.activeGestureState.selectedTargetId;
        if (targetId && this.activeGestureState.isDrag) {
          this.activeGesturePreview = {
            kind: 'move',
            deltaX: event.x - startEvent.x,
            deltaY: event.y - startEvent.y,
            annotationId: targetId,
          };
          this.opts.requestRedraw();
        }
        break;
      }
      case 'label':
        break;
    }
  }

  onPointerUp(event: OverlayPointerEvent): void {
    if (!this.activeGestureState) {
      return;
    }

    const gesture = this.activeGestureState;
    const startEvent = gesture.startEvent;
    const distanceMoved = Math.hypot(
      event.x - startEvent.x,
      event.y - startEvent.y,
    );
    const pointerPos: Point2D = {x: event.x, y: event.y};

    switch (gesture.tool) {
      case 'arrow-curve': {
        const {
          curveTargetId,
          arrowStartPx,
          arrowEndPx,
          controlHandleId,
          origControlPoints,
        } = gesture;
        if (curveTargetId && arrowStartPx && arrowEndPx) {
          const [base1, base2] =
            origControlPoints ??
            computeCubicBaseControlPoints(arrowStartPx, arrowEndPx);
          const [origBase1, origBase2] = computeCubicBaseControlPoints(
            arrowStartPx,
            arrowEndPx,
          );
          const dx = arrowEndPx.x - arrowStartPx.x;
          const dy = arrowEndPx.y - arrowStartPx.y;
          const span = Math.max(Math.hypot(dx, dy), 1);

          let newCp1 = base1;
          let newCp2 = base2;

          if (controlHandleId === 'arrow-control-1') {
            newCp1 = pointerPos;
          } else if (controlHandleId === 'arrow-control-2') {
            newCp2 = pointerPos;
          } else {
            const {curvature, alongFrac} = curvatureFromMidpoint(
              arrowStartPx,
              arrowEndPx,
              pointerPos,
            );
            if (Math.abs(curvature) < 3) {
              this.store.update(curveTargetId, {
                curvature: 0,
                controlOffset: undefined,
                controlOffsets: undefined,
              });
              break;
            } else {
              const quadCp = computeQuadraticControlPoint(
                arrowStartPx,
                arrowEndPx,
                curvature,
                alongFrac,
              );
              newCp1 = {
                x: (arrowStartPx.x + 2 * quadCp.x) / 3,
                y: (arrowStartPx.y + 2 * quadCp.y) / 3,
              };
              newCp2 = {
                x: (arrowEndPx.x + 2 * quadCp.x) / 3,
                y: (arrowEndPx.y + 2 * quadCp.y) / 3,
              };
              const legacyOffset: ArrowControlOffset = {
                alongFrac: Number(alongFrac.toFixed(3)),
                normalPx: Math.round(curvature),
              };
              const off1: ArrowControlOffset = {
                alongFrac: Number(((newCp1.x - origBase1.x) / span).toFixed(4)),
                normalPx: Math.round(newCp1.y - origBase1.y),
              };
              const off2: ArrowControlOffset = {
                alongFrac: Number(((newCp2.x - origBase2.x) / span).toFixed(4)),
                normalPx: Math.round(newCp2.y - origBase2.y),
              };
              this.store.update(curveTargetId, {
                curvature: Math.round(curvature),
                controlOffset: legacyOffset,
                controlOffsets: [off1, off2],
              });
              break;
            }
          }

          const dxFrac1 = Number(((newCp1.x - origBase1.x) / span).toFixed(4));
          const dyPx1 = Math.round(newCp1.y - origBase1.y);
          const dxFrac2 = Number(((newCp2.x - origBase2.x) / span).toFixed(4));
          const dyPx2 = Math.round(newCp2.y - origBase2.y);
          const off1: ArrowControlOffset = {
            alongFrac: dxFrac1,
            normalPx: dyPx1,
          };
          const off2: ArrowControlOffset = {
            alongFrac: dxFrac2,
            normalPx: dyPx2,
          };
          this.store.update(curveTargetId, {
            controlOffsets: [off1, off2],
          });
        }
        break;
      }
      case 'rect':
      case 'ellipse': {
        if (distanceMoved >= MIN_DRAG_DISTANCE_PX) {
          const startTs = Time.min(startEvent.ts, event.ts);
          const endTs = Time.max(startEvent.ts, event.ts);
          const yMin = Math.min(startEvent.y, event.y);
          const yMax = Math.max(startEvent.y, event.y);
          const xMin = Math.min(startEvent.x, event.x);
          const xMax = Math.max(startEvent.x, event.x);
          const drawnRect: RectBounds = {
            left: xMin,
            top: yMin,
            right: xMax,
            bottom: yMax,
            width: xMax - xMin,
            height: yMax - yMin,
          };
          const availableTracks = event.tracks.filter(
            (t) => t.node.uri !== '/timeline_annotations',
          );
          const trackUris = areaForTrackRange(yMin, yMax, availableTracks);
          const trackNames = trackUris.map(
            (uri) =>
              event.tracks.find((track) => track.node.uri === uri)?.node.name ??
              '',
          );

          const created = this.store.add({
            kind: gesture.tool,
            color: this.activeStrokeColor,
            ...(this.activeFillColor !== undefined
              ? {fillColor: this.activeFillColor}
              : {}),
            ...(this.activeFillOpacity !== undefined
              ? {fillOpacity: this.activeFillOpacity}
              : {}),
            anchor: {
              start: startTs,
              end: endTs,
              trackUris,
              trackNames,
            },
          });
          this.createdFromRects.set(created.id, drawnRect);
          this.store.select(created.id);
          this.activeToolKind = 'select';
          this.opts.onAnnotationCreated?.(created.id);
        }
        break;
      }
      case 'pen': {
        const collectedPoints = gesture.penPoints ?? [
          {x: startEvent.x, y: startEvent.y},
          pointerPos,
        ];
        if (collectedPoints.length >= 2) {
          const simplified = simplifyPath(collectedPoints, 2);
          const recognized = recognizeShape(simplified);

          if (recognized.kind === 'rect' || recognized.kind === 'ellipse') {
            if (
              recognized.bbox.width >= PEN_SHAPE_MIN_DIMENSION_PX &&
              recognized.bbox.height >= PEN_SHAPE_MIN_DIMENSION_PX
            ) {
              const tsLeft = event.timescale
                .pxToHpTime(recognized.bbox.left)
                .toTime();
              const tsRight = event.timescale
                .pxToHpTime(recognized.bbox.right)
                .toTime();
              const startTs = Time.min(tsLeft, tsRight);
              const endTs = Time.max(tsLeft, tsRight);
              const availableTracks = event.tracks.filter(
                (t) => t.node.uri !== '/timeline_annotations',
              );
              const trackUris = areaForTrackRange(
                recognized.bbox.top,
                recognized.bbox.bottom,
                availableTracks,
              );
              const trackNames = trackUris.map(
                (uri) =>
                  event.tracks.find((track) => track.node.uri === uri)?.node
                    .name ?? '',
              );

              const created = this.store.add({
                kind: recognized.kind,
                color: this.activeStrokeColor,
                ...(this.activeFillColor !== undefined
                  ? {fillColor: this.activeFillColor}
                  : {}),
                ...(this.activeFillOpacity !== undefined
                  ? {fillOpacity: this.activeFillOpacity}
                  : {}),
                anchor: {
                  start: startTs,
                  end: endTs,
                  trackUris,
                  trackNames,
                },
              });
              this.createdFromRects.set(created.id, recognized.bbox);
              this.store.select(created.id);
              this.activeToolKind = 'select';
              this.opts.onAnnotationCreated?.(created.id);
            }
          } else if (recognized.kind === 'line') {
            const firstPt = simplified[0];
            const lastPt = simplified[simplified.length - 1];
            const chordLength = Math.hypot(
              lastPt.x - firstPt.x,
              lastPt.y - firstPt.y,
            );
            if (chordLength >= PEN_LINE_MIN_CHORD_PX) {
              const startAnchor = pointAtY(firstPt.y, event.tracks);
              const endAnchor = pointAtY(lastPt.y, event.tracks);
              if (startAnchor !== undefined && endAnchor !== undefined) {
                const startPoint: AnchoredPoint = {
                  ts: event.timescale.pxToHpTime(firstPt.x).toTime(),
                  trackUri: startAnchor.trackUri,
                  trackName: startAnchor.trackName,
                  yFrac: startAnchor.yFrac,
                };
                const endPoint: AnchoredPoint = {
                  ts: event.timescale.pxToHpTime(lastPt.x).toTime(),
                  trackUri: endAnchor.trackUri,
                  trackName: endAnchor.trackName,
                  yFrac: endAnchor.yFrac,
                };
                const created = this.store.add({
                  kind: 'arrow',
                  color: this.activeStrokeColor,
                  ...(this.activeFillColor !== undefined
                    ? {fillColor: this.activeFillColor}
                    : {}),
                  ...(this.activeFillOpacity !== undefined
                    ? {fillOpacity: this.activeFillOpacity}
                    : {}),
                  from: {kind: 'point', point: startPoint},
                  to: {kind: 'point', point: endPoint},
                });
                this.store.select(created.id);
                this.activeToolKind = 'select';
                this.opts.onAnnotationCreated?.(created.id);
              }
            }
          } else {
            const jitterSimplified = simplifyPath(collectedPoints, 2.5);
            const smoothed = smoothPath(jitterSimplified, 2);
            const pathPoints = simplifyPath(smoothed, 1.2);
            const strokeBbox = bboxOf(pathPoints);
            if (
              strokeBbox.width >= PEN_SHAPE_MIN_DIMENSION_PX ||
              strokeBbox.height >= PEN_SHAPE_MIN_DIMENSION_PX
            ) {
              const anchoredPoints: AnchoredPoint[] = [];
              for (const itemPoint of pathPoints) {
                const anchor = pointAtY(itemPoint.y, event.tracks);
                if (anchor !== undefined) {
                  anchoredPoints.push({
                    ts: event.timescale.pxToHpTime(itemPoint.x).toTime(),
                    trackUri: anchor.trackUri,
                    trackName: anchor.trackName,
                    yFrac: anchor.yFrac,
                  });
                  if (anchoredPoints.length >= MAX_PATH_POINTS_COUNT) {
                    break;
                  }
                }
              }
              if (anchoredPoints.length >= 2) {
                const created = this.store.add({
                  kind: 'path',
                  color: this.activeStrokeColor,
                  ...(this.activeFillColor !== undefined
                    ? {fillColor: this.activeFillColor}
                    : {}),
                  ...(this.activeFillOpacity !== undefined
                    ? {fillOpacity: this.activeFillOpacity}
                    : {}),
                  points: anchoredPoints,
                });
                this.store.select(created.id);
                this.activeToolKind = 'select';
                this.opts.onAnnotationCreated?.(created.id);
              }
            }
          }
        }
        break;
      }
      case 'arrow': {
        const hitTargetUp = this.hitTestAnnotation(pointerPos, event.rootNode);
        let arrowTo: ArrowEndpoint | undefined;
        if (hitTargetUp !== undefined) {
          arrowTo = {kind: 'annotation', id: hitTargetUp.id};
        } else {
          const availableTracks = event.tracks.filter(
            (t) => t.node.uri !== '/timeline_annotations',
          );
          const anchorAtPointer = pointAtY(event.y, availableTracks);
          if (anchorAtPointer !== undefined) {
            arrowTo = {
              kind: 'point',
              point: {
                ts: event.ts,
                trackUri: anchorAtPointer.trackUri,
                trackName: anchorAtPointer.trackName,
                yFrac: anchorAtPointer.yFrac,
              },
            };
          }
        }

        const arrowFrom = gesture.arrowFrom;
        if (arrowFrom !== undefined && arrowTo !== undefined) {
          const isSameAnnotation =
            arrowFrom.kind === 'annotation' &&
            arrowTo.kind === 'annotation' &&
            arrowFrom.id === arrowTo.id;
          const isZeroLengthPoints =
            arrowFrom.kind === 'point' &&
            arrowTo.kind === 'point' &&
            distanceMoved < MIN_DRAG_DISTANCE_PX;
          const isDegenerate =
            distanceMoved < MIN_DRAG_DISTANCE_PX &&
            (arrowFrom.kind !== 'annotation' || arrowTo.kind !== 'annotation');

          if (!isSameAnnotation && !isZeroLengthPoints && !isDegenerate) {
            const created = this.store.add({
              kind: 'arrow',
              color: this.activeStrokeColor,
              ...(this.activeFillColor !== undefined
                ? {fillColor: this.activeFillColor}
                : {}),
              ...(this.activeFillOpacity !== undefined
                ? {fillOpacity: this.activeFillOpacity}
                : {}),
              from: arrowFrom,
              to: arrowTo,
            });
            this.store.select(created.id);
            this.activeToolKind = 'select';
            this.opts.onAnnotationCreated?.(created.id);
          }
        }
        break;
      }
      case 'label': {
        if (distanceMoved < MIN_DRAG_DISTANCE_PX) {
          const availableTracks = event.tracks.filter(
            (t) => t.node.uri !== '/timeline_annotations',
          );
          const anchorAtPointer = pointAtY(event.y, availableTracks);
          if (anchorAtPointer !== undefined) {
            const created = this.store.add({
              kind: 'label',
              title: 'Label',
              text: 'Label',
              color: this.activeStrokeColor,
              ...(this.activeFillColor !== undefined
                ? {fillColor: this.activeFillColor}
                : {}),
              ...(this.activeFillOpacity !== undefined
                ? {fillOpacity: this.activeFillOpacity}
                : {}),
              position: {
                ts: event.ts,
                trackUri: anchorAtPointer.trackUri,
                trackName: anchorAtPointer.trackName,
                yFrac: anchorAtPointer.yFrac,
              },
            });
            this.requestAutoFocus(created.id);
            this.store.select(created.id);
            this.activeToolKind = 'select';
            this.opts.onAnnotationCreated?.(created.id);
          }
        }
        break;
      }
      case 'select': {
        if (!gesture.isDrag && distanceMoved < MIN_DRAG_DISTANCE_PX) {
          if (!gesture.selectedTargetId && !event.shiftKey) {
            this.store.select(undefined);
          }
        } else if (gesture.isDrag && gesture.selectedTargetId) {
          const annotationId = gesture.selectedTargetId;
          const targetAnnotation = this.store.get(annotationId);
          if (targetAnnotation !== undefined) {
            const deltaX = event.x - startEvent.x;
            const deltaY = event.y - startEvent.y;

            if (
              targetAnnotation.kind === 'rect' ||
              targetAnnotation.kind === 'ellipse'
            ) {
              const origGeom = this.getGeometryForId(
                annotationId,
                event.rootNode,
              );
              if (origGeom !== undefined) {
                const newLeft = origGeom.bbox.left + deltaX;
                const newRight = origGeom.bbox.right + deltaX;
                const newTop = origGeom.bbox.top + deltaY;
                const newBottom = origGeom.bbox.bottom + deltaY;

                const startTs = event.timescale.pxToHpTime(newLeft).toTime();
                const endTs = event.timescale.pxToHpTime(newRight).toTime();

                const intersectingTracks: TrackBounds[] = [];
                for (const track of event.tracks) {
                  if (track.node.uri === '/timeline_annotations') continue;
                  if (
                    newBottom > newTop
                      ? track.verticalBounds.bottom > newTop &&
                        track.verticalBounds.top < newBottom
                      : track.verticalBounds.bottom >= newTop &&
                        track.verticalBounds.top <= newBottom
                  ) {
                    intersectingTracks.push(track);
                  }
                }

                if (intersectingTracks.length > 0) {
                  const firstTrack = intersectingTracks[0];
                  const lastTrack =
                    intersectingTracks[intersectingTracks.length - 1];
                  const firstH = Math.max(
                    firstTrack.verticalBounds.bottom -
                      firstTrack.verticalBounds.top,
                    1,
                  );
                  const lastH = Math.max(
                    lastTrack.verticalBounds.bottom -
                      lastTrack.verticalBounds.top,
                    1,
                  );
                  const topYFrac = Math.max(
                    0,
                    Math.min(
                      1,
                      (newTop - firstTrack.verticalBounds.top) / firstH,
                    ),
                  );
                  const bottomYFrac = Math.max(
                    0,
                    Math.min(
                      1,
                      (newBottom - lastTrack.verticalBounds.top) / lastH,
                    ),
                  );
                  const trackUris = intersectingTracks
                    .map((track) => track.node.uri)
                    .filter((uri): uri is string => Boolean(uri));
                  const trackNames = intersectingTracks.map(
                    (track) => track.node.name ?? '',
                  );

                  this.store.update(annotationId, {
                    anchor: {
                      start: Time.min(startTs, endTs),
                      end: Time.max(startTs, endTs),
                      trackUris,
                      trackNames,
                      topYFrac,
                      bottomYFrac,
                    },
                  });
                }
              }
            } else if (targetAnnotation.kind === 'label') {
              const origPosition =
                gesture.initialPosition ?? targetAnnotation.position;
              const origGeom = this.getGeometryForId(
                annotationId,
                event.rootNode,
              );
              const targetX =
                origGeom !== undefined ? origGeom.bbox.left + deltaX : event.x;
              const targetY =
                origGeom !== undefined
                  ? origGeom.bbox.top + origGeom.bbox.height / 2 + deltaY
                  : event.y;

              const newTs = event.timescale.pxToHpTime(targetX).toTime();
              const newAnchor =
                pointAtY(targetY, event.tracks) ??
                pointAtY(event.y, event.tracks);

              this.store.update(annotationId, {
                position: {
                  ts: newTs,
                  trackUri: newAnchor?.trackUri ?? origPosition.trackUri,
                  trackName: newAnchor?.trackName ?? origPosition.trackName,
                  yFrac: newAnchor?.yFrac ?? origPosition.yFrac,
                },
              });
            } else if (targetAnnotation.kind === 'path') {
              const origPoints =
                gesture.initialPoints ?? targetAnnotation.points;
              const deltaTs = Time.diff(event.ts, startEvent.ts);
              const newPoints: AnchoredPoint[] = [];

              for (const pt of origPoints) {
                const newPtTs = Time.add(pt.ts, deltaTs);
                const ptYResolution = resolveTrackY(
                  pt.trackUri,
                  pt.trackName,
                  event.tracks,
                  event.rootNode,
                );
                let ptAnchor = undefined;
                if (ptYResolution !== undefined) {
                  const origPtY =
                    ptYResolution.top +
                    pt.yFrac * (ptYResolution.bottom - ptYResolution.top);
                  ptAnchor = pointAtY(origPtY + deltaY, event.tracks);
                }
                if (ptAnchor === undefined) {
                  ptAnchor = pointAtY(event.y, event.tracks);
                }
                newPoints.push({
                  ts: newPtTs,
                  trackUri: ptAnchor?.trackUri ?? pt.trackUri,
                  trackName: ptAnchor?.trackName ?? pt.trackName,
                  yFrac: ptAnchor?.yFrac ?? pt.yFrac,
                });
              }

              this.store.update(annotationId, {
                points: newPoints,
              });
            } else if (targetAnnotation.kind === 'arrow') {
              const origGeom = this.getGeometryForId(
                annotationId,
                event.rootNode,
              );
              if (
                origGeom !== undefined &&
                origGeom.start !== undefined &&
                origGeom.end !== undefined
              ) {
                const newStartPx = {
                  x: origGeom.start.x + deltaX,
                  y: origGeom.start.y + deltaY,
                };
                const newEndPx = {
                  x: origGeom.end.x + deltaX,
                  y: origGeom.end.y + deltaY,
                };
                const startHit = pointAtY(newStartPx.y, event.tracks);
                const endHit = pointAtY(newEndPx.y, event.tracks);
                let newFrom = targetAnnotation.from;
                let newTo = targetAnnotation.to;

                if (
                  targetAnnotation.from.kind === 'point' &&
                  startHit !== undefined
                ) {
                  newFrom = {
                    kind: 'point',
                    point: {
                      ts: event.timescale.pxToHpTime(newStartPx.x).toTime(),
                      trackUri: startHit.trackUri,
                      trackName: startHit.trackName,
                      yFrac: startHit.yFrac,
                    },
                  };
                }
                if (
                  targetAnnotation.to.kind === 'point' &&
                  endHit !== undefined
                ) {
                  newTo = {
                    kind: 'point',
                    point: {
                      ts: event.timescale.pxToHpTime(newEndPx.x).toTime(),
                      trackUri: endHit.trackUri,
                      trackName: endHit.trackName,
                      yFrac: endHit.yFrac,
                    },
                  };
                }

                this.store.update(annotationId, {
                  from: newFrom,
                  to: newTo,
                });
              }
            }
          }
        }
        break;
      }
    }

    this.activeGesturePreview = undefined;
    this.activeGestureState = undefined;
    this.opts.requestRedraw();
  }

  private hitTestCurveHandle(
    point: Point2D,
    rootNode?: TrackNode,
  ):
    | {
        geom: AnnotationGeometry;
        handleId: 'arrow-control-1' | 'arrow-control-2' | 'arrow-midpoint';
      }
    | undefined {
    const checkCandidate = (
      geom: AnnotationGeometry,
    ):
      | {
          geom: AnnotationGeometry;
          handleId: 'arrow-control-1' | 'arrow-control-2' | 'arrow-midpoint';
        }
      | undefined => {
      if (
        geom.kind !== 'arrow' ||
        geom.start === undefined ||
        geom.end === undefined
      ) {
        return undefined;
      }

      if (geom.controlPoints && geom.controlPoints.length === 2) {
        const [cp1, cp2] = geom.controlPoints;
        if (Math.hypot(point.x - cp1.x, point.y - cp1.y) <= 10) {
          return {geom, handleId: 'arrow-control-1'};
        }
        if (Math.hypot(point.x - cp2.x, point.y - cp2.y) <= 10) {
          return {geom, handleId: 'arrow-control-2'};
        }
      }

      const midpoint = geom.curveMidpoint ?? {
        x: (geom.start.x + geom.end.x) / 2,
        y: (geom.start.y + geom.end.y) / 2,
      };
      if (Math.hypot(point.x - midpoint.x, point.y - midpoint.y) <= 8) {
        return {geom, handleId: 'arrow-midpoint'};
      }

      return undefined;
    };

    if (this.store.selectedId !== undefined) {
      const selectedGeom = this.getGeometryForId(
        this.store.selectedId,
        rootNode,
      );
      if (selectedGeom) {
        const hit = checkCandidate(selectedGeom);
        if (hit) return hit;
      }
    }

    const allGeometries = this.getAllGeometries(rootNode);
    for (let index = allGeometries.length - 1; index >= 0; index -= 1) {
      const geometry = allGeometries[index];
      if (this.store.isHidden(geometry.id)) {
        continue;
      }
      const hit = checkCandidate(geometry);
      if (hit) return hit;
    }

    return undefined;
  }

  private hitTestAnnotation(
    point: Point2D,
    rootNode?: TrackNode,
  ): AnnotationGeometry | undefined {
    const geometriesList = this.getAllGeometries(rootNode);

    for (let index = geometriesList.length - 1; index >= 0; index -= 1) {
      const geometry = geometriesList[index];
      if (this.store.isHidden(geometry.id)) {
        continue;
      }

      let isHit = false;
      if (geometry.kind === 'rect') {
        isHit = hitTestRect(point, geometry.bbox, HIT_TEST_TOLERANCE_PX, true);
      } else if (geometry.kind === 'ellipse') {
        isHit = hitTestEllipse(
          point,
          geometry.bbox,
          HIT_TEST_TOLERANCE_PX,
          true,
        );
      } else if (geometry.kind === 'label') {
        isHit = hitTestRect(point, geometry.bbox, HIT_TEST_TOLERANCE_PX, true);
      } else if (geometry.kind === 'path' && geometry.polyline !== undefined) {
        isHit = hitTestPolyline(
          point,
          geometry.polyline,
          HIT_TEST_TOLERANCE_PX,
        );
      } else if (
        geometry.kind === 'arrow' &&
        geometry.start !== undefined &&
        geometry.end !== undefined
      ) {
        if (geometry.controlPoints && geometry.controlPoints.length === 2) {
          isHit = hitTestCubicBezier(
            point,
            geometry.start,
            geometry.controlPoints[0],
            geometry.controlPoints[1],
            geometry.end,
            HIT_TEST_TOLERANCE_PX,
          );
        } else if (geometry.control !== undefined) {
          isHit = hitTestQuadraticBezier(
            point,
            geometry.start,
            geometry.control,
            geometry.end,
            HIT_TEST_TOLERANCE_PX,
          );
        } else {
          isHit = hitTestSegment(
            point,
            geometry.start,
            geometry.end,
            HIT_TEST_TOLERANCE_PX,
          );
        }
      } else {
        isHit = hitTestRect(point, geometry.bbox, HIT_TEST_TOLERANCE_PX, true);
      }

      if (isHit) {
        return geometry;
      }
    }

    return undefined;
  }

  private getAllGeometries(rootNode?: TrackNode): AnnotationGeometry[] {
    if (!this.geometryProviderFn) {
      return [];
    }
    const result = this.geometryProviderFn(undefined, rootNode);
    if (!result) {
      return [];
    }
    if (Array.isArray(result)) {
      return result as AnnotationGeometry[];
    }
    if (
      result instanceof Map ||
      typeof (result as ReadonlyMap<string, AnnotationGeometry>).values ===
        'function'
    ) {
      return Array.from(
        (result as ReadonlyMap<string, AnnotationGeometry>).values(),
      );
    }
    return [];
  }

  private getGeometryForId(
    annId: string,
    rootNode?: TrackNode,
  ): AnnotationGeometry | undefined {
    if (!this.geometryProviderFn) {
      return undefined;
    }
    const directResult = this.geometryProviderFn(annId, rootNode);
    if (directResult && 'bbox' in (directResult as object)) {
      return directResult as AnnotationGeometry;
    }
    const allGeometries = this.geometryProviderFn(undefined, rootNode);
    if (
      allGeometries &&
      typeof (allGeometries as ReadonlyMap<string, AnnotationGeometry>).get ===
        'function'
    ) {
      return (allGeometries as ReadonlyMap<string, AnnotationGeometry>).get(
        annId,
      );
    }
    return undefined;
  }
}
