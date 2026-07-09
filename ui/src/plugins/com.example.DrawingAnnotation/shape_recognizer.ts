import type {Stroke} from './state';
import type {TimeScale} from '../../base/time_scale';

/**
 * Analyzes a freeform stroke to determine if it roughly matches a known geometric shape
 * (like a circle or a rectangle) or an arrow, and mutates the stroke to match that shape perfectly.
 *
 * @param stroke The freeform stroke drawn by the user. If recognized, its `type` and `points` will be mutated.
 * @param timescale The current timescale mapping pixels to trace timestamps.
 *
 * @returns {void} This function does not return a value; it mutates the input `stroke` directly.
 *
 * @example
 * // After the user finishes drawing:
 * recognizeShape(currentStroke, trace.timeline.timeScale);
 */
export function recognizeShape(stroke: Stroke, timescale: TimeScale) {
  if (stroke.points.length < 10) return;

  const pts = stroke.points;
  const screenPts = pts.map((p) => ({
    x: timescale.timeToPx(p.ts),
    y: p.yOffset,
  }));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let pathLength = 0;
  for (let i = 0; i < screenPts.length; i++) {
    const p = screenPts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;

    if (i > 0) {
      pathLength += Math.hypot(
        p.x - screenPts[i - 1].x,
        p.y - screenPts[i - 1].y,
      );
    }
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const distStartEnd = Math.hypot(
    screenPts[0].x - screenPts[screenPts.length - 1].x,
    screenPts[0].y - screenPts[screenPts.length - 1].y,
  );
  const expectedPerimeter = 2 * (width + height);
  const expectedCircumference = (Math.PI * (width + height)) / 2;

  const errorCircle =
    Math.abs(pathLength - expectedCircumference) / expectedCircumference;
  const errorRect =
    Math.abs(pathLength - expectedPerimeter) / expectedPerimeter;

  // Closed shape heuristics (Circle vs Rectangle)
  if (
    distStartEnd < Math.max(width, height) * 0.3 &&
    width > 20 &&
    height > 20
  ) {
    if (errorCircle < 0.25 && errorCircle < errorRect) {
      stroke.type = 'circle';
      const minTs = pts.reduce(
        (min, p) => (p.ts < min ? p.ts : min),
        pts[0].ts,
      );
      const maxTs = pts.reduce(
        (max, p) => (p.ts > max ? p.ts : max),
        pts[0].ts,
      );
      stroke.points = [
        {ts: minTs, yOffset: minY},
        {ts: maxTs, yOffset: maxY},
      ];
      return;
    } else if (errorRect < 0.25 && errorRect < errorCircle) {
      stroke.type = 'rectangle';
      const minTs = pts.reduce(
        (min, p) => (p.ts < min ? p.ts : min),
        pts[0].ts,
      );
      const maxTs = pts.reduce(
        (max, p) => (p.ts > max ? p.ts : max),
        pts[0].ts,
      );
      stroke.points = [
        {ts: minTs, yOffset: minY},
        {ts: maxTs, yOffset: maxY},
      ];
      return;
    }
  }

  // Arrow heuristic: find two points furthest apart
  let maxD = 0;
  let idxA = 0;
  let idxB = 0;
  for (let i = 0; i < screenPts.length; i += 3) {
    // Skip some points for performance
    for (let j = i + 1; j < screenPts.length; j += 3) {
      const d = Math.hypot(
        screenPts[i].x - screenPts[j].x,
        screenPts[i].y - screenPts[j].y,
      );
      if (d > maxD) {
        maxD = d;
        idxA = i;
        idxB = j;
      }
    }
  }

  if (maxD > 30 && pathLength < maxD * 1.5) {
    stroke.type = 'arrow';
    if (idxA < idxB) {
      stroke.points = [pts[idxA], pts[idxB]];
    } else {
      stroke.points = [pts[idxB], pts[idxA]];
    }
  }
}

/**
 * Snaps the endpoints of an arrow to the closest edges of existing shapes (like rectangles or circles).
 * It calculates the closest point on the bounding box/radius of nearby shapes.
 *
 * @param arrow The arrow stroke whose endpoints should be snapped.
 * @param allStrokes The full list of current strokes in the state to check against.
 * @param timescale The current timescale mapping pixels to trace timestamps.
 *
 * @returns {void} Mutates the `arrow` object's points, sourceId, and targetId directly.
 *
 * @example
 * snapArrow(newArrowStroke, state.strokes, trace.timeline.timeScale);
 */
export function snapArrow(
  arrow: Stroke,
  allStrokes: Stroke[],
  timescale: TimeScale,
) {
  if (arrow.type !== 'arrow' || arrow.points.length !== 2) return;

  const SNAP_DIST_PX = 50;

  for (let pointIdx = 0; pointIdx < 2; pointIdx++) {
    const pt = arrow.points[pointIdx];
    const px = timescale.timeToPx(pt.ts);
    const py = pt.yOffset;

    let bestDist = SNAP_DIST_PX;
    let bestX = px;
    let bestY = py;
    let bestStrokeId: string | undefined = undefined;

    for (const stroke of allStrokes) {
      if (stroke === arrow) continue;

      if (
        (stroke.type === 'rectangle' || stroke.type === 'circle') &&
        stroke.points.length === 2
      ) {
        const x1 = timescale.timeToPx(stroke.points[0].ts);
        const y1 = stroke.points[0].yOffset;
        const x2 = timescale.timeToPx(stroke.points[1].ts);
        const y2 = stroke.points[1].yOffset;

        const rx1 = Math.min(x1, x2);
        const rx2 = Math.max(x1, x2);
        const ry1 = Math.min(y1, y2);
        const ry2 = Math.max(y1, y2);

        if (stroke.type === 'rectangle') {
          const x = Math.max(rx1, Math.min(px, rx2));
          const y = Math.max(ry1, Math.min(py, ry2));

          const dl = Math.abs(x - rx1);
          const dr = Math.abs(x - rx2);
          const dt = Math.abs(y - ry1);
          const db = Math.abs(y - ry2);
          const m = Math.min(dl, dr, dt, db);

          let sx = x;
          let sy = y;
          if (m === dl) sx = rx1;
          else if (m === dr) sx = rx2;
          else if (m === dt) sy = ry1;
          else sy = ry2;

          const d = Math.hypot(px - sx, py - sy);
          if (d < bestDist) {
            bestDist = d;
            bestX = sx;
            bestY = sy;
            bestStrokeId = stroke.id;
          }
        } else if (stroke.type === 'circle') {
          const cx = (rx1 + rx2) / 2;
          const cy = (ry1 + ry2) / 2;
          const rx = (rx2 - rx1) / 2;
          const ry = (ry2 - ry1) / 2;

          const angle = Math.atan2(py - cy, px - cx);
          const sx = cx + rx * Math.cos(angle);
          const sy = cy + ry * Math.sin(angle);

          const d = Math.hypot(px - sx, py - sy);
          if (d < bestDist) {
            bestDist = d;
            bestX = sx;
            bestY = sy;
            bestStrokeId = stroke.id;
          }
        }
      }
    }

    if (bestDist < SNAP_DIST_PX) {
      arrow.points[pointIdx] = {
        ts: timescale.pxToHpTime(bestX).toTime(),
        yOffset: bestY,
      };
      if (pointIdx === 0) {
        arrow.sourceId = bestStrokeId;
      } else {
        arrow.targetId = bestStrokeId;
      }
    }
  }
}
