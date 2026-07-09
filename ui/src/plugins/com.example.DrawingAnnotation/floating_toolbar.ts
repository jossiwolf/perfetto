import m from 'mithril';
import type {time} from '../../base/time';
import type {Trace} from '../../public/trace';
import type {DrawingState} from './state';
import {Icon} from '../../widgets/icon';

/**
 * Mounts an interactive, draggable floating toolbar overlay to the screen using Mithril.
 * Allows the user to select active tools (rectangle, circle, arrow, freeform, text, eraser)
 * and active colors. It handles dynamic anchoring (left vs right screen half) and transitions.
 *
 * @param state The shared DrawingState object containing the currently active tool/color.
 * @param trace The global Perfetto Trace context, used to trigger redraws when tools change.
 *
 * @returns {void}
 */
export function setupFloatingToolbar(state: DrawingState, trace: Trace) {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.zIndex = '9999';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100vw';
  container.style.height = '100vh';
  container.style.pointerEvents = 'none';
  document.body.appendChild(container);

  let isExpanded = false;
  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let currentX = window.innerWidth - 60; // Bottom right default
  let currentTop = window.innerHeight - 100;
  let initialX = currentX;
  let initialTop = currentTop;

  let toolbarElement: HTMLElement | null = null;

  const onDragMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      if (!hasMoved) {
        state.activeTool = 'none';
        trace.raf.scheduleCanvasRedraw();
      }
      hasMoved = true;
    }
    currentX = initialX + dx;
    currentTop = initialTop + dy;
    if (toolbarElement) {
      toolbarElement.style.top = `${currentTop}px`;
      if (currentX < window.innerWidth / 2) {
        toolbarElement.style.left = `${currentX}px`;
        toolbarElement.style.right = 'auto';
        toolbarElement.style.flexDirection = 'row';
      } else {
        toolbarElement.style.right = `${window.innerWidth - currentX}px`;
        toolbarElement.style.left = 'auto';
        toolbarElement.style.flexDirection = 'row-reverse';
      }
    }
  };

  const onDragEnd = () => {
    if (!isDragging) return;
    console.log('floating_toolbar: onDragEnd triggered', {
      hasMoved,
      isExpanded,
    });
    isDragging = false;

    if (!hasMoved && !isExpanded) {
      console.log('floating_toolbar: expanding!');
      isExpanded = true;
    }
    m.redraw();
  };

  window.addEventListener('mousemove', onDragMove, {capture: true});
  window.addEventListener('mouseup', onDragEnd, {capture: true});

  window.addEventListener(
    'mousedown',
    (e) => {
      console.log('floating_toolbar window capture mousedown:', e.target);
      if (toolbarElement && toolbarElement.contains(e.target as Node)) {
        console.log('CLICK INSIDE TOOLBAR!');
        const target = e.target as HTMLElement;
        if (
          isExpanded &&
          target.closest(
            '.tool-btn, .color-picker-wrapper input, .minimize-btn, .select-area-btn',
          ) &&
          !target.closest('.drag-handle')
        ) {
          console.log('floating_toolbar: ignored mousedown on tool-btn');
          return;
        }
        console.log('floating_toolbar: starting drag');
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        initialX = currentX;
        initialTop = currentTop;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    {capture: true},
  );

  const App = {
    view: () => {
      let classNames = 'drawing-annotation-toolbar';
      if (isExpanded) classNames += ' expanded';
      else classNames += ' collapsed';

      if (isDragging) classNames += ' dragging';
      else classNames += ' animating';

      const isLeftSide = currentX < window.innerWidth / 2;

      return m(
        'div',
        {
          className: classNames,
          oncreate: (vnode: m.VnodeDOM) => {
            toolbarElement = vnode.dom as HTMLElement;
            console.log('floating_toolbar: created', toolbarElement);
          },
          onupdate: (vnode: m.VnodeDOM) => {
            toolbarElement = vnode.dom as HTMLElement;
          },
          style: {
            top: `${currentTop}px`,
            ...(isLeftSide
              ? {
                  left: `${currentX}px`,
                  right: 'auto',
                  flexDirection: 'row',
                }
              : {
                  right: `${window.innerWidth - currentX}px`,
                  left: 'auto',
                  flexDirection: 'row-reverse',
                }),
          },
        },
        !isExpanded
          ? m(
              'div',
              {
                className:
                  'collapsed-btn' +
                  (state.activeTool === 'freeform' ? ' active' : ''),
              },
              m(Icon, {icon: 'edit'}),
            )
          : [
              m(
                'div',
                {
                  className: 'drag-handle',
                  title: 'Drag',
                },
                m(Icon, {icon: 'drag_indicator'}),
              ),
              ...[
                {id: 'arrow', icon: 'call_made'},
                {id: 'rectangle', icon: 'crop_square'},
                {id: 'circle', icon: 'radio_button_unchecked'},
                {id: 'freeform', icon: 'gesture'},
                {id: 'text', icon: 'title'},
                {id: 'eraser', icon: 'ink_eraser'},
              ].map((tool) => {
                const active = state.activeTool === tool.id;
                return m(
                  'div',
                  {
                    className: 'tool-btn' + (active ? ' active' : ''),
                    title: tool.id.charAt(0).toUpperCase() + tool.id.slice(1),
                    onclick: () => {
                      state.activeTool = tool.id as DrawingState['activeTool'];
                      trace.raf.scheduleCanvasRedraw();
                    },
                  },
                  m(Icon, {icon: tool.icon}),
                );
              }),

              m(
                'div',
                {className: 'color-picker-wrapper'},
                m('input', {
                  type: 'color',
                  title: 'Color',
                  value: state.activeColor,
                  oninput: (e: Event) => {
                    state.activeColor = (e.target as HTMLInputElement).value;
                  },
                }),
              ),

              m('div', {className: 'separator'}),

              m(
                'div',
                {
                  className: 'tool-btn',
                  title: state.isOverlayVisible
                    ? 'Hide Annotations'
                    : 'Show Annotations',
                  onclick: () => {
                    state.isOverlayVisible = !state.isOverlayVisible;
                    trace.raf.scheduleCanvasRedraw();
                  },
                },
                m(Icon, {
                  icon: state.isOverlayVisible
                    ? 'visibility'
                    : 'visibility_off',
                }),
              ),

              m(
                'div',
                {
                  className: 'tool-btn danger',
                  title: 'Clear All',
                  onclick: () => {
                    state.strokes = [];
                    state.selectedStroke = undefined;
                    trace.raf.scheduleCanvasRedraw();
                  },
                },
                m(Icon, {icon: 'delete_sweep', style: {color: '#f44336'}}),
              ),

              m(
                'div',
                {
                  className:
                    'select-area-btn ' +
                    (state.selectedStroke ? 'active' : 'inactive'),
                  title: 'Select Area',
                  onclick: () => {
                    if (!state.selectedStroke || !state.latestTimescale) return;
                    const stroke = state.selectedStroke;
                    let start = stroke.points[0].ts;
                    let end = stroke.points[0].ts;
                    let minY = Infinity;
                    let maxY = -Infinity;
                    for (const p of stroke.points) {
                      if (p.ts < start) start = p.ts;
                      if (p.ts > end) end = p.ts;
                      if (p.yOffset < minY) minY = p.yOffset;
                      if (p.yOffset > maxY) maxY = p.yOffset;
                    }
                    if (start === end) end = (end + 1n) as time;
                    const uris: string[] = [];
                    for (const t of state.tracks) {
                      if (t.node === undefined || t.node.uri === undefined) {
                        continue;
                      }
                      if (
                        t.verticalBounds.top < maxY &&
                        t.verticalBounds.bottom > minY
                      ) {
                        uris.push(t.node.uri);
                      }
                    }
                    if (uris.length > 0) {
                      trace.selection.selectArea({start, end, trackUris: uris});
                    }
                  },
                },
                m(Icon, {icon: 'highlight_alt'}),
              ),

              m(
                'div',
                {
                  className: 'minimize-btn',
                  title: 'Minimize',
                  onclick: () => {
                    isExpanded = false;
                  },
                },
                m(Icon, {icon: 'close'}),
              ),
            ],
      );
    },
  };

  m.mount(container, App);

  trace.trash.defer(() => {
    m.mount(container, null);
    if (container.parentElement) {
      container.parentElement.removeChild(container);
    }
    window.removeEventListener('mousemove', onDragMove, {capture: true});
    window.removeEventListener('mouseup', onDragEnd, {capture: true});
    // Note: mousedown capture is anonymous and can't be removed, but this is a debug build.
  });
}
