import m from 'mithril';
import type {time} from '../../base/time';
import type {Trace} from '../../public/trace';
import type {DrawingState} from './state';
import {Icon} from '../../widgets/icon';

/**
 * Registers the Annotations tab in Perfetto's bottom panel.
 * It renders the list of all currently drawn shapes, computes a topological sort to display
 * connected arrows properly, and allows the user to delete or rename annotations.
 *
 * @param state The shared DrawingState object containing the list of strokes.
 * @param trace The global Perfetto Trace context, used to register the tab and schedule redraws.
 *
 * @returns {void}
 */
export function registerControlsTab(state: DrawingState, trace: Trace) {
  trace.tabs.registerTab({
    uri: 'com.example.DrawingAnnotation#ControlsTab',
    content: {
      getTitle: () => 'Annotations',
      render: () => {
        return m(
          'div',
          {className: 'drawing-controls-wrapper'},
          m(
            'div',
            {className: 'drawing-annotation-panel'},
            m(
              'div',
              {className: 'header'},
              m('h3', 'Annotation List'),
              m(
                'div',
                {className: 'actions'},
                m(
                  'button',
                  {
                    className: 'btn-load',
                    onclick: () => {
                      const id1 = Math.random().toString(36).substr(2, 9);
                      const id2 = Math.random().toString(36).substr(2, 9);
                      const arrowId = Math.random().toString(36).substr(2, 9);

                      const windowStart =
                        trace.timeline.visibleWindow.start.toTime();
                      const windowEnd =
                        trace.timeline.visibleWindow.end.toTime();
                      const windowDur = windowEnd - windowStart;
                      const quarterDur = windowDur / 4n;

                      const p1 = windowStart + quarterDur;
                      const p2 = p1 + quarterDur;
                      const p3 = p2 + quarterDur;

                      state.strokes.push(
                        {
                          id: id1,
                          type: 'rectangle',
                          color: '#f44336',
                          points: [
                            {ts: p1 as time, yOffset: 100},
                            {ts: p2 as time, yOffset: 200},
                          ],
                          title: 'Test 1',
                          description: 'Sample rect',
                        },
                        {
                          id: id2,
                          type: 'circle',
                          color: '#4caf50',
                          points: [
                            {ts: p2 as time, yOffset: 250},
                            {ts: p3 as time, yOffset: 350},
                          ],
                          title: 'Test 2',
                          description: 'Sample circle',
                        },
                        {
                          id: arrowId,
                          type: 'arrow',
                          color: '#000000',
                          points: [
                            {ts: ((p1 + p2) / 2n) as time, yOffset: 200},
                            {ts: ((p2 + p3) / 2n) as time, yOffset: 250},
                          ],
                          sourceId: id1,
                          targetId: id2,
                        },
                      );
                      trace.raf.scheduleCanvasRedraw();
                    },
                  },
                  'Load Test Data',
                ),
                m(
                  'button',
                  {
                    className: 'btn-clear',
                    onclick: () => {
                      state.strokes = [];
                      state.selectedStroke = undefined;
                      trace.raf.scheduleCanvasRedraw();
                    },
                  },
                  'Clear All',
                ),
              ),
            ),
            state.strokes.length === 0
              ? m('div', {className: 'empty-state'}, 'No annotations yet.')
              : (() => {
                  const orderedStrokes: typeof state.strokes = [];
                  const visited = new Set<string>();
                  const outgoingArrows = new Map<
                    string,
                    typeof state.strokes
                  >();
                  for (const s of state.strokes) {
                    if (s.type === 'arrow' && s.sourceId) {
                      if (!outgoingArrows.has(s.sourceId)) {
                        outgoingArrows.set(s.sourceId, []);
                      }
                      outgoingArrows.get(s.sourceId)!.push(s);
                    }
                  }

                  const addNode = (s: (typeof state.strokes)[0]) => {
                    if (visited.has(s.id)) return;
                    visited.add(s.id);
                    orderedStrokes.push(s);
                    if (outgoingArrows.has(s.id)) {
                      for (const arrow of outgoingArrows.get(s.id)!) {
                        if (visited.has(arrow.id)) continue;
                        visited.add(arrow.id);
                        orderedStrokes.push(arrow);
                        if (arrow.targetId) {
                          const target = state.strokes.find(
                            (x) => x.id === arrow.targetId,
                          );
                          if (target) addNode(target);
                        }
                      }
                    }
                  };

                  for (const s of state.strokes) {
                    if (s.type !== 'arrow' || !s.sourceId) {
                      addNode(s);
                    }
                  }
                  for (const s of state.strokes) {
                    if (!visited.has(s.id)) addNode(s);
                  }

                  return orderedStrokes
                    .filter(
                      (s) =>
                        s.type !== 'arrow' ||
                        (s.sourceId !== undefined && s.targetId !== undefined),
                    )
                    .map((s) => {
                      const title =
                        s.title ||
                        s.text ||
                        s.type.charAt(0).toUpperCase() + s.type.slice(1);
                      const isEditing = state.editingStrokeId === s.id;
                      const isConnectedArrow =
                        s.type === 'arrow' &&
                        s.sourceId !== undefined &&
                        s.targetId !== undefined;

                      if (isConnectedArrow) {
                        return m(
                          'div',
                          {
                            key: s.id,
                            className: 'arrow-connector',
                            onbeforeremove: (vnode: m.VnodeDOM) => {
                              vnode.dom.style.opacity = '0';
                              vnode.dom.style.transform = 'scale(0.8)';
                              return new Promise((resolve) =>
                                setTimeout(resolve, 200),
                              );
                            },
                          },
                          m(Icon, {
                            icon: 'arrow_downward',
                            className: 'icon-down',
                          }),
                          m(Icon, {
                            icon: 'close',
                            className: 'delete-btn',
                            onclick: (e: Event) => {
                              e.stopPropagation();
                              state.strokes = state.strokes.filter(
                                (x) => x !== s,
                              );
                              if (state.selectedStroke === s) {
                                state.selectedStroke = undefined;
                              }
                              trace.raf.scheduleCanvasRedraw();
                            },
                          }),
                        );
                      }

                      return m(
                        'div',
                        {
                          key: s.id,
                          className:
                            'annotation-item ' +
                            (state.selectedStroke === s
                              ? 'selected'
                              : 'unselected'),
                          onbeforeremove: (vnode: m.VnodeDOM) => {
                            vnode.dom.style.opacity = '0';
                            vnode.dom.style.transform = 'scale(0.95)';
                            return new Promise((resolve) =>
                              setTimeout(resolve, 200),
                            );
                          },
                          onclick: () => {
                            state.selectedStroke = s;
                            trace.raf.scheduleCanvasRedraw();
                          },
                          ondblclick: () => {
                            state.editingStrokeId = s.id;
                            trace.raf.scheduleCanvasRedraw();
                          },
                        },
                        m(
                          'div',
                          {className: 'item-header'},
                          m(
                            'div',
                            {className: 'title-container'},
                            m('div', {
                              className: 'color-indicator',
                              style: {background: s.color},
                            }),
                            isEditing
                              ? m('input', {
                                  className: 'title-input',
                                  value: title,
                                  oncreate: (vnode: m.VnodeDOM) =>
                                    (vnode.dom as HTMLElement).focus(),
                                  onclick: (e: Event) => e.stopPropagation(),
                                  onmousedown: (e: Event) =>
                                    e.stopPropagation(),
                                  onkeydown: (e: KeyboardEvent) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') {
                                      state.editingStrokeId = undefined;
                                      trace.raf.scheduleCanvasRedraw();
                                    }
                                  },
                                  oninput: (e: Event) => {
                                    s.title = (
                                      e.target as HTMLInputElement
                                    ).value;
                                    trace.raf.scheduleCanvasRedraw();
                                  },
                                  onblur: () => {
                                    state.editingStrokeId = undefined;
                                    trace.raf.scheduleCanvasRedraw();
                                  },
                                })
                              : m('span', {className: 'title-text'}, title),
                          ),
                          m(Icon, {
                            icon: 'delete',
                            className: 'delete-btn',
                            onclick: (e: Event) => {
                              e.stopPropagation();
                              state.strokes = state.strokes.filter(
                                (x) => x !== s,
                              );
                              if (state.selectedStroke === s) {
                                state.selectedStroke = undefined;
                              }
                              trace.raf.scheduleCanvasRedraw();
                            },
                          }),
                        ),
                        isEditing
                          ? m('textarea', {
                              className: 'desc-input',
                              value: s.description || '',
                              placeholder: 'Add description...',
                              onclick: (e: Event) => e.stopPropagation(),
                              onmousedown: (e: Event) => e.stopPropagation(),
                              onkeydown: (e: KeyboardEvent) => {
                                e.stopPropagation();
                              },
                              oninput: (e: Event) => {
                                s.description = (
                                  e.target as HTMLTextAreaElement
                                ).value;
                                trace.raf.scheduleCanvasRedraw();
                              },
                            })
                          : s.description
                            ? m('div', {className: 'desc-text'}, s.description)
                            : null,
                      );
                    });
                })(),
          ),
        );
      },
    },
  });
}
