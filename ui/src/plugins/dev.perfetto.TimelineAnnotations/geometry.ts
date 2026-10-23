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

import type {Point2D} from '../../base/geom';

export interface RectBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export type BoundingBox = RectBounds;

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'none';

export interface RecognizedShape {
  readonly kind: ShapeKind;
  readonly bbox: RectBounds;
  readonly confidence: number;
}

export function distancePointToPoint(first: Point2D, second: Point2D): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function distancePointToSegment(
  point: Point2D,
  segmentStart: Point2D,
  segmentEnd: Point2D,
): number {
  const deltaX = segmentEnd.x - segmentStart.x;
  const deltaY = segmentEnd.y - segmentStart.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - segmentStart.x, point.y - segmentStart.y);
  }
  const projection =
    ((point.x - segmentStart.x) * deltaX +
      (point.y - segmentStart.y) * deltaY) /
    lengthSquared;
  const clampedT = Math.max(0, Math.min(1, projection));
  const closestX = segmentStart.x + clampedT * deltaX;
  const closestY = segmentStart.y + clampedT * deltaY;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

export const pointToSegmentDistance = distancePointToSegment;

export function bboxOf(points: ReadonlyArray<Point2D>): RectBounds {
  if (points.length === 0) {
    return {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0};
  }
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return {
    left: minX,
    top: minY,
    right: maxX,
    bottom: maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function simplifyPath(
  points: ReadonlyArray<Point2D>,
  epsilon: number,
): Point2D[] {
  if (points.length <= 2 || epsilon <= 0) {
    return points.map((point) => ({x: point.x, y: point.y}));
  }

  let maxDistance = 0;
  let maxIndex = 0;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    const dist = distancePointToSegment(points[index], firstPoint, lastPoint);
    if (dist > maxDistance) {
      maxDistance = dist;
      maxIndex = index;
    }
  }

  if (maxDistance > epsilon) {
    const leftSlice = simplifyPath(points.slice(0, maxIndex + 1), epsilon);
    const rightSlice = simplifyPath(points.slice(maxIndex), epsilon);
    return leftSlice.slice(0, -1).concat(rightSlice);
  }

  return [
    {x: firstPoint.x, y: firstPoint.y},
    {x: lastPoint.x, y: lastPoint.y},
  ];
}

export function smoothPath(
  points: ReadonlyArray<Point2D>,
  iterations = 2,
): Point2D[] {
  if (points.length <= 2 || iterations <= 0) {
    return points.map((point) => ({x: point.x, y: point.y}));
  }

  let currentPoints: Point2D[] = points.map((point) => ({
    x: point.x,
    y: point.y,
  }));

  for (let iter = 0; iter < iterations; iter += 1) {
    // 1. Chaikin corner-cutting preserving endpoints
    const chaikin: Point2D[] = [{x: currentPoints[0].x, y: currentPoints[0].y}];
    for (let i = 0; i < currentPoints.length - 1; i += 1) {
      const p0 = currentPoints[i];
      const p1 = currentPoints[i + 1];
      chaikin.push({
        x: 0.75 * p0.x + 0.25 * p1.x,
        y: 0.75 * p0.y + 0.25 * p1.y,
      });
      chaikin.push({
        x: 0.25 * p0.x + 0.75 * p1.x,
        y: 0.25 * p0.y + 0.75 * p1.y,
      });
    }
    chaikin.push({
      x: currentPoints[currentPoints.length - 1].x,
      y: currentPoints[currentPoints.length - 1].y,
    });

    // 2. 3-point Gaussian pass preserving endpoints
    const gaussian: Point2D[] = [{x: chaikin[0].x, y: chaikin[0].y}];
    for (let j = 1; j < chaikin.length - 1; j += 1) {
      const prev = chaikin[j - 1];
      const curr = chaikin[j];
      const next = chaikin[j + 1];
      gaussian.push({
        x: 0.25 * prev.x + 0.5 * curr.x + 0.25 * next.x,
        y: 0.25 * prev.y + 0.5 * curr.y + 0.25 * next.y,
      });
    }
    gaussian.push({
      x: chaikin[chaikin.length - 1].x,
      y: chaikin[chaikin.length - 1].y,
    });

    currentPoints = gaussian;
  }

  return currentPoints;
}

export function recognizeShape(
  pxPoints: ReadonlyArray<Point2D>,
): RecognizedShape {
  if (pxPoints.length < 2) {
    return {
      kind: 'none',
      bbox: bboxOf(pxPoints),
      confidence: 0,
    };
  }

  const bbox = bboxOf(pxPoints);
  const diagonal = Math.hypot(bbox.width, bbox.height);

  if (diagonal === 0) {
    return {
      kind: 'none',
      bbox,
      confidence: 0,
    };
  }

  const startPoint = pxPoints[0];
  const endPoint = pxPoints[pxPoints.length - 1];
  const chordLength = Math.hypot(
    endPoint.x - startPoint.x,
    endPoint.y - startPoint.y,
  );
  const startEndDistance = chordLength;

  // Closed if start/end distance < 15% of bbox diagonal
  const isClosed = startEndDistance < 0.15 * diagonal;

  if (isClosed && bbox.width > 0 && bbox.height > 0) {
    const centerX = (bbox.left + bbox.right) / 2;
    const centerY = (bbox.top + bbox.bottom) / 2;
    const radiusX = bbox.width / 2;
    const radiusY = bbox.height / 2;

    let totalRectDistance = 0;
    let totalEllipseDistance = 0;

    for (const point of pxPoints) {
      // 1. Distance to bbox 4 edges
      const distanceTop = distancePointToSegment(
        point,
        {x: bbox.left, y: bbox.top},
        {x: bbox.right, y: bbox.top},
      );
      const distanceRight = distancePointToSegment(
        point,
        {x: bbox.right, y: bbox.top},
        {x: bbox.right, y: bbox.bottom},
      );
      const distanceBottom = distancePointToSegment(
        point,
        {x: bbox.right, y: bbox.bottom},
        {x: bbox.left, y: bbox.bottom},
      );
      const distanceLeft = distancePointToSegment(
        point,
        {x: bbox.left, y: bbox.bottom},
        {x: bbox.left, y: bbox.top},
      );
      const minEdgeDistance = Math.min(
        distanceTop,
        distanceRight,
        distanceBottom,
        distanceLeft,
      );
      totalRectDistance += minEdgeDistance / diagonal;

      // 2. Distance to inscribed ellipse
      const deltaX = point.x - centerX;
      const deltaY = point.y - centerY;
      const normalizedRadius = Math.hypot(deltaX / radiusX, deltaY / radiusY);
      let ellipseDistance: number;
      if (normalizedRadius === 0) {
        ellipseDistance = Math.min(radiusX, radiusY);
      } else {
        const boundaryPointX = centerX + deltaX / normalizedRadius;
        const boundaryPointY = centerY + deltaY / normalizedRadius;
        ellipseDistance = Math.hypot(
          point.x - boundaryPointX,
          point.y - boundaryPointY,
        );
      }
      totalEllipseDistance += ellipseDistance / diagonal;
    }

    const meanRectDistance = totalRectDistance / pxPoints.length;
    const meanEllipseDistance = totalEllipseDistance / pxPoints.length;

    if (meanRectDistance <= meanEllipseDistance) {
      const confidence = Math.max(0, Math.min(1, 1 - meanRectDistance * 4));
      return {
        kind: 'rect',
        bbox,
        confidence,
      };
    } else {
      const confidence = Math.max(0, Math.min(1, 1 - meanEllipseDistance * 4));
      return {
        kind: 'ellipse',
        bbox,
        confidence,
      };
    }
  }

  // Straight stroke -> 'line' if max deviation from the chord < 10% of chord length
  if (chordLength > 0) {
    let maxDeviation = 0;
    for (const point of pxPoints) {
      const dev = distancePointToSegment(point, startPoint, endPoint);
      if (dev > maxDeviation) {
        maxDeviation = dev;
      }
    }

    if (maxDeviation < 0.1 * chordLength) {
      const confidence = Math.max(
        0,
        Math.min(1, 1 - maxDeviation / (0.1 * chordLength)),
      );
      return {
        kind: 'line',
        bbox,
        confidence,
      };
    }
  }

  return {
    kind: 'none',
    bbox,
    confidence: 0,
  };
}

export function hitTestRect(
  point: Point2D,
  rect: RectBounds,
  tolerance: number,
  fill = false,
): boolean {
  const left = Math.min(rect.left, rect.right);
  const right = Math.max(rect.left, rect.right);
  const top = Math.min(rect.top, rect.bottom);
  const bottom = Math.max(rect.top, rect.bottom);

  if (fill) {
    return (
      point.x >= left - tolerance &&
      point.x <= right + tolerance &&
      point.y >= top - tolerance &&
      point.y <= bottom + tolerance
    );
  }

  const dTop = distancePointToSegment(
    point,
    {x: left, y: top},
    {x: right, y: top},
  );
  const dRight = distancePointToSegment(
    point,
    {x: right, y: top},
    {x: right, y: bottom},
  );
  const dBottom = distancePointToSegment(
    point,
    {x: right, y: bottom},
    {x: left, y: bottom},
  );
  const dLeft = distancePointToSegment(
    point,
    {x: left, y: bottom},
    {x: left, y: top},
  );

  return Math.min(dTop, dRight, dBottom, dLeft) <= tolerance;
}

export function hitTestEllipse(
  point: Point2D,
  rect: RectBounds,
  tolerance: number,
  fill = false,
): boolean {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const radiusX = Math.abs(rect.right - rect.left) / 2;
  const radiusY = Math.abs(rect.bottom - rect.top) / 2;

  if (radiusX <= 0 && radiusY <= 0) {
    return Math.hypot(point.x - centerX, point.y - centerY) <= tolerance;
  }

  const deltaX = point.x - centerX;
  const deltaY = point.y - centerY;

  if (fill) {
    const effectiveRadiusX = radiusX + tolerance;
    const effectiveRadiusY = radiusY + tolerance;
    if (effectiveRadiusX <= 0 || effectiveRadiusY <= 0) {
      return false;
    }
    const normalizedDistance =
      (deltaX * deltaX) / (effectiveRadiusX * effectiveRadiusX) +
      (deltaY * deltaY) / (effectiveRadiusY * effectiveRadiusY);
    return normalizedDistance <= 1;
  }

  // Outline hit test
  const normalizedRadius = Math.hypot(
    radiusX > 0 ? deltaX / radiusX : 0,
    radiusY > 0 ? deltaY / radiusY : 0,
  );
  if (normalizedRadius === 0) {
    return Math.min(radiusX, radiusY) <= tolerance;
  }
  const boundaryX = centerX + (radiusX > 0 ? deltaX / normalizedRadius : 0);
  const boundaryY = centerY + (radiusY > 0 ? deltaY / normalizedRadius : 0);
  return Math.hypot(point.x - boundaryX, point.y - boundaryY) <= tolerance;
}

export function hitTestSegment(
  point: Point2D,
  segmentStart: Point2D,
  segmentEnd: Point2D,
  tolerance: number,
): boolean {
  return distancePointToSegment(point, segmentStart, segmentEnd) <= tolerance;
}

export function hitTestPolyline(
  point: Point2D,
  points: ReadonlyArray<Point2D>,
  tolerance: number,
): boolean {
  if (points.length === 0) {
    return false;
  }
  if (points.length === 1) {
    return (
      Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance
    );
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    if (
      distancePointToSegment(point, points[index], points[index + 1]) <=
      tolerance
    ) {
      return true;
    }
  }
  return false;
}

export function computeQuadraticControlPoint(
  start: Point2D,
  end: Point2D,
  curvature: number,
  alongFrac = 0.5,
): Point2D {
  const bx = start.x + (end.x - start.x) * alongFrac;
  const by = start.y + (end.y - start.y) * alongFrac;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  let nx = 0;
  let ny = -1;
  if (len > 1e-6) {
    nx = -dy / len;
    ny = dx / len;
  }
  return {
    x: bx + nx * curvature * 2,
    y: by + ny * curvature * 2,
  };
}

export function computeBezierControlPoint(
  start: Point2D,
  end: Point2D,
  offset: {
    readonly dxFrac?: number;
    readonly dyPx?: number;
    readonly alongFrac?: number;
    readonly normalPx?: number;
  },
): Point2D {
  const alongFrac = offset.dxFrac ?? offset.alongFrac ?? 0.5;
  const normalPx = offset.dyPx ?? offset.normalPx ?? 0;
  return computeQuadraticControlPoint(start, end, normalPx, alongFrac);
}

export function evaluateQuadraticBezier(
  start: Point2D,
  control: Point2D,
  end: Point2D,
  t: number,
): Point2D {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const u2t = 2 * u * t;
  return {
    x: uu * start.x + u2t * control.x + tt * end.x,
    y: uu * start.y + u2t * control.y + tt * end.y,
  };
}

export function quadraticBezierEndAngle(
  start: Point2D,
  control: Point2D,
  end: Point2D,
): number {
  let dx = end.x - control.x;
  let dy = end.y - control.y;
  if (Math.hypot(dx, dy) < 1e-4) {
    dx = end.x - start.x;
    dy = end.y - start.y;
  }
  return Math.atan2(dy, dx);
}

export function sampleQuadraticBezier(
  start: Point2D,
  control: Point2D,
  end: Point2D,
  numSegments = 16,
): Point2D[] {
  const count = Math.max(1, numSegments);
  const points: Point2D[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    points.push(evaluateQuadraticBezier(start, control, end, t));
  }
  return points;
}

export function computeBezierBoundingBox(
  start: Point2D,
  control: Point2D,
  end: Point2D,
  paddingPx = 8,
): RectBounds {
  const pts = sampleQuadraticBezier(start, control, end, 32);
  const b = bboxOf(pts);
  return {
    left: b.left - paddingPx,
    top: b.top - paddingPx,
    right: b.right + paddingPx,
    bottom: b.bottom + paddingPx,
    width: b.width + 2 * paddingPx,
    height: b.height + 2 * paddingPx,
  };
}

export function curvatureFromMidpoint(
  start: Point2D,
  end: Point2D,
  targetMidpoint: Point2D,
): {curvature: number; alongFrac: number} {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return {
      curvature: -(targetMidpoint.y - start.y),
      alongFrac: 0.5,
    };
  }
  const ux = dx / len;
  const uy = dy / len;
  const nx = -dy / len;
  const ny = dx / len;
  const wx = targetMidpoint.x - start.x;
  const wy = targetMidpoint.y - start.y;
  const projAlong = wx * ux + wy * uy;
  const rawAlongFrac = projAlong / len;
  const alongFrac = Math.max(0.15, Math.min(0.85, rawAlongFrac));
  const curvature = wx * nx + wy * ny;
  return {curvature, alongFrac};
}

export function hitTestQuadraticBezier(
  pt: Point2D,
  start: Point2D,
  control: Point2D,
  end: Point2D,
  tolPx: number,
): boolean {
  const sampled = sampleQuadraticBezier(start, control, end, 32);
  return hitTestPolyline(pt, sampled, tolPx);
}

export function computeCubicBaseControlPoints(
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

export function computeCubicControlPoints(
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
  if (controlOffsets !== undefined) {
    const [base1, base2] = computeCubicBaseControlPoints(start, end);
    const span = Math.max(Math.hypot(end.x - start.x, end.y - start.y), 1);
    const off0Dx = controlOffsets[0].dxFrac ?? controlOffsets[0].alongFrac ?? 0;
    const off0Dy = controlOffsets[0].dyPx ?? controlOffsets[0].normalPx ?? 0;
    const off1Dx = controlOffsets[1].dxFrac ?? controlOffsets[1].alongFrac ?? 0;
    const off1Dy = controlOffsets[1].dyPx ?? controlOffsets[1].normalPx ?? 0;
    return [
      {x: base1.x + off0Dx * span, y: base1.y + off0Dy},
      {x: base2.x + off1Dx * span, y: base2.y + off1Dy},
    ];
  }
  if (legacyControlOffset !== undefined) {
    const qCp = computeBezierControlPoint(start, end, legacyControlOffset);
    const cp1 = {
      x: start.x + (2 / 3) * (qCp.x - start.x),
      y: start.y + (2 / 3) * (qCp.y - start.y),
    };
    const cp2 = {
      x: end.x + (2 / 3) * (qCp.x - end.x),
      y: end.y + (2 / 3) * (qCp.y - end.y),
    };
    return [cp1, cp2];
  }
  return computeCubicBaseControlPoints(start, end);
}

export function evaluateCubicBezier(
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

export function evaluateCubicBezierTangent(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  t: number,
): Point2D {
  const u = 1 - t;
  const c0 = 3 * u * u;
  const c1 = 6 * u * t;
  const c2 = 3 * t * t;
  const tx = c0 * (p1.x - p0.x) + c1 * (p2.x - p1.x) + c2 * (p3.x - p2.x);
  const ty = c0 * (p1.y - p0.y) + c1 * (p2.y - p1.y) + c2 * (p3.y - p2.y);
  if (Math.hypot(tx, ty) < 1e-3) {
    return {x: p3.x - p0.x, y: p3.y - p0.y};
  }
  return {x: tx, y: ty};
}

export function hitTestCubicBezier(
  pt: Point2D,
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  tolerancePx: number,
  steps = 28,
): boolean {
  let prev = p0;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const curr = evaluateCubicBezier(p0, p1, p2, p3, t);
    if (distancePointToSegment(pt, prev, curr) <= tolerancePx) {
      return true;
    }
    prev = curr;
  }
  return false;
}

export function computeCubicBezierBoundingBox(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  paddingPx = 8,
): RectBounds {
  const points: Point2D[] = [p0, p1, p2, p3];
  const steps = 32;
  for (let i = 1; i < steps; i += 1) {
    points.push(evaluateCubicBezier(p0, p1, p2, p3, i / steps));
  }
  const b = bboxOf(points);
  return {
    left: b.left - paddingPx,
    top: b.top - paddingPx,
    right: b.right + paddingPx,
    bottom: b.bottom + paddingPx,
    width: b.width + 2 * paddingPx,
    height: b.height + 2 * paddingPx,
  };
}
