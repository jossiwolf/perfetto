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
import {TOOL_KINDS, ToolController} from './tools';
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

    const tools = new ToolController(store, {
      requestRedraw: () => trace.raf.scheduleFullRedraw(),
      onAnnotationCreated: (_id: string) => {
        trace.tabs.showTab(ANNOTATIONS_TAB_URI);
        trace.raf.scheduleFullRedraw();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el = document.querySelector(
              `.pf-timeline-annotations-item--selected .pf-timeline-annotations-title-input input, .pf-timeline-annotations-item--selected input.pf-timeline-annotations-title-input`,
            ) as HTMLInputElement | null;
            if (el && tools.tool === 'label') {
              el.focus();
              el.select();
            }
          });
        });
      },
    });

    const overlay = new AnnotationsOverlay(store, tools, {
      trackExists: (uri) =>
        trace.currentWorkspace.getTrackByUri(uri) !== undefined,
    });
    trace.tracks.registerOverlay(overlay);

    const redrawDisposable = store.onChange(() => {
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

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const target = e.target as Element | null;
      if (isEditable(target) || isEditable(document.activeElement)) {
        return;
      }
      if (
        (e.key === 'Backspace' || e.key === 'Delete') &&
        store.selectedId !== undefined
      ) {
        e.preventDefault();
        store.remove(store.selectedId);
        trace.raf.scheduleFullRedraw();
        return;
      }
      if (
        store.selectedId !== undefined &&
        tools.tool === 'label' &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const selected = store.get(store.selectedId);
        if (selected?.kind === 'label') {
          const el = document.querySelector(
            '.pf-timeline-annotations-item--selected .pf-timeline-annotations-title-input input, .pf-timeline-annotations-item--selected input.pf-timeline-annotations-title-input',
          ) as HTMLInputElement | null;
          if (el) {
            el.focus();
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
