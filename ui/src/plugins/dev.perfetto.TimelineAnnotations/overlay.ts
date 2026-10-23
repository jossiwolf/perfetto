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

import type {Point2D, Size2D} from '../../base/geom';
import type {TimeScale} from '../../base/time_scale';
import type {CanvasColors} from '../../public/canvas_colors';
import type {
  Overlay,
  OverlayInteractionContext,
  OverlayInteractionZone,
  OverlayPointerEvent,
  TrackBounds,
} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import {
  type Annotation,
  type AnnotationStore,
  type LabelFontFamily,
  normalizeColor,
} from './model';
import {
  type ResolvedTrackY,
  resolveArea,
  resolvePoint,
  resolveTrackY,
} from './anchor';
import * as geomModule from './geometry';
import {
  bboxOf,
  computeQuadraticControlPoint,
  type RectBounds,
} from './geometry';
import type {AnnotationGeometry, ToolController} from './tools';

export type AnchorStatus = 'exact' | 'degraded' | 'unanchored';

export interface RenderedAnnotationInfo {
  readonly status: AnchorStatus;
  readonly missing: ReadonlyArray<string>;
}

export interface AnnotationsOverlayOptions {
  readonly trackExists?: (uri: string) => boolean;
}

export const CREATION_ANIM_DURATION_MS = 450;
const DELETE_ANIM_DURATION_MS = 180;
const VISIBILITY_ANIM_DURATION_MS = 180;

export function resolveCanvasFontFamily(fontFamily?: LabelFontFamily): string {
  switch (fontFamily) {
    case 'Roboto Condensed':
      return '"Roboto Condensed", "Roboto", sans-serif';
    case 'Roboto Mono':
    case 'monospace':
      return '"Roboto Mono", "JetBrains Mono", monospace';
    case 'Google Sans':
      return '"Google Sans", "Roboto", system-ui, sans-serif';
    case 'Inter':
      return '"Inter", "Roboto", system-ui, sans-serif';
    case 'Georgia':
    case 'serif':
      return 'Georgia, "Times New Roman", serif';
    case 'Roboto':
    case 'sans-serif':
    default:
      return '"Roboto", "Inter", system-ui, sans-serif';
  }
}

// Cubic bezier math helpers with fallback to geometry.ts
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

const computeCubicControlPoints =
  (
    geomModule as {
      computeCubicControlPoints?: typeof localComputeCubicControlPoints;
    }
  ).computeCubicControlPoints ?? localComputeCubicControlPoints;

const evaluateCubicBezier =
  (geomModule as {evaluateCubicBezier?: typeof localEvaluateCubicBezier})
    .evaluateCubicBezier ?? localEvaluateCubicBezier;

const evaluateCubicBezierTangent =
  (
    geomModule as {
      evaluateCubicBezierTangent?: typeof localEvaluateCubicBezierTangent;
    }
  ).evaluateCubicBezierTangent ?? localEvaluateCubicBezierTangent;

const computeCubicBezierBoundingBox =
  (
    geomModule as {
      computeCubicBezierBoundingBox?: typeof localComputeCubicBezierBoundingBox;
    }
  ).computeCubicBezierBoundingBox ?? localComputeCubicBezierBoundingBox;

export function colorWithAlpha(color: string, alpha: number): string {
  const normalized = normalizeColor(color);
  if (normalized.startsWith('#')) {
    let hexString = normalized.slice(1);
    if (hexString.length === 3) {
      hexString =
        hexString[0] +
        hexString[0] +
        hexString[1] +
        hexString[1] +
        hexString[2] +
        hexString[2];
    }
    if (hexString.length >= 6) {
      const redVal = parseInt(hexString.substring(0, 2), 16);
      const greenVal = parseInt(hexString.substring(2, 4), 16);
      const blueVal = parseInt(hexString.substring(4, 6), 16);
      if (
        !Number.isNaN(redVal) &&
        !Number.isNaN(greenVal) &&
        !Number.isNaN(blueVal)
      ) {
        return `rgba(${redVal}, ${greenVal}, ${blueVal}, ${alpha})`;
      }
    }
  }
  return color;
}

export function getAnnotationFillStyle(
  annotation: Annotation,
  defaultAlpha: number,
): string {
  if (annotation.fillColor === 'transparent') {
    return 'rgba(0, 0, 0, 0)';
  }
  const baseFill = annotation.fillColor ?? annotation.color;
  const alpha =
    annotation.fillOpacity ??
    (annotation.fillColor !== undefined
      ? Math.min(0.45, defaultAlpha * 1.8)
      : defaultAlpha);
  return colorWithAlpha(baseFill, alpha);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, Math.max(0, maxLength - 3)) + '...';
}

function nearestPointOnBbox(bbox: RectBounds, toward: Point2D): Point2D {
  return {
    x: Math.max(bbox.left, Math.min(bbox.right, toward.x)),
    y: Math.max(bbox.top, Math.min(bbox.bottom, toward.y)),
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  posX: number,
  posY: number,
  width: number,
  height: number,
  radius: number,
): void {
  const cornerRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(posX + cornerRadius, posY);
  ctx.lineTo(posX + width - cornerRadius, posY);
  ctx.arcTo(
    posX + width,
    posY,
    posX + width,
    posY + cornerRadius,
    cornerRadius,
  );
  ctx.lineTo(posX + width, posY + height - cornerRadius);
  ctx.arcTo(
    posX + width,
    posY + height,
    posX + width - cornerRadius,
    posY + height,
    cornerRadius,
  );
  ctx.lineTo(posX + cornerRadius, posY + height);
  ctx.arcTo(
    posX,
    posY + height,
    posX,
    posY + height - cornerRadius,
    cornerRadius,
  );
  ctx.lineTo(posX, posY + cornerRadius);
  ctx.arcTo(posX, posY, posX + cornerRadius, posY, cornerRadius);
  ctx.closePath();
}

export function drawSmoothPolyline(
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<Point2D>,
): void {
  if (points.length === 0) {
    return;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2 || typeof ctx.quadraticCurveTo !== 'function') {
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    return;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

function renderTitlePill(
  ctx: CanvasRenderingContext2D,
  title: string,
  color: string,
  themeBg: string,
  target:
    | {readonly kind: 'rect-or-ellipse'; readonly bbox: RectBounds}
    | {readonly kind: 'path'; readonly point: Point2D}
    | {readonly kind: 'arrow'; readonly midpoint: Point2D},
): void {
  const titleText = truncateText(title.trim(), 36);
  ctx.font = '500 11px "Roboto", "Inter", system-ui, sans-serif';
  const textWidth = ctx.measureText(titleText).width;
  const paddingH = 7;
  const pillH = 19;
  const pillW = textWidth + paddingH * 2;
  let pillX: number;
  let pillY: number;

  if (target.kind === 'rect-or-ellipse') {
    if (target.bbox.height >= 24) {
      pillX = target.bbox.left + 6;
      pillY = target.bbox.top + 5;
    } else {
      pillX = target.bbox.left + 4;
      const anchorY = target.bbox.top;
      if (anchorY - pillH < 34) {
        pillY = Math.min(target.bbox.bottom + 4, anchorY + 8);
      } else {
        pillY = target.bbox.top - 21;
      }
    }
  } else if (target.kind === 'path') {
    pillX = target.point.x + 4;
    const anchorY = target.point.y;
    if (anchorY - pillH < 34) {
      pillY = anchorY + 8;
    } else {
      pillY = Math.max(2, target.point.y - 21);
    }
  } else {
    pillX = target.midpoint.x - pillW / 2;
    const anchorY = target.midpoint.y;
    if (anchorY - pillH < 34) {
      pillY = anchorY + 8;
    } else {
      pillY = Math.max(2, target.midpoint.y - pillH - 6);
    }
  }

  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 5);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = themeBg;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, pillX + paddingH, pillY + pillH / 2);
}

function drawFourPointStar(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  outerRadius: number,
  innerRadius: number,
  rotation = 0,
): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const angle = rotation + (i * Math.PI) / 4;
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const px = centerX + r * Math.cos(angle);
    const py = centerY + r * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
}

function renderCreationSparkles(
  ctx: CanvasRenderingContext2D,
  geom: AnnotationGeometry,
  color: string,
  rawT: number,
): void {
  if (rawT <= 0 || rawT >= 1) {
    return;
  }

  // Soft glow ring in first 60%
  if (rawT <= 0.6) {
    const glowAlpha = (1 - rawT / 0.6) * 0.35;
    ctx.save();
    try {
      ctx.strokeStyle = colorWithAlpha(color, glowAlpha);
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      const pad = 4 + rawT * 8;
      drawRoundedRect(
        ctx,
        geom.bbox.left - pad,
        geom.bbox.top - pad,
        geom.bbox.width + 2 * pad,
        geom.bbox.height + 2 * pad,
        8,
      );
      ctx.stroke();
    } finally {
      ctx.restore();
    }
  }

  // 6 deterministic sparkles around perimeter
  const numSparkles = 6;
  const centerX = geom.bbox.left + geom.bbox.width / 2;
  const centerY = geom.bbox.top + geom.bbox.height / 2;
  const radiusX = geom.bbox.width / 2;
  const radiusY = geom.bbox.height / 2;

  // Scale: 0 -> 1 in first 35%, fades to 0 with twinkle
  let scale = 0;
  if (rawT < 0.35) {
    scale = rawT / 0.35;
  } else {
    const fadeOut = (1 - rawT) / 0.65;
    const twinkle = 0.8 + 0.2 * Math.sin(rawT * Math.PI * 3);
    scale = Math.max(0, fadeOut * twinkle);
  }

  if (scale <= 0.05) {
    return;
  }

  const driftDist = 4 + 10 * rawT;

  ctx.save();
  try {
    for (let i = 0; i < numSparkles; i += 1) {
      const angle = (2 * Math.PI * i) / numSparkles + 0.3;
      const basePx = centerX + radiusX * Math.cos(angle);
      const basePy = centerY + radiusY * Math.sin(angle);
      const sparkX = basePx + driftDist * Math.cos(angle);
      const sparkY = basePy + driftDist * Math.sin(angle);

      const outerR = 5 * scale;
      const innerR = 1.8 * scale;

      drawFourPointStar(ctx, sparkX, sparkY, outerR, innerR, angle + rawT * 2);
      ctx.fillStyle = colorWithAlpha(color, 0.9);
      ctx.fill();

      // White center highlight
      drawFourPointStar(
        ctx,
        sparkX,
        sparkY,
        outerR * 0.45,
        innerR * 0.45,
        angle + rawT * 2,
      );
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  } finally {
    ctx.restore();
  }
}

export class AnnotationsOverlay implements Overlay {
  private readonly store: AnnotationStore;
  private readonly tools: ToolController;
  private readonly trackExists: (uri: string) => boolean;
  private readonly geometriesByRoot = new WeakMap<
    TrackNode,
    Map<string, AnnotationGeometry>
  >();
  private readonly mergedGeometries = new Map<string, AnnotationGeometry>();
  private renderedAnnotationInfo = new Map<string, RenderedAnnotationInfo>();
  private readonly creationAnims = new Map<
    string,
    {fromRect: RectBounds; startMs: number}
  >();
  private readonly visibilityAnims = new Map<
    string,
    {fromAlpha: number; toAlpha: number; startMs: number}
  >();
  private readonly lastHiddenState = new Map<string, boolean>();
  private readonly lastKnownAnnotations = new Map<
    string,
    {annotation: Annotation; geometry: AnnotationGeometry}
  >();
  private readonly deleteAnims = new Map<
    string,
    {annotation: Annotation; geometry: AnnotationGeometry; startMs: number}
  >();

  constructor(
    store: AnnotationStore,
    tools: ToolController,
    options?: AnnotationsOverlayOptions,
  ) {
    this.store = store;
    this.tools = tools;
    this.trackExists = options?.trackExists ?? (() => false);
    this.tools.setGeometryProvider((id?: string, targetRoot?: TrackNode) => {
      const map =
        (targetRoot && this.geometriesByRoot.get(targetRoot)) ??
        this.mergedGeometries;
      return id ? map.get(id) : map;
    });
  }

  public annotationHasExistingTracks(annotation: Annotation): boolean {
    switch (annotation.kind) {
      case 'rect':
      case 'ellipse':
        return annotation.anchor.trackUris.some((uri) => this.trackExists(uri));
      case 'label':
        return this.trackExists(annotation.position.trackUri);
      case 'path':
        return annotation.points.some((pt) => this.trackExists(pt.trackUri));
      case 'arrow': {
        const fromHit =
          annotation.from.kind === 'point'
            ? this.trackExists(annotation.from.point.trackUri)
            : this.store.get(annotation.from.id) !== undefined;
        const toHit =
          annotation.to.kind === 'point'
            ? this.trackExists(annotation.to.point.trackUri)
            : this.store.get(annotation.to.id) !== undefined;
        return fromHit || toHit;
      }
    }
  }

  getCursor(): string | undefined {
    return this.tools.hoverCursor;
  }

  isInteractive(): boolean {
    return this.tools.isInteractive() && this.tools.tool !== 'select';
  }

  getInteractionZones(
    ctx: OverlayInteractionContext,
  ): ReadonlyArray<OverlayInteractionZone> {
    const rootGeoms = this.geometriesByRoot.get(ctx.rootNode);
    if (!rootGeoms) {
      return [];
    }
    if (this.tools.drawingMode && this.tools.tool !== 'select') {
      return [];
    }

    const zones: OverlayInteractionZone[] = [];
    for (const geom of rootGeoms.values()) {
      if (this.store.isHidden(geom.id)) {
        continue;
      }

      if (geom.kind === 'arrow') {
        if (geom.curveMidpoint !== undefined) {
          zones.push({
            id: `arrow-curve:${geom.id}`,
            area: {
              x: geom.curveMidpoint.x - 8,
              y: geom.curveMidpoint.y - 8,
              width: 16,
              height: 16,
            },
            cursor: 'grab',
          });
        }
        if (geom.controlPoints && geom.controlPoints.length === 2) {
          const [cp1, cp2] = geom.controlPoints;
          zones.push({
            id: `arrow-control-1:${geom.id}`,
            area: {
              x: cp1.x - 8,
              y: cp1.y - 8,
              width: 16,
              height: 16,
            },
            cursor: 'grab',
          });
          zones.push({
            id: `arrow-control-2:${geom.id}`,
            area: {
              x: cp2.x - 8,
              y: cp2.y - 8,
              width: 16,
              height: 16,
            },
            cursor: 'grab',
          });
        }

        // Sample 8 points along curve with small 14x14 grab zones
        if (geom.start && geom.end) {
          const [cp1, cp2] = geom.controlPoints ?? [
            geom.control ?? geom.start,
            geom.control ?? geom.end,
          ];
          for (let step = 1; step <= 8; step += 1) {
            const t = step / 9;
            const pt = evaluateCubicBezier(geom.start, cp1, cp2, geom.end, t);
            zones.push({
              id: `annotation:${geom.id}`,
              area: {
                x: pt.x - 7,
                y: pt.y - 7,
                width: 14,
                height: 14,
              },
              cursor: 'grab',
            });
          }
        }
        continue;
      }

      if (geom.kind === 'path' && geom.polyline && geom.polyline.length > 0) {
        // Sample up to 12 points along stroke with small 14x14 grab zones
        const sampleStep = Math.max(1, Math.floor(geom.polyline.length / 12));
        for (let i = 0; i < geom.polyline.length; i += sampleStep) {
          const pt = geom.polyline[i];
          zones.push({
            id: `annotation:${geom.id}`,
            area: {
              x: pt.x - 7,
              y: pt.y - 7,
              width: 14,
              height: 14,
            },
            cursor: 'grab',
          });
        }
        continue;
      }

      const width = Math.max(8, geom.bbox.width);
      const height = Math.max(8, geom.bbox.height);
      zones.push({
        id: `annotation:${geom.id}`,
        area: {
          x: geom.bbox.left,
          y: geom.bbox.top,
          width,
          height,
        },
        cursor: 'grab',
      });
    }
    return zones;
  }

  onPointerDown(event: OverlayPointerEvent): void {
    this.tools.onPointerDown(event);
  }

  onPointerMove(event: OverlayPointerEvent): void {
    this.tools.onPointerMove(event);
  }

  onPointerUp(event: OverlayPointerEvent): void {
    this.tools.onPointerUp(event);
  }

  get lastRender(): ReadonlyMap<string, RenderedAnnotationInfo> {
    return this.renderedAnnotationInfo;
  }

  render(
    ctx: CanvasRenderingContext2D,
    timescale: TimeScale,
    size: Size2D,
    tracks: ReadonlyArray<TrackBounds>,
    theme: CanvasColors,
    rootNode: TrackNode,
  ): void {
    ctx.save();
    try {
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      let hasActiveAnims = false;

      // Check for deleted annotations from last known rendered set
      for (const [id, item] of this.lastKnownAnnotations.entries()) {
        if (this.store.get(id) === undefined) {
          this.deleteAnims.set(id, {
            annotation: item.annotation,
            geometry: item.geometry,
            startMs: now,
          });
          this.lastKnownAnnotations.delete(id);
          this.creationAnims.delete(id);
          this.visibilityAnims.delete(id);
          this.lastHiddenState.delete(id);
        }
      }

      // Check visibility state changes
      const annotationsList = this.store.list();
      for (const annotation of annotationsList) {
        const isCurrentlyHidden = this.store.isHidden(annotation.id);
        const wasHidden = this.lastHiddenState.get(annotation.id);
        if (wasHidden !== undefined && wasHidden !== isCurrentlyHidden) {
          this.visibilityAnims.set(annotation.id, {
            fromAlpha: wasHidden ? 0 : 1,
            toAlpha: isCurrentlyHidden ? 0 : 1,
            startMs: now,
          });
        }
        this.lastHiddenState.set(annotation.id, isCurrentlyHidden);
      }

      const clipLeft = timescale.pxBounds.left;
      ctx.beginPath();
      ctx.rect(clipLeft, 0, Math.max(0, size.width - clipLeft), size.height);
      ctx.clip();

      const trackYCache = new Map<string, ResolvedTrackY | undefined>();
      const memoResolveTrackY = (
        trackUri: string,
        trackName?: string,
      ): ResolvedTrackY | undefined => {
        const cacheKey = `${trackUri}\0${trackName ?? ''}`;
        if (trackYCache.has(cacheKey)) {
          return trackYCache.get(cacheKey);
        }
        const res = resolveTrackY(trackUri, trackName, tracks, rootNode);
        trackYCache.set(cacheKey, res);
        return res;
      };

      const nextRenderedInfo = new Map<string, RenderedAnnotationInfo>();
      const geometriesMap = new Map<string, AnnotationGeometry>();
      const liveMovePreview =
        this.tools.preview?.kind === 'move' ? this.tools.preview : undefined;

      // Pass 1: Resolve geometry and compute status for all visible non-hidden annotations
      for (const annotation of annotationsList) {
        const isCurrentlyHidden = this.store.isHidden(annotation.id);
        let animAlpha = 1;
        const visAnim = this.visibilityAnims.get(annotation.id);
        if (visAnim !== undefined) {
          const elapsed = now - visAnim.startMs;
          if (elapsed < VISIBILITY_ANIM_DURATION_MS) {
            hasActiveAnims = true;
            const t = Math.max(
              0,
              Math.min(1, elapsed / VISIBILITY_ANIM_DURATION_MS),
            );
            const ease = 1 - Math.pow(1 - t, 3);
            animAlpha = visAnim.toAlpha === 0 ? 1 - ease : ease;
          } else {
            this.visibilityAnims.delete(annotation.id);
            if (visAnim.toAlpha === 0) {
              animAlpha = 0;
            }
          }
        } else if (isCurrentlyHidden) {
          animAlpha = 0;
        }

        if (animAlpha <= 0) {
          continue;
        }

        if (annotation.kind === 'rect' || annotation.kind === 'ellipse') {
          const fromRect = this.tools.consumeCreatedRect?.(annotation.id);
          if (fromRect !== undefined) {
            this.creationAnims.set(annotation.id, {
              fromRect,
              startMs: now,
            });
          }
        }

        switch (annotation.kind) {
          case 'rect':
          case 'ellipse': {
            const startPx = timescale.timeToPx(annotation.anchor.start);
            const endPx = timescale.timeToPx(annotation.anchor.end);
            const leftPx = Math.min(startPx, endPx);
            const rightPx = Math.max(startPx, endPx);
            const anyExists = annotation.anchor.trackUris.some((uri) =>
              this.trackExists(uri),
            );
            const area = resolveArea(
              annotation.anchor,
              tracks,
              rootNode,
              memoResolveTrackY,
            );

            if (area === undefined) {
              if (anyExists) {
                nextRenderedInfo.set(annotation.id, {
                  status: 'exact',
                  missing: [],
                });
                continue;
              }
              nextRenderedInfo.set(annotation.id, {
                status: 'unanchored',
                missing: [...annotation.anchor.trackUris],
              });
              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: annotation.kind,
                bbox: {
                  left: leftPx,
                  top: 0,
                  right: rightPx,
                  bottom: size.height,
                  width: rightPx - leftPx,
                  height: size.height,
                },
              });
            } else {
              let hasDegradedTrack = false;
              for (
                let index = 0;
                index < annotation.anchor.trackUris.length;
                index += 1
              ) {
                const trackUri = annotation.anchor.trackUris[index];
                const trackName = annotation.anchor.trackNames?.[index];
                const trackRes = memoResolveTrackY(trackUri, trackName);
                if (
                  !trackRes ||
                  trackRes.status === 'ancestor' ||
                  trackRes.status === 'fuzzy'
                ) {
                  hasDegradedTrack = true;
                  break;
                }
              }

              const status: AnchorStatus = anyExists
                ? 'exact'
                : hasDegradedTrack || area.missing.length > 0
                  ? 'degraded'
                  : 'exact';
              nextRenderedInfo.set(annotation.id, {
                status,
                missing: area.missing,
              });

              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: annotation.kind,
                bbox: {
                  left: leftPx,
                  top: area.top,
                  right: rightPx,
                  bottom: area.bottom,
                  width: rightPx - leftPx,
                  height: area.bottom - area.top,
                },
              });
            }
            break;
          }
          case 'label': {
            const posX = timescale.timeToPx(annotation.position.ts);
            const exists = this.trackExists(annotation.position.trackUri);
            const pointRes = resolvePoint(
              annotation.position,
              tracks,
              rootNode,
              memoResolveTrackY,
            );

            const labelText = truncateText(
              annotation.title ?? annotation.text,
              50,
            );
            const fontSize = annotation.fontSize ?? 12;
            const fontCss = resolveCanvasFontFamily(annotation.fontFamily);
            ctx.font =
              annotation.fontFamily === 'monospace'
                ? `${fontSize}px monospace`
                : `500 ${fontSize}px ${fontCss}`;
            const textMetrics = ctx.measureText(labelText);
            const padX = Math.max(8, Math.round(fontSize * 0.5));
            const labelHeight = Math.max(18, Math.round(fontSize * 1.5));
            const labelWidth = textMetrics.width + padX * 2;

            if (pointRes === undefined) {
              if (exists) {
                nextRenderedInfo.set(annotation.id, {
                  status: 'exact',
                  missing: [],
                });
                continue;
              }
              nextRenderedInfo.set(annotation.id, {
                status: 'unanchored',
                missing: [annotation.position.trackUri],
              });
              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: 'label',
                bbox: {
                  left: posX,
                  top: 0,
                  right: posX + labelWidth,
                  bottom: labelHeight,
                  width: labelWidth,
                  height: labelHeight,
                },
              });
            } else {
              const status: AnchorStatus = exists
                ? 'exact'
                : pointRes.status === 'exact'
                  ? 'exact'
                  : 'degraded';
              nextRenderedInfo.set(annotation.id, {
                status,
                missing: [],
              });

              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: 'label',
                bbox: {
                  left: posX,
                  top: pointRes.y - labelHeight / 2,
                  right: posX + labelWidth,
                  bottom: pointRes.y + labelHeight / 2,
                  width: labelWidth,
                  height: labelHeight,
                },
              });
            }
            break;
          }
          case 'path': {
            const polyline: Point2D[] = [];
            const missingUris: string[] = [];
            let hasDegraded = false;

            for (const pt of annotation.points) {
              const ptX = timescale.timeToPx(pt.ts);
              const pointRes = resolvePoint(
                pt,
                tracks,
                rootNode,
                memoResolveTrackY,
              );
              if (pointRes === undefined) {
                missingUris.push(pt.trackUri);
              } else {
                polyline.push({x: ptX, y: pointRes.y});
                if (pointRes.status !== 'exact') {
                  hasDegraded = true;
                }
              }
            }

            const anyExists = annotation.points.some((pt) =>
              this.trackExists(pt.trackUri),
            );

            if (polyline.length === 0) {
              if (anyExists) {
                nextRenderedInfo.set(annotation.id, {
                  status: 'exact',
                  missing: [],
                });
                continue;
              }
            }

            let status: AnchorStatus = 'exact';
            if (polyline.length === 0) {
              status = 'unanchored';
            } else if (anyExists) {
              status = 'exact';
            } else if (hasDegraded || missingUris.length > 0) {
              status = 'degraded';
            }

            nextRenderedInfo.set(annotation.id, {
              status,
              missing: Array.from(new Set(missingUris)),
            });

            geometriesMap.set(annotation.id, {
              id: annotation.id,
              kind: 'path',
              bbox: bboxOf(polyline),
              polyline,
            });
            break;
          }
          case 'arrow': {
            break;
          }
        }
      }

      // Apply live move delta to geometry if dragging in select mode
      if (liveMovePreview !== undefined) {
        const movedGeom = geometriesMap.get(liveMovePreview.annotationId);
        if (movedGeom !== undefined) {
          const dx = liveMovePreview.deltaX;
          const dy = liveMovePreview.deltaY;
          const shiftedBbox: RectBounds = {
            left: movedGeom.bbox.left + dx,
            top: movedGeom.bbox.top + dy,
            right: movedGeom.bbox.right + dx,
            bottom: movedGeom.bbox.bottom + dy,
            width: movedGeom.bbox.width,
            height: movedGeom.bbox.height,
          };
          const shiftedPolyline = movedGeom.polyline?.map((p) => ({
            x: p.x + dx,
            y: p.y + dy,
          }));
          geometriesMap.set(liveMovePreview.annotationId, {
            ...movedGeom,
            bbox: shiftedBbox,
            ...(shiftedPolyline ? {polyline: shiftedPolyline} : {}),
          });
        }
      }

      // Pass 2: Draw non-arrow shapes
      for (const annotation of annotationsList) {
        if (annotation.kind === 'arrow') {
          continue;
        }

        const geometry = geometriesMap.get(annotation.id);
        const info = nextRenderedInfo.get(annotation.id);
        if (!geometry || !info) {
          continue;
        }

        let animAlpha = 1;
        const visAnim = this.visibilityAnims.get(annotation.id);
        if (visAnim !== undefined) {
          const elapsed = now - visAnim.startMs;
          if (elapsed < VISIBILITY_ANIM_DURATION_MS) {
            const t = Math.max(
              0,
              Math.min(1, elapsed / VISIBILITY_ANIM_DURATION_MS),
            );
            const ease = 1 - Math.pow(1 - t, 3);
            animAlpha = visAnim.toAlpha === 0 ? 1 - ease : ease;
          }
        } else if (this.store.isHidden(annotation.id)) {
          animAlpha = 0;
        }

        if (animAlpha <= 0) {
          continue;
        }

        this.lastKnownAnnotations.set(annotation.id, {annotation, geometry});

        if (geometry.bbox.right < 0 || geometry.bbox.left > size.width) {
          continue;
        }

        const isSelected = this.store.selectedId === annotation.id;

        ctx.save();
        try {
          if (animAlpha < 1) {
            ctx.globalAlpha = animAlpha;
          }

          if (info.status === 'unanchored') {
            ctx.fillStyle = getAnnotationFillStyle(annotation, 0.12);
            ctx.fillRect(
              geometry.bbox.left,
              0,
              Math.max(1, geometry.bbox.width),
              size.height,
            );
            ctx.strokeStyle = colorWithAlpha(annotation.color, 0.5);
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(
              geometry.bbox.left,
              0,
              Math.max(1, geometry.bbox.width),
              size.height,
            );
            ctx.setLineDash([]);

            const displayTitle = truncateText(
              annotation.title ?? annotation.id,
              24,
            );
            ctx.font = '10px sans-serif';
            ctx.fillStyle = theme.COLOR_TEXT_MUTED;
            ctx.fillText(displayTitle, geometry.bbox.left + 4, 16);
            continue;
          }

          let renderBbox = geometry.bbox;
          const creationAnim = this.creationAnims.get(annotation.id);
          if (creationAnim !== undefined) {
            const elapsed = now - creationAnim.startMs;
            if (elapsed < CREATION_ANIM_DURATION_MS) {
              hasActiveAnims = true;
              const rawT = Math.max(
                0,
                Math.min(1, elapsed / CREATION_ANIM_DURATION_MS),
              );
              const easeOut = 1 - Math.pow(1 - rawT, 3.2);
              const left =
                creationAnim.fromRect.left +
                (geometry.bbox.left - creationAnim.fromRect.left) * easeOut;
              const top =
                creationAnim.fromRect.top +
                (geometry.bbox.top - creationAnim.fromRect.top) * easeOut;
              const right =
                creationAnim.fromRect.right +
                (geometry.bbox.right - creationAnim.fromRect.right) * easeOut;
              const bottom =
                creationAnim.fromRect.bottom +
                (geometry.bbox.bottom - creationAnim.fromRect.bottom) * easeOut;
              renderBbox = {
                left,
                top,
                right,
                bottom,
                width: right - left,
                height: bottom - top,
              };
              renderCreationSparkles(ctx, geometry, annotation.color, rawT);
            } else {
              this.creationAnims.delete(annotation.id);
            }
          }

          switch (annotation.kind) {
            case 'rect': {
              ctx.fillStyle = getAnnotationFillStyle(
                annotation,
                isSelected ? 0.26 : 0.2,
              );
              ctx.fillRect(
                renderBbox.left,
                renderBbox.top,
                renderBbox.width,
                renderBbox.height,
              );

              // Contrast halo / casing
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.strokeRect(
                renderBbox.left,
                renderBbox.top,
                renderBbox.width,
                renderBbox.height,
              );

              // Primary stroke
              ctx.lineWidth = isSelected ? 3 : 2.5;
              ctx.strokeStyle = annotation.color;
              if (info.status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.strokeRect(
                renderBbox.left,
                renderBbox.top,
                renderBbox.width,
                renderBbox.height,
              );
              ctx.setLineDash([]);

              if (
                annotation.title !== undefined &&
                annotation.title.trim().length > 0
              ) {
                renderTitlePill(
                  ctx,
                  annotation.title,
                  annotation.color,
                  theme.COLOR_BACKGROUND,
                  {kind: 'rect-or-ellipse', bbox: renderBbox},
                );
              }
              break;
            }
            case 'ellipse': {
              ctx.beginPath();
              const centerX = renderBbox.left + renderBbox.width / 2;
              const centerY = renderBbox.top + renderBbox.height / 2;
              const radiusX = Math.max(0, renderBbox.width / 2);
              const radiusY = Math.max(0, renderBbox.height / 2);
              ctx.ellipse(
                centerX,
                centerY,
                radiusX,
                radiusY,
                0,
                0,
                2 * Math.PI,
              );
              ctx.fillStyle = getAnnotationFillStyle(
                annotation,
                isSelected ? 0.26 : 0.2,
              );
              ctx.fill();

              // Contrast halo / casing
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.stroke();

              // Primary stroke
              ctx.lineWidth = isSelected ? 3 : 2.5;
              ctx.strokeStyle = annotation.color;
              if (info.status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.stroke();
              ctx.setLineDash([]);

              if (
                annotation.title !== undefined &&
                annotation.title.trim().length > 0
              ) {
                renderTitlePill(
                  ctx,
                  annotation.title,
                  annotation.color,
                  theme.COLOR_BACKGROUND,
                  {kind: 'rect-or-ellipse', bbox: renderBbox},
                );
              }
              break;
            }
            case 'path': {
              if (geometry.polyline && geometry.polyline.length > 1) {
                const hasCustomFill =
                  annotation.fillColor !== undefined &&
                  annotation.fillColor !== 'transparent';

                if (hasCustomFill) {
                  ctx.beginPath();
                  drawSmoothPolyline(ctx, geometry.polyline);
                  ctx.lineWidth = 6;
                  ctx.strokeStyle = getAnnotationFillStyle(annotation, 0.22);
                  ctx.stroke();
                }

                // Contrast halo / casing
                ctx.beginPath();
                drawSmoothPolyline(ctx, geometry.polyline);
                ctx.lineWidth = isSelected ? 6 : 5;
                ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
                ctx.setLineDash([]);
                ctx.stroke();

                // Primary stroke
                ctx.beginPath();
                drawSmoothPolyline(ctx, geometry.polyline);
                ctx.lineWidth = isSelected ? 3 : 2.5;
                ctx.strokeStyle = annotation.color;
                if (info.status === 'degraded') {
                  ctx.setLineDash([4, 4]);
                } else {
                  ctx.setLineDash([]);
                }
                ctx.stroke();
                ctx.setLineDash([]);

                if (
                  annotation.title !== undefined &&
                  annotation.title.trim().length > 0 &&
                  geometry.polyline.length > 0
                ) {
                  renderTitlePill(
                    ctx,
                    annotation.title,
                    annotation.color,
                    theme.COLOR_BACKGROUND,
                    {kind: 'path', point: geometry.polyline[0]},
                  );
                }
              }
              break;
            }
            case 'label': {
              const labelText = truncateText(
                annotation.title ?? annotation.text,
                50,
              );
              const fontSize = annotation.fontSize ?? 12;
              const fontCss = resolveCanvasFontFamily(annotation.fontFamily);
              ctx.font =
                annotation.fontFamily === 'monospace'
                  ? `${fontSize}px monospace`
                  : `500 ${fontSize}px ${fontCss}`;
              const padX = Math.max(8, Math.round(fontSize * 0.5));

              drawRoundedRect(
                ctx,
                geometry.bbox.left,
                geometry.bbox.top,
                geometry.bbox.width,
                geometry.bbox.height,
                6,
              );

              if (annotation.backgroundColor === 'transparent') {
                // transparent: do not fill
              } else if (annotation.backgroundColor !== undefined) {
                ctx.fillStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.92);
                ctx.fill();
                ctx.fillStyle = colorWithAlpha(
                  annotation.backgroundColor,
                  annotation.fillOpacity ?? 0.85,
                );
                ctx.fill();
              } else if (annotation.fillColor !== 'transparent') {
                ctx.fillStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.92);
                ctx.fill();
                ctx.fillStyle = getAnnotationFillStyle(annotation, 0.12);
                ctx.fill();
              }

              // Contrast halo / casing
              drawRoundedRect(
                ctx,
                geometry.bbox.left,
                geometry.bbox.top,
                geometry.bbox.width,
                geometry.bbox.height,
                6,
              );
              ctx.lineWidth = 3;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.stroke();

              // Primary stroke
              drawRoundedRect(
                ctx,
                geometry.bbox.left,
                geometry.bbox.top,
                geometry.bbox.width,
                geometry.bbox.height,
                6,
              );
              ctx.lineWidth = 1;
              ctx.strokeStyle = annotation.color;
              ctx.setLineDash([]);
              ctx.stroke();

              ctx.fillStyle = annotation.textColor ?? theme.COLOR_TEXT;
              ctx.textBaseline = 'middle';
              ctx.fillText(
                labelText,
                geometry.bbox.left + padX,
                geometry.bbox.top + geometry.bbox.height / 2,
              );
              break;
            }
          }
        } finally {
          ctx.restore();
        }
      }

      // Pass 3: Resolve and draw arrows
      for (const annotation of annotationsList) {
        if (annotation.kind !== 'arrow') {
          continue;
        }

        let animAlpha = 1;
        const visAnim = this.visibilityAnims.get(annotation.id);
        if (visAnim !== undefined) {
          const elapsed = now - visAnim.startMs;
          if (elapsed < VISIBILITY_ANIM_DURATION_MS) {
            const t = Math.max(
              0,
              Math.min(1, elapsed / VISIBILITY_ANIM_DURATION_MS),
            );
            const ease = 1 - Math.pow(1 - t, 3);
            animAlpha = visAnim.toAlpha === 0 ? 1 - ease : ease;
          }
        } else if (this.store.isHidden(annotation.id)) {
          animAlpha = 0;
        }

        if (animAlpha <= 0) {
          continue;
        }

        let startPoint: Point2D | undefined;
        let endPoint: Point2D | undefined;
        const missingUris: string[] = [];
        let hasDegraded = false;

        // Resolve endpoint 'to'
        if (annotation.to.kind === 'point') {
          const toPointRes = resolvePoint(
            annotation.to.point,
            tracks,
            rootNode,
            memoResolveTrackY,
          );
          if (toPointRes === undefined) {
            missingUris.push(annotation.to.point.trackUri);
          } else {
            endPoint = {
              x: timescale.timeToPx(annotation.to.point.ts),
              y: toPointRes.y,
            };
            if (toPointRes.status !== 'exact') {
              hasDegraded = true;
            }
          }
        }

        // Resolve endpoint 'from'
        if (annotation.from.kind === 'point') {
          const fromPointRes = resolvePoint(
            annotation.from.point,
            tracks,
            rootNode,
            memoResolveTrackY,
          );
          if (fromPointRes === undefined) {
            missingUris.push(annotation.from.point.trackUri);
          } else {
            startPoint = {
              x: timescale.timeToPx(annotation.from.point.ts),
              y: fromPointRes.y,
            };
            if (fromPointRes.status !== 'exact') {
              hasDegraded = true;
            }
          }
        } else {
          const targetGeomA = geometriesMap.get(annotation.from.id);
          if (targetGeomA !== undefined) {
            if (endPoint !== undefined) {
              startPoint = nearestPointOnBbox(targetGeomA.bbox, endPoint);
            } else if (annotation.to.kind === 'annotation') {
              const targetGeomB = geometriesMap.get(annotation.to.id);
              if (targetGeomB !== undefined) {
                const centerB: Point2D = {
                  x: (targetGeomB.bbox.left + targetGeomB.bbox.right) / 2,
                  y: (targetGeomB.bbox.top + targetGeomB.bbox.bottom) / 2,
                };
                startPoint = nearestPointOnBbox(targetGeomA.bbox, centerB);
              }
            }
          } else {
            missingUris.push(annotation.from.id);
          }
        }

        if (annotation.to.kind === 'annotation') {
          const targetGeomB = geometriesMap.get(annotation.to.id);
          if (targetGeomB !== undefined) {
            if (startPoint !== undefined) {
              endPoint = nearestPointOnBbox(targetGeomB.bbox, startPoint);
            }
          } else {
            missingUris.push(annotation.to.id);
          }
        }

        const fromExists =
          annotation.from.kind === 'point'
            ? this.trackExists(annotation.from.point.trackUri)
            : this.store.get(annotation.from.id) !== undefined;
        const toExists =
          annotation.to.kind === 'point'
            ? this.trackExists(annotation.to.point.trackUri)
            : this.store.get(annotation.to.id) !== undefined;

        if (startPoint === undefined || endPoint === undefined) {
          if (fromExists && toExists) {
            nextRenderedInfo.set(annotation.id, {
              status: 'exact',
              missing: [],
            });
            continue;
          }
        }

        let status: AnchorStatus = 'exact';
        if (startPoint === undefined || endPoint === undefined) {
          status = 'unanchored';
        } else if (fromExists || toExists) {
          status = 'exact';
        } else if (hasDegraded || missingUris.length > 0) {
          status = 'degraded';
        }

        nextRenderedInfo.set(annotation.id, {
          status,
          missing: missingUris,
        });

        if (startPoint !== undefined && endPoint !== undefined) {
          // If live move is active on this arrow, shift endpoints
          if (
            liveMovePreview !== undefined &&
            liveMovePreview.annotationId === annotation.id
          ) {
            startPoint = {
              x: startPoint.x + liveMovePreview.deltaX,
              y: startPoint.y + liveMovePreview.deltaY,
            };
            endPoint = {
              x: endPoint.x + liveMovePreview.deltaX,
              y: endPoint.y + liveMovePreview.deltaY,
            };
          }

          const [cp1, cp2] = computeCubicControlPoints(
            startPoint,
            endPoint,
            annotation.controlOffsets,
            annotation.controlOffset,
          );
          const curveMidpoint = evaluateCubicBezier(
            startPoint,
            cp1,
            cp2,
            endPoint,
            0.5,
          );
          const arrowBbox = computeCubicBezierBoundingBox(
            startPoint,
            cp1,
            cp2,
            endPoint,
            12,
          );

          const isSelected = this.store.selectedId === annotation.id;

          const arrowGeometry: AnnotationGeometry = {
            id: annotation.id,
            kind: 'arrow',
            bbox: arrowBbox,
            start: startPoint,
            end: endPoint,
            control: cp1,
            controlPoints: [cp1, cp2],
            curveMidpoint,
          };
          geometriesMap.set(annotation.id, arrowGeometry);
          this.lastKnownAnnotations.set(annotation.id, {
            annotation,
            geometry: arrowGeometry,
          });

          if (arrowBbox.right >= 0 && arrowBbox.left <= size.width) {
            ctx.save();
            try {
              if (animAlpha < 1) {
                ctx.globalAlpha = animAlpha;
              }

              const hasCustomFill =
                annotation.fillColor !== undefined &&
                annotation.fillColor !== 'transparent';

              const tangent = evaluateCubicBezierTangent(
                startPoint,
                cp1,
                cp2,
                endPoint,
                1,
              );
              const angle = Math.atan2(tangent.y, tangent.x);

              const headLength = 11;
              const backset = 8.5;
              const wingAngle = Math.PI / 6.5;

              const totalArrowLen = Math.hypot(
                endPoint.x - startPoint.x,
                endPoint.y - startPoint.y,
              );
              const shaftEnd =
                totalArrowLen < headLength * 1.5
                  ? endPoint
                  : {
                      x: endPoint.x - backset * Math.cos(angle),
                      y: endPoint.y - backset * Math.sin(angle),
                    };

              const wing1 = {
                x: endPoint.x - headLength * Math.cos(angle - wingAngle),
                y: endPoint.y - headLength * Math.sin(angle - wingAngle),
              };
              const notch = {
                x: endPoint.x - backset * Math.cos(angle),
                y: endPoint.y - backset * Math.sin(angle),
              };
              const wing2 = {
                x: endPoint.x - headLength * Math.cos(angle + wingAngle),
                y: endPoint.y - headLength * Math.sin(angle + wingAngle),
              };

              // 1. Under-glow / custom fill
              if (hasCustomFill) {
                ctx.beginPath();
                ctx.moveTo(startPoint.x, startPoint.y);
                if (typeof ctx.bezierCurveTo === 'function') {
                  ctx.bezierCurveTo(
                    cp1.x,
                    cp1.y,
                    cp2.x,
                    cp2.y,
                    shaftEnd.x,
                    shaftEnd.y,
                  );
                } else if (typeof ctx.quadraticCurveTo === 'function') {
                  const quadCp = computeQuadraticControlPoint(
                    startPoint,
                    endPoint,
                    annotation.controlOffset?.normalPx ??
                      annotation.curvature ??
                      0,
                  );
                  ctx.quadraticCurveTo(
                    quadCp.x,
                    quadCp.y,
                    shaftEnd.x,
                    shaftEnd.y,
                  );
                } else {
                  ctx.lineTo(shaftEnd.x, shaftEnd.y);
                }
                ctx.lineWidth = 6;
                ctx.strokeStyle = getAnnotationFillStyle(annotation, 0.22);
                ctx.stroke();
              }

              // 2. Contrast halo / casing
              ctx.beginPath();
              ctx.moveTo(startPoint.x, startPoint.y);
              if (typeof ctx.bezierCurveTo === 'function') {
                ctx.bezierCurveTo(
                  cp1.x,
                  cp1.y,
                  cp2.x,
                  cp2.y,
                  shaftEnd.x,
                  shaftEnd.y,
                );
              } else if (typeof ctx.quadraticCurveTo === 'function') {
                const quadCp = computeQuadraticControlPoint(
                  startPoint,
                  endPoint,
                  annotation.controlOffset?.normalPx ??
                    annotation.curvature ??
                    0,
                );
                ctx.quadraticCurveTo(
                  quadCp.x,
                  quadCp.y,
                  shaftEnd.x,
                  shaftEnd.y,
                );
              } else {
                ctx.lineTo(shaftEnd.x, shaftEnd.y);
              }
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.stroke();

              // Arrowhead halo casing
              ctx.beginPath();
              ctx.moveTo(endPoint.x, endPoint.y);
              ctx.lineTo(wing1.x, wing1.y);
              ctx.lineTo(notch.x, notch.y);
              ctx.lineTo(wing2.x, wing2.y);
              ctx.closePath();
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.stroke();

              // 3. Primary stroke
              ctx.beginPath();
              ctx.moveTo(startPoint.x, startPoint.y);
              if (typeof ctx.bezierCurveTo === 'function') {
                ctx.bezierCurveTo(
                  cp1.x,
                  cp1.y,
                  cp2.x,
                  cp2.y,
                  shaftEnd.x,
                  shaftEnd.y,
                );
              } else if (typeof ctx.quadraticCurveTo === 'function') {
                const quadCp = computeQuadraticControlPoint(
                  startPoint,
                  endPoint,
                  annotation.controlOffset?.normalPx ??
                    annotation.curvature ??
                    0,
                );
                ctx.quadraticCurveTo(
                  quadCp.x,
                  quadCp.y,
                  shaftEnd.x,
                  shaftEnd.y,
                );
              } else {
                ctx.lineTo(shaftEnd.x, shaftEnd.y);
              }
              ctx.lineWidth = isSelected ? 3 : 2.25;
              ctx.strokeStyle = annotation.color;
              if (status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.stroke();
              ctx.setLineDash([]);

              // 4. Start anchor dot
              ctx.beginPath();
              if (typeof ctx.arc === 'function') {
                ctx.arc(startPoint.x, startPoint.y, 3, 0, Math.PI * 2);
              } else {
                ctx.rect(startPoint.x - 3, startPoint.y - 3, 6, 6);
              }
              ctx.fillStyle = annotation.color;
              ctx.fill();

              // 5. Crisp filled arrowhead polygon
              ctx.beginPath();
              ctx.moveTo(endPoint.x, endPoint.y);
              ctx.lineTo(wing1.x, wing1.y);
              ctx.lineTo(notch.x, notch.y);
              ctx.lineTo(wing2.x, wing2.y);
              ctx.closePath();
              ctx.fillStyle = annotation.color;
              ctx.fill();
              ctx.lineWidth = 1;
              ctx.strokeStyle = annotation.color;
              ctx.stroke();

              if (
                annotation.title !== undefined &&
                annotation.title.trim().length > 0
              ) {
                renderTitlePill(
                  ctx,
                  annotation.title,
                  annotation.color,
                  theme.COLOR_BACKGROUND,
                  {kind: 'arrow', midpoint: curveMidpoint},
                );
              }
            } finally {
              ctx.restore();
            }
          }
        }
      }

      // Pass 4: Draw selection outline and handles
      const selectedId = this.store.selectedId;
      if (selectedId !== undefined) {
        const selectedGeom = geometriesMap.get(selectedId);
        if (selectedGeom !== undefined) {
          const selBbox = selectedGeom.bbox;
          ctx.strokeStyle = theme.COLOR_ACCENT;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(
            selBbox.left - 1,
            selBbox.top - 1,
            selBbox.width + 2,
            selBbox.height + 2,
          );
          ctx.setLineDash([]);

          if (selectedGeom.kind === 'rect' || selectedGeom.kind === 'ellipse') {
            const corners: Point2D[] = [
              {x: selBbox.left, y: selBbox.top},
              {x: selBbox.right, y: selBbox.top},
              {x: selBbox.right, y: selBbox.bottom},
              {x: selBbox.left, y: selBbox.bottom},
            ];
            for (const corner of corners) {
              ctx.fillStyle = theme.COLOR_BACKGROUND;
              ctx.fillRect(corner.x - 3, corner.y - 3, 6, 6);
              ctx.strokeRect(corner.x - 3, corner.y - 3, 6, 6);
            }
          } else if (selectedGeom.kind === 'arrow') {
            if (
              selectedGeom.start !== undefined &&
              selectedGeom.end !== undefined
            ) {
              const [cp1, cp2] = selectedGeom.controlPoints ?? [
                selectedGeom.control ?? selectedGeom.start,
                selectedGeom.control ?? selectedGeom.end,
              ];

              // Dashed tangent guide lines
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_ACCENT, 0.45);
              ctx.lineWidth = 1;
              ctx.setLineDash([2, 2]);
              ctx.beginPath();
              ctx.moveTo(selectedGeom.start.x, selectedGeom.start.y);
              ctx.lineTo(cp1.x, cp1.y);
              ctx.moveTo(selectedGeom.end.x, selectedGeom.end.y);
              ctx.lineTo(cp2.x, cp2.y);
              ctx.stroke();
              ctx.setLineDash([]);

              // Render cp1 and cp2 handles
              for (const cp of [cp1, cp2]) {
                ctx.beginPath();
                if (typeof ctx.arc === 'function') {
                  ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
                } else {
                  ctx.rect(cp.x - 4, cp.y - 4, 8, 8);
                }
                ctx.fillStyle = theme.COLOR_ACCENT;
                ctx.fill();
                ctx.strokeStyle = theme.COLOR_BACKGROUND;
                ctx.lineWidth = 1.5;
                ctx.stroke();
              }

              // Midpoint handle
              if (selectedGeom.curveMidpoint !== undefined) {
                ctx.beginPath();
                if (typeof ctx.arc === 'function') {
                  ctx.arc(
                    selectedGeom.curveMidpoint.x,
                    selectedGeom.curveMidpoint.y,
                    4,
                    0,
                    Math.PI * 2,
                  );
                } else {
                  ctx.rect(
                    selectedGeom.curveMidpoint.x - 4,
                    selectedGeom.curveMidpoint.y - 4,
                    8,
                    8,
                  );
                }
                ctx.fillStyle = theme.COLOR_BACKGROUND;
                ctx.fill();
                ctx.strokeStyle = theme.COLOR_ACCENT;
                ctx.lineWidth = 1.5;
                ctx.stroke();
              }

              // Start and end anchor handles
              for (const endpoint of [selectedGeom.start, selectedGeom.end]) {
                ctx.fillStyle = theme.COLOR_BACKGROUND;
                ctx.strokeStyle = theme.COLOR_ACCENT;
                ctx.fillRect(endpoint.x - 3, endpoint.y - 3, 6, 6);
                ctx.strokeRect(endpoint.x - 3, endpoint.y - 3, 6, 6);
              }
            }
          }
        }
      }

      // Render active delete animations
      for (const [id, delAnim] of this.deleteAnims.entries()) {
        const elapsed = now - delAnim.startMs;
        if (elapsed < DELETE_ANIM_DURATION_MS) {
          hasActiveAnims = true;
          const rawT = Math.max(
            0,
            Math.min(1, elapsed / DELETE_ANIM_DURATION_MS),
          );
          const easeIn = Math.pow(rawT, 2.5);
          ctx.save();
          try {
            ctx.globalAlpha = (1 - easeIn) * 0.7;
            ctx.strokeStyle = delAnim.annotation.color;
            ctx.lineWidth = 2;
            const inset = easeIn * 4;
            const b = delAnim.geometry.bbox;
            ctx.strokeRect(
              b.left + inset,
              b.top + inset,
              Math.max(0, b.width - inset * 2),
              Math.max(0, b.height - inset * 2),
            );
          } finally {
            ctx.restore();
          }
        } else {
          this.deleteAnims.delete(id);
        }
      }

      // Pass 5: Draw gesture preview
      const preview = this.tools.preview;
      if (preview !== undefined) {
        switch (preview.kind) {
          case 'arrow-curve': {
            const [cp1, cp2] = preview.controlPoints ?? [
              preview.control,
              preview.control,
            ];
            const tangent = evaluateCubicBezierTangent(
              preview.start,
              cp1,
              cp2,
              preview.end,
              1,
            );
            const angle = Math.atan2(tangent.y, tangent.x);
            const headLength = 11;
            const backset = 8.5;
            const wingAngle = Math.PI / 6.5;

            const shaftEnd = {
              x: preview.end.x - backset * Math.cos(angle),
              y: preview.end.y - backset * Math.sin(angle),
            };

            ctx.beginPath();
            ctx.moveTo(preview.start.x, preview.start.y);
            if (typeof ctx.bezierCurveTo === 'function') {
              ctx.bezierCurveTo(
                cp1.x,
                cp1.y,
                cp2.x,
                cp2.y,
                shaftEnd.x,
                shaftEnd.y,
              );
            } else if (typeof ctx.quadraticCurveTo === 'function') {
              ctx.quadraticCurveTo(
                preview.control.x,
                preview.control.y,
                shaftEnd.x,
                shaftEnd.y,
              );
            } else {
              ctx.lineTo(shaftEnd.x, shaftEnd.y);
            }
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Arrowhead
            ctx.beginPath();
            ctx.moveTo(preview.end.x, preview.end.y);
            ctx.lineTo(
              preview.end.x - headLength * Math.cos(angle - wingAngle),
              preview.end.y - headLength * Math.sin(angle - wingAngle),
            );
            ctx.lineTo(shaftEnd.x, shaftEnd.y);
            ctx.lineTo(
              preview.end.x - headLength * Math.cos(angle + wingAngle),
              preview.end.y - headLength * Math.sin(angle + wingAngle),
            );
            ctx.closePath();
            ctx.fillStyle = preview.color;
            ctx.fill();
            break;
          }
          case 'rect': {
            ctx.fillStyle = colorWithAlpha(preview.color, 0.12);
            ctx.fillRect(
              preview.rect.left,
              preview.rect.top,
              preview.rect.width,
              preview.rect.height,
            );
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(
              preview.rect.left,
              preview.rect.top,
              preview.rect.width,
              preview.rect.height,
            );
            ctx.setLineDash([]);
            break;
          }
          case 'ellipse': {
            ctx.beginPath();
            const centerX = preview.rect.left + preview.rect.width / 2;
            const centerY = preview.rect.top + preview.rect.height / 2;
            const radiusX = Math.max(0, preview.rect.width / 2);
            const radiusY = Math.max(0, preview.rect.height / 2);
            ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
            ctx.fillStyle = colorWithAlpha(preview.color, 0.12);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            break;
          }
          case 'pen': {
            if (preview.points.length > 1) {
              ctx.beginPath();
              drawSmoothPolyline(ctx, preview.points);
              ctx.lineWidth = 2;
              ctx.strokeStyle = preview.color;
              ctx.stroke();
            }
            break;
          }
          case 'arrow': {
            const [cp1, cp2] = localComputeCubicBaseControlPoints(
              preview.from,
              preview.to,
            );
            const tangent = evaluateCubicBezierTangent(
              preview.from,
              cp1,
              cp2,
              preview.to,
              1,
            );
            const angle = Math.atan2(tangent.y, tangent.x);
            const headLength = 11;
            const backset = 8.5;
            const wingAngle = Math.PI / 6.5;
            const shaftEnd = {
              x: preview.to.x - backset * Math.cos(angle),
              y: preview.to.y - backset * Math.sin(angle),
            };

            ctx.beginPath();
            ctx.moveTo(preview.from.x, preview.from.y);
            if (typeof ctx.bezierCurveTo === 'function') {
              ctx.bezierCurveTo(
                cp1.x,
                cp1.y,
                cp2.x,
                cp2.y,
                shaftEnd.x,
                shaftEnd.y,
              );
            } else {
              ctx.lineTo(shaftEnd.x, shaftEnd.y);
            }
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(preview.to.x, preview.to.y);
            ctx.lineTo(
              preview.to.x - headLength * Math.cos(angle - wingAngle),
              preview.to.y - headLength * Math.sin(angle - wingAngle),
            );
            ctx.lineTo(shaftEnd.x, shaftEnd.y);
            ctx.lineTo(
              preview.to.x - headLength * Math.cos(angle + wingAngle),
              preview.to.y - headLength * Math.sin(angle + wingAngle),
            );
            ctx.closePath();
            ctx.fillStyle = preview.color;
            ctx.fill();
            break;
          }
          case 'move': {
            const targetGeom =
              geometriesMap.get(preview.annotationId) ??
              this.mergedGeometries.get(preview.annotationId);
            if (targetGeom !== undefined) {
              // The annotation itself moves live with cursor.
              // Stroke selection accent outline around shifted bbox:
              ctx.lineWidth = 1;
              ctx.strokeStyle = theme.COLOR_ACCENT;
              ctx.setLineDash([4, 4]);
              ctx.strokeRect(
                targetGeom.bbox.left,
                targetGeom.bbox.top,
                targetGeom.bbox.width,
                targetGeom.bbox.height,
              );
              ctx.setLineDash([]);
            }
            break;
          }
        }
      }

      for (const key of this.mergedGeometries.keys()) {
        if (this.store.get(key) === undefined) {
          this.mergedGeometries.delete(key);
        }
      }
      for (const key of this.renderedAnnotationInfo.keys()) {
        if (this.store.get(key) === undefined) {
          this.renderedAnnotationInfo.delete(key);
        }
      }

      this.geometriesByRoot.set(rootNode, geometriesMap);
      for (const [id, geom] of geometriesMap.entries()) {
        this.mergedGeometries.set(id, geom);
      }
      for (const [id, info] of nextRenderedInfo.entries()) {
        const existing = this.renderedAnnotationInfo.get(id);
        if (existing?.status === 'exact' && info.status !== 'exact') {
          const ann = this.store.get(id);
          if (ann && this.annotationHasExistingTracks(ann)) {
            continue;
          }
        }
        this.renderedAnnotationInfo.set(id, info);
      }

      this.tools.setGeometryProvider((id?: string, targetRoot?: TrackNode) => {
        const map =
          (targetRoot && this.geometriesByRoot.get(targetRoot)) ??
          this.mergedGeometries;
        return id ? map.get(id) : map;
      });

      if (hasActiveAnims) {
        this.tools.requestRedraw?.();
      }
    } finally {
      ctx.restore();
    }
  }
}
