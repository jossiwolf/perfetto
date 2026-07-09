import type {Trace} from '../../public/trace';
import type {DrawingState, Stroke} from './state';
import {recognizeShape, snapArrow} from './shape_recognizer';

import type {TimeScale} from '../../base/time_scale';

/**
 * Spawns a delightful particle animation ("sparkles") at a specific coordinate when a shape is successfully recognized.
 *
 * @param x The logical canvas X coordinate.
 * @param y The logical canvas Y coordinate.
 * @param color The color of the particles.
 * @param state The shared DrawingState, used to retrieve the canvas and transformation matrix.
 *
 * @returns {void}
 */
function spawnSparkles(
  x: number,
  y: number,
  color: string,
  state: DrawingState,
) {
  const canvas = state.overlayCanvas;
  const tr = state.latestTransform;
  if (!canvas || !tr) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const targetX = tr.a * x + tr.c * y + tr.e;
  const targetY = tr.b * x + tr.d * y + tr.f;
  const clientX = targetX / dpr + rect.left;
  const clientY = targetY / dpr + rect.top;

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = `${clientX}px`;
  container.style.top = `${clientY}px`;
  container.style.pointerEvents = 'none';
  container.style.zIndex = '999999';
  document.body.appendChild(container);

  for (let i = 0; i < 12; i++) {
    const particle = document.createElement('div');
    const angle = (Math.PI * 2 * i) / 12;
    const distance = 30 + Math.random() * 50;

    particle.style.position = 'absolute';
    particle.style.width = '6px';
    particle.style.height = '6px';
    particle.style.background = color;
    particle.style.clipPath =
      'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)';
    particle.style.top = '-3px';
    particle.style.left = '-3px';
    particle.style.transition = 'all 0.8s cubic-bezier(0.1, 0.8, 0.3, 1)';
    particle.style.transform = 'translate(0px, 0px) scale(0) rotate(0deg)';
    particle.style.opacity = '1';

    container.appendChild(particle);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        particle.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(${0.5 + Math.random()}) rotate(${180 + Math.random() * 180}deg)`;
        particle.style.opacity = '0';
      });
    });
  }

  setTimeout(() => container.remove(), 1000);
}

let activeInlineInput: HTMLInputElement | null = null;

/**
 * Spawns an absolute-positioned HTML input overlay directly on top of the trace canvas to allow inline text editing.
 *
 * @param x The logical canvas X coordinate where the text should appear.
 * @param y The logical canvas Y coordinate where the text should appear.
 * @param initialText The pre-filled text of the input (if editing).
 * @param color The text color.
 * @param state The shared DrawingState, used to map logical canvas coords to screen pixels.
 * @param onComplete A callback invoked when the user presses Enter (saving) or Escape (canceling). Passes the new string or null.
 *
 * @returns {void}
 */
function spawnInlineInput(
  x: number,
  y: number,
  initialText: string,
  color: string,
  state: DrawingState,
  onComplete: (newText: string | null) => void,
) {
  if (activeInlineInput) {
    activeInlineInput.blur();
  }

  const canvas = state.overlayCanvas;
  const tr = state.latestTransform;
  if (!canvas || !tr) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio;

  const targetX = tr.a * x + tr.c * y + tr.e;
  const targetY = tr.b * x + tr.d * y + tr.f;

  const cssX = targetX / dpr;
  const cssY = targetY / dpr;

  const clientX = cssX + rect.left;
  const clientY = cssY + rect.top;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = initialText;
  input.style.position = 'fixed';
  input.style.left = `${clientX}px`;
  input.style.top = `${clientY}px`;
  input.style.zIndex = '999999';
  input.style.font = 'bold 16px sans-serif';
  input.style.color = color;
  input.style.background = '#222';
  input.style.border = '1px solid #4caf50';
  input.style.padding = '4px 8px';
  input.style.borderRadius = '4px';
  input.style.outline = 'none';
  input.style.minWidth = '150px';

  input.style.transition = 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
  input.style.transform = 'translateY(-100%) scale(0.8)';
  input.style.opacity = '0';

  document.body.appendChild(input);

  // Trigger reflow
  input.getBoundingClientRect();
  input.style.transform = 'translateY(-100%) scale(1)';
  input.style.opacity = '1';

  input.focus();
  input.select();

  activeInlineInput = input;

  let completed = false;
  const complete = (save: boolean) => {
    if (completed) return;
    completed = true;
    if (activeInlineInput === input) activeInlineInput = null;

    input.style.transform = 'translateY(-100%) scale(0.8)';
    input.style.opacity = '0';
    setTimeout(() => {
      input.remove();
      onComplete(save ? input.value : null);
    }, 200);
  };

  input.addEventListener('blur', () => complete(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      complete(true);
    } else if (e.key === 'Escape') {
      complete(false);
    }
  });
}

/**
 * Checks if a given logical canvas coordinate (x, y) intersects with the bounds or path of a stroke.
 * Uses a distance threshold to make hit-testing forgiving for the user.
 *
 * @param stroke The stroke to hit-test against.
 * @param x The logical canvas X coordinate.
 * @param y The logical canvas Y coordinate.
 * @param timescale The current timescale mapping pixels to trace timestamps.
 *
 * @returns {boolean} True if the point is within the threshold distance of the stroke.
 */
function hitTestStroke(
  stroke: Stroke,
  x: number,
  y: number,
  timescale: TimeScale,
): boolean {
  const threshold = 10;

  if (stroke.type === 'text' && stroke.points.length === 1) {
    const x1 = timescale.timeToPx(stroke.points[0].ts);
    const y1 = stroke.points[0].yOffset;
    return x >= x1 - threshold && x <= x1 + 100 && y >= y1 - 20 && y <= y1 + 10;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of stroke.points) {
    const px = timescale.timeToPx(p.ts);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (p.yOffset < minY) minY = p.yOffset;
    if (p.yOffset > maxY) maxY = p.yOffset;
  }

  if (
    !(
      x >= minX - threshold &&
      x <= maxX + threshold &&
      y >= minY - threshold &&
      y <= maxY + threshold
    )
  ) {
    return false;
  }

  if (stroke.type === 'rectangle') {
    const distLeft = Math.abs(x - minX);
    const distRight = Math.abs(x - maxX);
    const distTop = Math.abs(y - minY);
    const distBottom = Math.abs(y - maxY);
    return Math.min(distLeft, distRight, distTop, distBottom) <= threshold;
  }

  if (stroke.type === 'circle') {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2;
    const ry = (maxY - minY) / 2;
    if (rx === 0 || ry === 0) return true;

    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const rEllipse =
      (rx * ry) /
      Math.sqrt((ry * Math.cos(angle)) ** 2 + (rx * Math.sin(angle)) ** 2);
    return Math.abs(d - rEllipse) <= threshold;
  }

  let minDist = Infinity;
  for (let i = 0; i < stroke.points.length - 1; i++) {
    const p1 = stroke.points[i];
    const p2 = stroke.points[i + 1];
    const x1 = timescale.timeToPx(p1.ts);
    const y1 = p1.yOffset;
    const x2 = timescale.timeToPx(p2.ts);
    const y2 = p2.yOffset;

    const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (l2 === 0) {
      const d = Math.hypot(x - x1, y - y1);
      if (d < minDist) minDist = d;
      continue;
    }

    let t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * (x2 - x1);
    const projY = y1 + t * (y2 - y1);
    const d = Math.hypot(x - projX, y - projY);
    if (d < minDist) minDist = d;
  }

  return minDist <= threshold;
}

/**
 * Attaches global window mouse listeners to track drawing and dragging gestures over the Perfetto trace canvas.
 * It translates screen pixels into Perfetto's logical high-precision timeline.
 *
 * @param state The shared DrawingState object tracking active tools, strokes, and viewport matrices.
 * @param trace The global Perfetto Trace context, used to trigger redraws and manage tabs.
 *
 * @returns {void}
 */
export function setupMouseTracker(state: DrawingState, trace: Trace) {
  const getCanvasPos = (e: MouseEvent): {x: number; y: number} | undefined => {
    if (!state.overlayCanvas || !state.latestTransform) return undefined;
    const rect = state.overlayCanvas.getBoundingClientRect();

    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const dpr = window.devicePixelRatio;

    const inv = state.latestTransform.inverse();
    const targetX = cssX * dpr;
    const targetY = cssY * dpr;

    return {
      x: inv.a * targetX + inv.c * targetY + inv.e,
      y: inv.b * targetX + inv.d * targetY + inv.f,
    };
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.target instanceof HTMLElement) {
      const tag = e.target.tagName.toLowerCase();
      if (
        tag === 'button' ||
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        tag === 'a' ||
        tag === 'label'
      ) {
        return;
      }
      // Ignore if clicking on something that looks like a UI panel instead of the canvas area
      // but without relying on exact class names. We'll rely primarily on the bounding box.
    }

    if (!state.overlayCanvas) return;
    const rect = state.overlayCanvas.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      return;
    }

    const pos = getCanvasPos(e);
    if (!pos || !state.latestTimescale) return;

    // Always try to hit test a stroke first
    let hitStroke = false;
    state.selectedStroke = undefined;
    for (let i = state.strokes.length - 1; i >= 0; i--) {
      if (
        hitTestStroke(state.strokes[i], pos.x, pos.y, state.latestTimescale)
      ) {
        if (state.activeTool === 'eraser') {
          state.strokes.splice(i, 1);
          trace.raf.scheduleCanvasRedraw();
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        state.selectedStroke = state.strokes[i];
        state.dragState = {
          startX: pos.x,
          startY: pos.y,
          originalPoints: state.strokes[i].points.map((p) => ({...p})),
        };
        trace.tabs.showTab('com.example.DrawingAnnotation#ControlsTab');
        e.stopPropagation();
        e.preventDefault();
        hitStroke = true;
        break;
      }
    }

    if (hitStroke) {
      trace.raf.scheduleCanvasRedraw();
      return;
    }

    if (state.activeTool === 'text') {
      const ts = state.latestTimescale.pxToHpTime(pos.x).toTime();
      spawnInlineInput(pos.x, pos.y, '', state.activeColor, state, (text) => {
        if (text) {
          state.strokes.push({
            id: Math.random().toString(36).substring(2, 9),
            color: state.activeColor,
            type: 'text',
            text: text,
            points: [{ts, yOffset: pos.y}],
          });
          trace.raf.scheduleCanvasRedraw();
        }
      });
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Other tools implicitly use the drawing mode, wait, if eraser, we don't draw.
    // We only draw if activeTool is freeform, rectangle, circle, arrow.
    if (
      !['freeform', 'rectangle', 'circle', 'arrow'].includes(state.activeTool)
    ) {
      trace.raf.scheduleCanvasRedraw();
      return;
    }

    e.stopPropagation();
    e.preventDefault();

    state.activeStroke = {
      id: Math.random().toString(36).substring(2, 9),
      color: state.activeColor,
      type: state.activeTool as Stroke['type'],
      points: [
        {ts: state.latestTimescale.pxToHpTime(pos.x).toTime(), yOffset: pos.y},
      ],
    };
    state.strokes.push(state.activeStroke);
    trace.raf.scheduleCanvasRedraw();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (state.selectedStroke && state.dragState && state.latestTimescale) {
      e.stopPropagation();
      e.preventDefault();

      const pos = getCanvasPos(e);
      if (!pos) return;

      const dxPx = pos.x - state.dragState.startX;
      const dyPx = pos.y - state.dragState.startY;

      for (let i = 0; i < state.selectedStroke.points.length; i++) {
        const orig = state.dragState.originalPoints[i];
        const origPx = state.latestTimescale.timeToPx(orig.ts);
        const newPx = origPx + dxPx;
        state.selectedStroke.points[i].ts = state.latestTimescale
          .pxToHpTime(newPx)
          .toTime();
        state.selectedStroke.points[i].yOffset = orig.yOffset + dyPx;
      }
      trace.raf.scheduleCanvasRedraw();
      return;
    }

    if (
      !['freeform', 'rectangle', 'circle', 'arrow'].includes(
        state.activeTool,
      ) ||
      !state.activeStroke ||
      !state.latestTimescale
    ) {
      return;
    }

    e.stopPropagation();
    e.preventDefault();

    const pos = getCanvasPos(e);
    if (!pos) return;

    const newPoint = {
      ts: state.latestTimescale.pxToHpTime(pos.x).toTime(),
      yOffset: pos.y,
    };

    if (state.activeTool === 'freeform') {
      state.activeStroke.points.push(newPoint);
    } else {
      // For shapes, just keep the start point and update the current end point
      if (state.activeStroke.points.length === 1) {
        state.activeStroke.points.push(newPoint);
      } else {
        state.activeStroke.points[1] = newPoint;
      }
    }

    // Request redraw immediately during drawing so it's responsive
    trace.raf.scheduleCanvasRedraw();
  };

  const onMouseUp = (e: MouseEvent) => {
    if (state.dragState) {
      state.dragState = undefined;
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    if (state.activeStroke) {
      if (state.activeStroke.points.length < 2) {
        state.strokes = state.strokes.filter((s) => s !== state.activeStroke);
        state.activeStroke = undefined;
        trace.raf.scheduleCanvasRedraw();
        return;
      }
      const typeBefore = state.activeStroke.type;
      if (state.latestTimescale) {
        if (state.activeTool === 'freeform') {
          recognizeShape(state.activeStroke, state.latestTimescale);
          if (state.activeStroke.type === 'arrow') {
            snapArrow(state.activeStroke, state.strokes, state.latestTimescale);
          }
        } else {
          // Force shape to activeTool
          state.activeStroke.type = state.activeTool as Stroke['type'];
          if (state.activeTool === 'arrow') {
            snapArrow(state.activeStroke, state.strokes, state.latestTimescale);
          }
        }
      }

      if (
        typeBefore === 'freeform' &&
        state.activeStroke.type !== 'freeform' &&
        state.latestTimescale
      ) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const p of state.activeStroke.points) {
          const px = state.latestTimescale!.timeToPx(p.ts);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (p.yOffset < minY) minY = p.yOffset;
          if (p.yOffset > maxY) maxY = p.yOffset;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        spawnSparkles(cx, cy, state.activeStroke.color, state);
      }

      state.selectedStroke = state.activeStroke;
      trace.tabs.showTab('com.example.DrawingAnnotation#ControlsTab');
      state.activeStroke = undefined;
      trace.raf.scheduleCanvasRedraw();
    }
  };

  window.addEventListener('mousedown', onMouseDown, {capture: true});
  window.addEventListener('mousemove', onMouseMove, {capture: true});
  window.addEventListener('mouseup', onMouseUp, {capture: true});

  const onDblClick = (e: MouseEvent) => {
    if (e.target instanceof HTMLElement) {
      const tag = e.target.tagName.toLowerCase();
      if (
        tag === 'button' ||
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        tag === 'a' ||
        tag === 'label'
      ) {
        return;
      }
    }

    if (!state.overlayCanvas) return;
    const rect = state.overlayCanvas.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      return;
    }

    const pos = getCanvasPos(e);
    if (!pos || !state.latestTimescale) return;

    for (let i = state.strokes.length - 1; i >= 0; i--) {
      if (
        hitTestStroke(state.strokes[i], pos.x, pos.y, state.latestTimescale)
      ) {
        const stroke = state.strokes[i];

        let startX = pos.x;
        let startY = pos.y;
        if (stroke.type === 'text') {
          startX = state.latestTimescale.timeToPx(stroke.points[0].ts);
          startY = stroke.points[0].yOffset;
        } else {
          let minX = Infinity;
          let minY = Infinity;
          for (const p of stroke.points) {
            const px = state.latestTimescale.timeToPx(p.ts);
            if (px < minX) minX = px;
            if (p.yOffset < minY) minY = p.yOffset;
          }
          if (minX !== Infinity) startX = minX;
          if (minY !== Infinity) startY = minY - 10;
        }

        spawnInlineInput(
          startX,
          startY,
          stroke.text || '',
          stroke.color,
          state,
          (newText) => {
            if (newText !== null) {
              stroke.text = newText;
              trace.raf.scheduleCanvasRedraw();
            }
          },
        );

        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }
  };
  window.addEventListener('dblclick', onDblClick, {capture: true});

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedStroke) {
      state.strokes = state.strokes.filter((s) => s !== state.selectedStroke);
      state.selectedStroke = undefined;
      trace.raf.scheduleCanvasRedraw();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  trace.trash.defer(() => {
    window.removeEventListener('mousedown', onMouseDown, {capture: true});
    window.removeEventListener('mousemove', onMouseMove, {capture: true});
    window.removeEventListener('mouseup', onMouseUp, {capture: true});
    window.removeEventListener('dblclick', onDblClick, {capture: true});
    window.removeEventListener('keydown', onKeyDown);
  });
}
