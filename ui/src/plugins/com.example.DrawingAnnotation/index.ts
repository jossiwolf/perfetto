import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import type {App} from '../../public/app';
import {DrawingState} from './state';
import {DrawingOverlay} from './overlay';
import {setupMouseTracker} from './mouse_tracker';
import {registerControlsTab} from './controls_tab';
import {setupFloatingToolbar} from './floating_toolbar';
import './styles.scss';

/**
 * DrawingAnnotationPlugin provides freeform drawing capabilities over the Perfetto trace.
 * It mounts an overlay canvas, a floating toolbar, and a bottom panel tab to allow users
 * to draw, edit, and organize visual annotations directly on the trace viewer.
 */
export default class DrawingAnnotationPlugin implements PerfettoPlugin {
  static readonly id = 'com.example.DrawingAnnotation';
  static readonly description = 'Allows freeform drawing and trace annotations';

  static onActivate(_app: App): void {}

  /**
   * Initializes the plugin when a trace is loaded. Sets up the shared state, UI components,
   * mouse trackers, and registers trace commands.
   *
   * @param trace The Perfetto Trace context representing the active trace.
   * @returns {Promise<void>}
   */
  async onTraceLoad(trace: Trace): Promise<void> {
    const state = new DrawingState();

    const overlay = new DrawingOverlay(state);
    trace.tracks.registerOverlay(overlay);

    // 1. Setup UI Tab for Controls
    registerControlsTab(state, trace);
    trace.tabs.showTab('com.example.DrawingAnnotation#ControlsTab');
    setupFloatingToolbar(state, trace);

    setupMouseTracker(state, trace);

    // 3. Commands for Drawing
    trace.commands.registerCommand({
      id: `com.example.DrawingAnnotation#clearDrawings`,
      name: 'Clear Freeform Drawings',
      callback: () => {
        state.strokes = [];
        trace.raf.scheduleCanvasRedraw();
      },
    });

    trace.commands.registerCommand({
      id: `com.example.DrawingAnnotation#setDrawingColorRed`,
      name: 'Set Drawing Color to Red',
      callback: () => {
        state.activeColor = '#ff0000';
      },
    });

    trace.commands.registerCommand({
      id: `com.example.DrawingAnnotation#setDrawingColorBlue`,
      name: 'Set Drawing Color to Blue',
      callback: () => {
        state.activeColor = '#0000ff';
      },
    });

    // 4. Standard Annotations Commands
    trace.commands.registerCommand({
      id: `com.example.DrawingAnnotation#addAnnotationAtSelection`,
      name: 'Add Annotation at Current Selection',
      callback: () => {
        const sel = trace.selection.selection;
        if (sel.kind === 'area') {
          trace.notes.addSpanNote({
            start: sel.start,
            end: sel.end,
            text: 'Custom Area Annotation',
          });
        } else if (sel.kind === 'track_event') {
          // Fallback to current viewport center if no specific time is selected
          const window = trace.timeline.visibleWindow;
          trace.notes.addNote({
            timestamp: window.midpoint.toTime(),
            text: 'Custom Event Annotation',
          });
        } else {
          const window = trace.timeline.visibleWindow;
          trace.notes.addNote({
            timestamp: window.midpoint.toTime(),
            text: 'Custom Annotation',
          });
        }
      },
    });
  }
}
