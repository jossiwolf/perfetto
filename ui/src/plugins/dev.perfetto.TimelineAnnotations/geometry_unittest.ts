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
import type {Point2D} from '../../base/geom';
import {
  bboxOf,
  computeQuadraticControlPoint,
  curvatureFromMidpoint,
  distancePointToSegment,
  evaluateQuadraticBezier,
  hitTestEllipse,
  hitTestPolyline,
  hitTestQuadraticBezier,
  hitTestRect,
  hitTestSegment,
  quadraticBezierEndAngle,
  recognizeShape,
  sampleQuadraticBezier,
  simplifyPath,
} from './geometry';

describe('geometry.ts', () => {
  describe('distancePointToSegment', () => {
    test('computes distance to collinear point', () => {
      const dist = distancePointToSegment(
        {x: 5, y: 0},
        {x: 0, y: 0},
        {x: 10, y: 0},
      );
      expect(dist).toBeCloseTo(0);
    });

    test('computes perpendicular distance', () => {
      const dist = distancePointToSegment(
        {x: 5, y: 4},
        {x: 0, y: 0},
        {x: 10, y: 0},
      );
      expect(dist).toBeCloseTo(4);
    });

    test('computes distance to clamped endpoint', () => {
      const distBefore = distancePointToSegment(
        {x: -3, y: 4},
        {x: 0, y: 0},
        {x: 10, y: 0},
      );
      expect(distBefore).toBeCloseTo(5);

      const distAfter = distancePointToSegment(
        {x: 13, y: 4},
        {x: 0, y: 0},
        {x: 10, y: 0},
      );
      expect(distAfter).toBeCloseTo(5);
    });

    test('handles zero-length segment', () => {
      const dist = distancePointToSegment(
        {x: 3, y: 4},
        {x: 0, y: 0},
        {x: 0, y: 0},
      );
      expect(dist).toBeCloseTo(5);
    });
  });

  describe('bboxOf', () => {
    test('empty points returns zero bbox', () => {
      expect(bboxOf([])).toEqual({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      });
    });

    test('single point returns zero dimension bbox', () => {
      expect(bboxOf([{x: 42, y: 24}])).toEqual({
        left: 42,
        top: 24,
        right: 42,
        bottom: 24,
        width: 0,
        height: 0,
      });
    });

    test('computes min and max over points', () => {
      const points: Point2D[] = [
        {x: 10, y: 20},
        {x: -5, y: 30},
        {x: 40, y: -10},
      ];
      expect(bboxOf(points)).toEqual({
        left: -5,
        top: -10,
        right: 40,
        bottom: 30,
        width: 45,
        height: 40,
      });
    });
  });

  describe('simplifyPath (RDP)', () => {
    test('points <= 2 or epsilon <= 0 returned as copy', () => {
      const pts = [
        {x: 0, y: 0},
        {x: 10, y: 10},
      ];
      expect(simplifyPath(pts, 1)).toEqual(pts);
      expect(simplifyPath(pts, 0)).toEqual(pts);
    });

    test('simplifies collinear points to endpoints', () => {
      const pts: Point2D[] = [
        {x: 0, y: 0},
        {x: 2, y: 2},
        {x: 5, y: 5},
        {x: 8, y: 8},
        {x: 10, y: 10},
      ];
      const simplified = simplifyPath(pts, 0.1);
      expect(simplified).toEqual([
        {x: 0, y: 0},
        {x: 10, y: 10},
      ]);
    });

    test('preserves corner point exceeding epsilon', () => {
      const pts: Point2D[] = [
        {x: 0, y: 0},
        {x: 5, y: 10},
        {x: 10, y: 0},
      ];
      const simplified = simplifyPath(pts, 1);
      expect(simplified).toEqual(pts);
    });
  });

  describe('recognizeShape', () => {
    test('rejects empty, single point, or degenerate inputs', () => {
      expect(recognizeShape([])).toEqual({
        kind: 'none',
        bbox: {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0},
        confidence: 0,
      });

      expect(recognizeShape([{x: 10, y: 10}])).toEqual({
        kind: 'none',
        bbox: {left: 10, top: 10, right: 10, bottom: 10, width: 0, height: 0},
        confidence: 0,
      });

      // All identical points (degenerate bbox)
      const degenerate = [
        {x: 5, y: 5},
        {x: 5, y: 5},
        {x: 5, y: 5},
      ];
      expect(recognizeShape(degenerate).kind).toBe('none');
    });

    test('recognizes straight line stroke (deviation < 10% of chord)', () => {
      const linePoints: Point2D[] = [
        {x: 0, y: 0},
        {x: 50, y: 1},
        {x: 100, y: 0},
      ];
      const res = recognizeShape(linePoints);
      expect(res.kind).toBe('line');
      expect(res.confidence).toBeGreaterThan(0.5);
    });

    test('rejects curved stroke from line if deviation >= 10% of chord', () => {
      const curved: Point2D[] = [
        {x: 0, y: 0},
        {x: 50, y: 20}, // 20px deviation on 100px chord -> 20% >= 10%
        {x: 100, y: 0},
      ];
      const res = recognizeShape(curved);
      expect(res.kind).toBe('none');
    });

    test('recognizes ideal sampled rectangle', () => {
      // Sample perimeter of a 100x100 rectangle starting and ending at (0, 0)
      const rectPoints: Point2D[] = [];
      // Top edge
      for (let x = 0; x <= 100; x += 10) rectPoints.push({x, y: 0});
      // Right edge
      for (let y = 10; y <= 100; y += 10) rectPoints.push({x: 100, y});
      // Bottom edge
      for (let x = 90; x >= 0; x -= 10) rectPoints.push({x, y: 100});
      // Left edge back to origin
      for (let y = 90; y >= 0; y -= 10) rectPoints.push({x: 0, y});

      const res = recognizeShape(rectPoints);
      expect(res.kind).toBe('rect');
      expect(res.confidence).toBeGreaterThan(0.8);
    });

    test('recognizes ideal sampled ellipse', () => {
      // Sample circle radius 50 centered at (50, 50)
      const ellipsePoints: Point2D[] = [];
      const steps = 36;
      for (let i = 0; i <= steps; i += 1) {
        const theta = (i / steps) * 2 * Math.PI;
        ellipsePoints.push({
          x: 50 + 50 * Math.cos(theta),
          y: 50 + 50 * Math.sin(theta),
        });
      }

      const res = recognizeShape(ellipsePoints);
      expect(res.kind).toBe('ellipse');
      expect(res.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('Hit tests', () => {
    const rect = {
      left: 10,
      top: 20,
      right: 110,
      bottom: 80,
      width: 100,
      height: 60,
    };

    test('hitTestRect outline and fill', () => {
      // Top edge
      expect(hitTestRect({x: 50, y: 22}, rect, 5, false)).toBe(true);
      expect(hitTestRect({x: 50, y: 35}, rect, 5, false)).toBe(false);

      // Fill test
      expect(hitTestRect({x: 50, y: 50}, rect, 0, true)).toBe(true);
      expect(hitTestRect({x: 200, y: 50}, rect, 0, true)).toBe(false);
    });

    test('hitTestEllipse outline and fill', () => {
      // Circle at center (60, 50), rx=50, ry=30
      // Point at (110, 50) is right edge
      expect(hitTestEllipse({x: 112, y: 50}, rect, 5, false)).toBe(true);
      expect(hitTestEllipse({x: 60, y: 50}, rect, 5, false)).toBe(false);

      // Fill test: center is inside
      expect(hitTestEllipse({x: 60, y: 50}, rect, 0, true)).toBe(true);
      // Outside
      expect(hitTestEllipse({x: 150, y: 50}, rect, 0, true)).toBe(false);
    });

    test('hitTestSegment', () => {
      expect(hitTestSegment({x: 5, y: 2}, {x: 0, y: 0}, {x: 10, y: 0}, 3)).toBe(
        true,
      );
      expect(hitTestSegment({x: 5, y: 5}, {x: 0, y: 0}, {x: 10, y: 0}, 3)).toBe(
        false,
      );
    });

    test('hitTestPolyline', () => {
      const poly: Point2D[] = [
        {x: 0, y: 0},
        {x: 50, y: 50},
        {x: 100, y: 0},
      ];
      expect(hitTestPolyline({x: 25, y: 25}, poly, 2)).toBe(true);
      expect(hitTestPolyline({x: 75, y: 25}, poly, 2)).toBe(true);
      expect(hitTestPolyline({x: 50, y: 0}, poly, 2)).toBe(false);
      expect(hitTestPolyline({x: 0, y: 0}, [], 2)).toBe(false);
    });
  });

  describe('Quadratic Bezier geometry', () => {
    const start: Point2D = {x: 0, y: 0};
    const end: Point2D = {x: 100, y: 0};

    test('computeQuadraticControlPoint computes apex at exact distance curvature at t = 0.5', () => {
      const curvature = 25;
      const control = computeQuadraticControlPoint(start, end, curvature, 0.5);

      // For chord (0,0) -> (100,0), unit normal is (0, 1)
      // Control point is at (50, 2 * 25) = (50, 50)
      expect(control.x).toBeCloseTo(50);
      expect(control.y).toBeCloseTo(50);

      // Apex B(0.5) must be at distance curvature (25) from midpoint (50, 0)
      const apex = evaluateQuadraticBezier(start, control, end, 0.5);
      expect(apex.x).toBeCloseTo(50);
      expect(apex.y).toBeCloseTo(25);
    });

    test('computeQuadraticControlPoint handles degenerate chord length', () => {
      const degenerateStart = {x: 10, y: 10};
      const degenerateEnd = {x: 10, y: 10};
      const control = computeQuadraticControlPoint(
        degenerateStart,
        degenerateEnd,
        20,
      );
      // nx = 0, ny = -1 => y = 10 - 20 * 2 = -30
      expect(control.x).toBeCloseTo(10);
      expect(control.y).toBeCloseTo(-30);
    });

    test('evaluateQuadraticBezier evaluates boundaries and midpoint accurately', () => {
      const control: Point2D = {x: 50, y: 40};
      expect(evaluateQuadraticBezier(start, control, end, 0)).toEqual(start);
      expect(evaluateQuadraticBezier(start, control, end, 1)).toEqual(end);

      const mid = evaluateQuadraticBezier(start, control, end, 0.5);
      expect(mid.x).toBeCloseTo(50);
      expect(mid.y).toBeCloseTo(20);
    });

    test('quadraticBezierEndAngle returns tangent angle at t = 1', () => {
      const controlStraight: Point2D = {x: 50, y: 0};
      expect(quadraticBezierEndAngle(start, controlStraight, end)).toBeCloseTo(
        0,
      );

      // Control point (100, -50), end (100, 0) => end - control is (0, 50) -> angle PI/2
      const controlVertical: Point2D = {x: 100, y: -50};
      expect(quadraticBezierEndAngle(start, controlVertical, end)).toBeCloseTo(
        Math.PI / 2,
      );

      // Fallback when control == end
      expect(quadraticBezierEndAngle(start, end, end)).toBeCloseTo(0);
    });

    test('sampleQuadraticBezier samples numSegments + 1 points', () => {
      const control: Point2D = {x: 50, y: 50};
      const samples = sampleQuadraticBezier(start, control, end, 8);
      expect(samples.length).toBe(9);
      expect(samples[0].x).toBeCloseTo(0);
      expect(samples[0].y).toBeCloseTo(0);
      expect(samples[8].x).toBeCloseTo(100);
      expect(samples[8].y).toBeCloseTo(0);
      expect(samples[4].y).toBeCloseTo(25);
    });

    test('curvatureFromMidpoint inverts computeQuadraticControlPoint and clamps alongFrac', () => {
      const targetMidpoint: Point2D = {x: 50, y: 30};
      const {curvature, alongFrac} = curvatureFromMidpoint(
        start,
        end,
        targetMidpoint,
      );
      expect(curvature).toBeCloseTo(30);
      expect(alongFrac).toBeCloseTo(0.5);

      // Clamps alongFrac to [0.15, 0.85]
      const farLeftMidpoint: Point2D = {x: 5, y: 30};
      const leftRes = curvatureFromMidpoint(start, end, farLeftMidpoint);
      expect(leftRes.alongFrac).toBeCloseTo(0.15);

      const farRightMidpoint: Point2D = {x: 95, y: 30};
      const rightRes = curvatureFromMidpoint(start, end, farRightMidpoint);
      expect(rightRes.alongFrac).toBeCloseTo(0.85);

      // Degenerate chord fallback
      const degenRes = curvatureFromMidpoint(
        {x: 10, y: 10},
        {x: 10, y: 10},
        {x: 10, y: 25},
      );
      expect(degenRes.alongFrac).toBe(0.5);
      expect(degenRes.curvature).toBe(-15);
    });

    test('hitTestQuadraticBezier detects proximity to curve', () => {
      const curvature = 40;
      const control = computeQuadraticControlPoint(start, end, curvature, 0.5);

      // Midpoint apex is at (50, 40)
      expect(
        hitTestQuadraticBezier({x: 50, y: 40}, start, control, end, 5),
      ).toBe(true);

      // Chord midpoint (50, 0) is 40px away, with 5px tolerance it should fail
      expect(
        hitTestQuadraticBezier({x: 50, y: 0}, start, control, end, 5),
      ).toBe(false);

      // Far outside
      expect(
        hitTestQuadraticBezier({x: 50, y: 100}, start, control, end, 5),
      ).toBe(false);
    });
  });
});
