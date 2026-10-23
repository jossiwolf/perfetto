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

import './styles.scss';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {Intent} from '../../widgets/common';
import {showModal} from '../../widgets/modal';
import m from 'mithril';
import {AnnotationStore} from './model';
import {TOOL_KINDS, ToolController, type ToolControllerOptions} from './tools';
import {AnnotationsOverlay} from './overlay';
import {ANNOTATIONS_TAB_URI, AnnotationsTab} from './annotations_tab';
import {AnnotationTrack} from './annotation_track';
import {
  AutosaveStore,
  exportAnnotations,
  importAnnotationsFromFile,
  importFromPluginArgs,
  registerAutosaveSetting,
  wireAutosave,
  wireStorage,
} from './persistence';

export default class TimelineAnnotationsPlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.TimelineAnnotations';
  static readonly description = 'Create and persist rich timeline annotations';
  static readonly status = 'experimental';

  async onTraceLoad(
    trace: Trace,
    args?: {[key: string]: unknown},
  ): Promise<void> {
    const store = new AnnotationStore();
    const autosaveStore = new AutosaveStore();
    const autosaveSetting = registerAutosaveSetting(trace);

    let lastAnnotationSelectTime = 0;

    const originalSelect = store.select.bind(store);
    store.select = (id: string | undefined) => {
      if (id !== undefined) {
        lastAnnotationSelectTime = performance.now();
        trace.tabs.showTab(ANNOTATIONS_TAB_URI);
      }
      originalSelect(id);
    };

    const toolOptions = {
      requestRedraw: () => trace.raf.scheduleFullRedraw(),
      onAnnotationSelected: () => {
        lastAnnotationSelectTime = performance.now();
        trace.tabs.showTab(ANNOTATIONS_TAB_URI);
      },
      onAnnotationCreated: (_id: string) => {
        lastAnnotationSelectTime = performance.now();
        trace.tabs.showTab(ANNOTATIONS_TAB_URI);
        trace.raf.scheduleFullRedraw();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const inputElement = document.querySelector(
              `.pf-timeline-annotations-item--selected .pf-timeline-annotations-title-input input, .pf-timeline-annotations-item--selected input.pf-timeline-annotations-title-input`,
            ) as HTMLInputElement | null;
            const selected = store.selectedId
              ? store.get(store.selectedId)
              : undefined;
            if (
              inputElement &&
              (selected?.kind === 'label' || tools.tool === 'label')
            ) {
              inputElement.focus();
              inputElement.select();
            }
          });
        });
      },
    };

    const tools = new ToolController(
      store,
      toolOptions as unknown as ToolControllerOptions,
    );

    const overlay = new AnnotationsOverlay(store, tools, {
      trackExists: (uri) =>
        trace.currentWorkspace.getTrackByUri(uri) !== undefined,
    });
    trace.tracks.registerOverlay(overlay);

    let prevAnnotationCount = store.list().length;
    const redrawDisposable = store.onChange(() => {
      const currentCount = store.list().length;
      if (currentCount > prevAnnotationCount) {
        const selected = store.selectedId
          ? store.get(store.selectedId)
          : undefined;
        if (selected?.kind === 'label') {
          trace.tabs.showTab(ANNOTATIONS_TAB_URI);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const inputElement = document.querySelector(
                `.pf-timeline-annotations-item--selected .pf-timeline-annotations-title-input input, .pf-timeline-annotations-item--selected input.pf-timeline-annotations-title-input`,
              ) as HTMLInputElement | null;
              if (inputElement) {
                inputElement.focus();
                inputElement.select();
              }
            });
          });
        }
      }
      prevAnnotationCount = currentCount;
      trace.raf.scheduleFullRedraw();
    });
    trace.trash.use(redrawDisposable);

    const storageDisposable = wireStorage(trace, store);
    trace.trash.use(storageDisposable);

    if (store.list().length === 0 && trace.traceInfo.uuid) {
      const autosaved = autosaveStore.load(trace.traceInfo.uuid);
      if (autosaved && autosaved.length > 0) {
        store.replaceAll(autosaved);
      }
    }

    importFromPluginArgs(store, args);

    const autosaveDisposable = wireAutosave(
      trace,
      store,
      autosaveStore,
      autosaveSetting,
    );
    trace.trash.use(autosaveDisposable);

    const track = new AnnotationTrack(trace, store);
    await track.init();
    trace.trash.use({
      [Symbol.dispose]: () => track.dispose(),
    });

    const tab = new AnnotationsTab(trace, store, tools, overlay);
    trace.tabs.registerTab({
      uri: ANNOTATIONS_TAB_URI,
      content: tab,
    });

    const isEditable = (el: Element | null): boolean => {
      if (!el) return false;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        return true;
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        return true;
      }
      return false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as Element | null;
      if (isEditable(target) || isEditable(document.activeElement)) {
        return;
      }
      if (
        (event.key === 'Backspace' || event.key === 'Delete') &&
        store.selectedId !== undefined
      ) {
        event.preventDefault();
        store.remove(store.selectedId);
        trace.raf.scheduleFullRedraw();
        return;
      }
      if (
        store.selectedId !== undefined &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const selected = store.get(store.selectedId);
        if (selected?.kind === 'label') {
          const inputElement = document.querySelector(
            '.pf-timeline-annotations-item--selected .pf-timeline-annotations-title-input input, .pf-timeline-annotations-item--selected input.pf-timeline-annotations-title-input',
          ) as HTMLInputElement | null;
          if (inputElement) {
            inputElement.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    trace.trash.use({
      [Symbol.dispose]: () => {
        document.removeEventListener('keydown', handleKeyDown);
      },
    });

    const handleDocumentClick = (event: MouseEvent) => {
      if (store.selectedId === undefined) {
        return;
      }
      const target = event.target as Element | null;
      if (!target) {
        return;
      }
      if (
        target.closest(
          '.pf-timeline-annotations-tab, .pf-popup, .pf-popup-portal, .pf-modal-backdrop, .pf-modal-dialog',
        )
      ) {
        return;
      }
      if (
        target.closest('.pf-virtual-overlay-canvas, canvas, .pf-timeline-page')
      ) {
        setTimeout(() => {
          if (
            performance.now() - lastAnnotationSelectTime > 50 &&
            store.selectedId !== undefined
          ) {
            store.select(undefined);
          }
        }, 0);
      }
    };

    document.addEventListener('click', handleDocumentClick);
    trace.trash.use({
      [Symbol.dispose]: () => {
        document.removeEventListener('click', handleDocumentClick);
      },
    });

    trace.statusbar.registerItem({
      renderItem: () => {
        if (!tools.drawingMode) {
          return {label: ''};
        }
        return {
          label: `Annotate: ${tools.tool}`,
          icon: 'edit',
          intent: Intent.Primary,
          onclick: () => {
            tools.toggleDrawingMode();
          },
        };
      },
    });

    const toggleDrawingMode = () => {
      const wasOn = tools.drawingMode;
      const nextState = tools.toggleDrawingMode();
      if (!wasOn && nextState) {
        trace.tabs.showTab(ANNOTATIONS_TAB_URI);
      }
    };

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#ToggleDrawingMode`,
      name: 'Timeline Annotations: Toggle drawing mode',
      callback: toggleDrawingMode,
      defaultHotkey: 'Mod+Shift+D',
    });

    for (const toolKind of TOOL_KINDS) {
      const capitalized = toolKind.charAt(0).toUpperCase() + toolKind.slice(1);
      trace.commands.registerCommand({
        id: `${TimelineAnnotationsPlugin.id}#Tool${capitalized}`,
        name: `Timeline Annotations: Select ${capitalized} tool`,
        callback: () => {
          tools.setTool(toolKind);
          if (!tools.drawingMode) {
            tools.setDrawingMode(true);
            trace.tabs.showTab(ANNOTATIONS_TAB_URI);
          }
        },
      });
    }

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#AnnotateSelection`,
      name: 'Timeline Annotations: Annotate current selection',
      callback: () => {
        const selection = trace.selection.selection;
        if (selection.kind !== 'area') {
          return;
        }
        const trackNames = selection.trackUris.map((uri) => {
          const node = trace.currentWorkspace.getTrackByUri(uri);
          return node?.name ?? uri;
        });
        store.add({
          kind: 'rect',
          color: tools.color,
          anchor: {
            start: selection.start,
            end: selection.end,
            trackUris: [...selection.trackUris],
            trackNames,
          },
        });
        trace.tabs.showTab(ANNOTATIONS_TAB_URI);
      },
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#Undo`,
      name: 'Timeline Annotations: Undo',
      callback: () => store.undo(),
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#Redo`,
      name: 'Timeline Annotations: Redo',
      callback: () => store.redo(),
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#DeleteSelected`,
      name: 'Timeline Annotations: Delete selected annotation',
      callback: () => {
        if (store.selectedId !== undefined) {
          store.remove(store.selectedId);
        }
      },
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#ExportJson`,
      name: 'Timeline Annotations: Export to JSON',
      callback: () => exportAnnotations(trace, store),
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#ImportJson`,
      name: 'Timeline Annotations: Import from JSON',
      callback: () => importAnnotationsFromFile(store),
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#ClearAll`,
      name: 'Timeline Annotations: Clear all annotations',
      callback: async () => {
        await showModal({
          title: 'Clear all annotations?',
          content: m(
            'p',
            'This will remove all annotations from the trace. This action can be undone.',
          ),
          buttons: [
            {
              text: 'Clear all',
              primary: true,
              action: () => store.replaceAll([]),
            },
            {
              text: 'Cancel',
            },
          ],
        });
      },
    });

    trace.commands.registerCommand({
      id: `${TimelineAnnotationsPlugin.id}#CancelGesture`,
      name: 'Timeline Annotations: Cancel in-progress gesture',
      callback: () => {
        if (tools.drawingMode) {
          tools.cancelGesture();
        }
      },
    });
  }
}
