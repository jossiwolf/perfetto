import type {Overlay, TrackBounds} from '../../public/track';
import type {TimeScale} from '../../base/time_scale';
import type {Size2D} from '../../base/geom';
import type {CanvasColors} from '../../public/canvas_colors';
import type {DrawingState} from './state';

export class DrawingOverlay implements Overlay {
  constructor(private state: DrawingState) {}

  render(
    ctx: CanvasRenderingContext2D,
    timescale: TimeScale,
    size: Size2D,
    tracks: ReadonlyArray<TrackBounds>,
    _theme: CanvasColors,
  ) {
    this.state.tracks = tracks;

    // VirtualOverlayCanvas handles scroll translation for us. However, we want to capture
    // the un-translated bounding rectangle of the canvas so we can map physical mouse
    // coordinates to logical canvas coordinates.
    this.state.latestTimescale = timescale; // Cache the latest timescale for mouse coordinate translation
    this.state.overlayCanvas = ctx.canvas;
    this.state.latestTransform = ctx.getTransform();

    if (!this.state.isOverlayVisible) {
      return;
    }

    // Add a slightly opaque overlay to the entire canvas to make drawings pop
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.fillRect(0, 0, size.width, size.height);

    ctx.save();
    ctx.lineWidth = 4; // Increased thickness for better visibility
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Add a drop shadow to the strokes to make them stand out against any trace background
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    for (const stroke of this.state.strokes) {
      if (stroke.points.length === 0) continue;

      ctx.strokeStyle = stroke.color;
      ctx.beginPath();

      if (stroke.type === 'circle' && stroke.points.length === 2) {
        const p1 = stroke.points[0];
        const p2 = stroke.points[1];
        const x1 = timescale.timeToPx(p1.ts);
        const x2 = timescale.timeToPx(p2.ts);
        const y1 = p1.yOffset;
        const y2 = p2.yOffset;

        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rx = Math.abs(x2 - x1) / 2;
        const ry = Math.abs(y2 - y1) / 2;

        ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (stroke.type === 'arrow' && stroke.points.length === 2) {
        const p1 = stroke.points[0];
        const p2 = stroke.points[1];
        const x1 = timescale.timeToPx(p1.ts);
        const x2 = timescale.timeToPx(p2.ts);
        const y1 = p1.yOffset;
        const y2 = p2.yOffset;

        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);

        // Draw arrowhead
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 15;
        ctx.lineTo(
          x2 - headLen * Math.cos(angle - Math.PI / 6),
          y2 - headLen * Math.sin(angle - Math.PI / 6),
        );
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headLen * Math.cos(angle + Math.PI / 6),
          y2 - headLen * Math.sin(angle + Math.PI / 6),
        );
        ctx.stroke();
      } else if (stroke.type === 'rectangle' && stroke.points.length === 2) {
        const p1 = stroke.points[0];
        const p2 = stroke.points[1];
        const x1 = timescale.timeToPx(p1.ts);
        const x2 = timescale.timeToPx(p2.ts);
        const y1 = p1.yOffset;
        const y2 = p2.yOffset;

        ctx.strokeRect(
          Math.min(x1, x2),
          Math.min(y1, y2),
          Math.abs(x2 - x1),
          Math.abs(y2 - y1),
        );
      } else if (
        stroke.type === 'text' &&
        stroke.points.length === 1 &&
        stroke.text
      ) {
        const p1 = stroke.points[0];
        const x1 = timescale.timeToPx(p1.ts);
        const y1 = p1.yOffset;

        ctx.font = 'bold 20px sans-serif';
        ctx.fillStyle = stroke.color;
        const displayText = stroke.title || stroke.text || '';
        ctx.fillText(displayText, x1, y1);
      } else {
        // Freeform smoothed using quadratic curves
        const pxPoints = stroke.points.map((p) => ({
          x: timescale.timeToPx(p.ts),
          y: p.yOffset,
        }));

        ctx.moveTo(pxPoints[0].x, pxPoints[0].y);
        for (let i = 1; i < pxPoints.length - 1; i++) {
          const xc = (pxPoints[i].x + pxPoints[i + 1].x) / 2;
          const yc = (pxPoints[i].y + pxPoints[i + 1].y) / 2;
          ctx.quadraticCurveTo(pxPoints[i].x, pxPoints[i].y, xc, yc);
        }
        if (pxPoints.length > 1) {
          const last = pxPoints[pxPoints.length - 1];
          ctx.lineTo(last.x, last.y);
        }
        ctx.stroke();
      }

      const displayTitle = stroke.title || stroke.text;
      if (stroke.type !== 'text' && displayTitle) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        for (const p of stroke.points) {
          const px = timescale.timeToPx(p.ts);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (p.yOffset < minY) minY = p.yOffset;
        }
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = stroke.color;
        ctx.textAlign = 'left';
        // Remove shadow for text
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillText(displayTitle, minX, minY - 10);
        ctx.textAlign = 'start';

        // Restore shadow for next shapes
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
      }
    }

    if (this.state.selectedStroke) {
      const stroke = this.state.selectedStroke;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      if (stroke.type === 'text' && stroke.points.length === 1 && stroke.text) {
        const x1 = timescale.timeToPx(stroke.points[0].ts);
        const y1 = stroke.points[0].yOffset;
        minX = x1;
        maxX = x1 + 100;
        minY = y1 - 20;
        maxY = y1 + 10;
      } else {
        for (const p of stroke.points) {
          const px = timescale.timeToPx(p.ts);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (p.yOffset < minY) minY = p.yOffset;
          if (p.yOffset > maxY) maxY = p.yOffset;
        }
      }

      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(minX - 5, minY - 5, maxX - minX + 10, maxY - minY + 10);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}
