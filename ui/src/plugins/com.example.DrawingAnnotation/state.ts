import type {TimeScale} from '../../base/time_scale';
import type {time} from '../../base/time';
import type {TrackBounds} from '../../public/track';

export interface Point {
  ts: time;
  yOffset: number;
}

export interface Stroke {
  id: string;
  color: string;
  type: 'freeform' | 'circle' | 'arrow' | 'rectangle' | 'text';
  text?: string;
  title?: string;
  description?: string;
  points: Point[];
  sourceId?: string; // For arrows
  targetId?: string; // For arrows
}

export interface DragState {
  startX: number;
  startY: number;
  originalPoints: Point[];
}

export class DrawingState {
  strokes: Stroke[] = [];
  activeStroke: Stroke | undefined = undefined;
  selectedStroke: Stroke | undefined = undefined;
  editingStrokeId: string | undefined = undefined;
  dragState: DragState | undefined = undefined;
  activeTool:
    | 'freeform'
    | 'rectangle'
    | 'circle'
    | 'arrow'
    | 'text'
    | 'eraser'
    | 'none' = 'none';
  isOverlayVisible = true;
  activeColor = '#ff0000'; // Default red
  latestTimescale: TimeScale | undefined;
  overlayCanvas: HTMLCanvasElement | undefined;
  latestTransform: DOMMatrix | undefined;
  tracks: ReadonlyArray<TrackBounds> = [];
}
