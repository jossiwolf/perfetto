# Timeline annotations: shapes, labels and connectors as a UI plugin

**Authors:** @jossiwolf
**Status:** Draft
**Discussion:** https://github.com/google/perfetto/issues/6626
**Prior prototype (context only):**
https://github.com/jossiwolf/perfetto/tree/better-annotations

## Problem

Trace analysis is often collaborative: we share traces to explain regressions
and to walk colleagues through causal chains that span several tracks. Today,
the UI's annotation capability is limited to point flags and span markers
(`NoteManager` in `ui/src/public/note.ts`). These markers render as vertical
lines spanning every track across the entire timeline canvas. They cannot
visually isolate individual tracks, group concurrent slices, or draw
directional relationships between disparate events.

Consequently, engineers routinely fall back to taking screenshots of the
Perfetto UI, pasting them into drawing tools (such as Google Slides, Figma, or
Excalidraw) to draw bounding boxes, circles, and arrows, and sharing static PNGs
over chat, bug reports, and design docs. This workflow has three problems:

1. **Loss of interactivity:** Static screenshots discard all trace data.
   Colleagues cannot zoom into surrounding slices, inspect slice arguments,
   view flow events, or run PerfettoSQL queries on highlighted regions.
2. **Cross-track causality is difficult to convey:** Explaining scheduling
   dependencies (e.g. Binder transactions, thread wakeups, or CPU migrations)
   requires directional arrows directly connecting source and destination
   slices across different tracks.
3. **Fragile sharing and lifecycle:** Annotations drawn on screenshots cannot be
   preserved across trace reloads, cannot be attached to bug reports as
   reproducible permalinks, and cannot be updated when analyzing a new capture.

A prototype ([github.com/jossiwolf/perfetto/tree/better-annotations][prototype])
explores rich timeline annotations (rectangles, ellipses, arrows, text labels
and freeform sketches) drawn directly over the timeline. The design below is
a from-scratch proposal informed by that experiment; it does not reuse its code.

This RFC proposes productionizing timeline annotations as a standard Perfetto UI
plugin with the minimum possible core API change, resolving track sync
concerns, and defining a robust storage and sharing architecture.

[prototype]: https://github.com/jossiwolf/perfetto/tree/better-annotations

## Goals and non-goals

### Goals

- **Rich visual primitives:** Support rectangles, ellipses, freehand pen
  strokes (with heuristic recognition into regular geometric shapes), text
  labels with custom typography, and directional arrows (including quadratic
  Bezier curved connectors) connecting annotations or timeline points.
- **Robust data-space anchoring:** Anchor all shapes to timestamps and track
  URIs using the existing `Area` selection primitive, ensuring annotations
  remain aligned across zoom, pan, track reordering, and track collapse.
- **Graceful degradation:** Never silently drop annotations when tracks are
  collapsed, moved, or missing due to differing plugin configurations.
- **Hybrid companion track:** Materialize every annotation as a slice on a
  dedicated "Annotations" track, enabling slice navigation, PerfettoSQL
  queries, and creation via standard area selections without entering drawing
  mode.
- **Canonical versioned schema with multi-transport persistence:** Persist
  annotations through a versioned Zod schema via `trace.registerStorage`,
  integrating seamlessly with Perfetto permalinks, local crash-recovery
  storage, sidecar JSON file export/import, and embedding via `postMessage`.
- **Minimal core API footprint:** Extend the public `Overlay` interface with
  declarative interaction hit-zones and pointer hooks; keep all drawing,
  recognition, and UI within the plugin.

### Non-goals

- Real-time collaborative multi-user editing (e.g. CRDTs or WebSockets).
- Threaded commenting or discussion workflows.
- Modifying underlying trace data or Trace Processor database contents.
- In-UI image export (e.g. PNG/SVG rendering of the canvas); users can
  continue using standard OS screenshot utilities if static images are needed.

## Decision (Pending)

We propose:

1. Implement timeline annotations as a UI plugin
   (`dev.perfetto.TimelineAnnotations`).
2. Refine the public `Overlay` interface (`ui/src/public/track.ts`) with a
   hybrid interaction model combining declarative interaction hit-zones
   (`getInteractionZones`) and creation-mode pointer capture (`isInteractive`),
   wiring event dispatch directly into `TrackTreeView`'s declarative
   `ZonedInteractionHandler` (`ui/src/base/zoned_interaction_handler.ts`).
3. Anchor all annotation coordinates in data space using `Area` (`start: time,
   end: time, trackUris: string[]`) and relative vertical track offsets
   (`yFrac`), completely avoiding canvas pixel storage.
4. Materialize every annotation on a companion synthetic "Annotations" slice
   track backed by an in-memory SQL table.
5. Persist annotations canonically using a versioned Zod schema registered with
   `trace.registerStorage`, supporting permalinks, local storage, sidecar JSON
   files, and `postMessage` injection.

## Background: what exists at HEAD

Perfetto's UI architecture provides several foundational extension points:

- **Overlays (`ui/src/public/track.ts:351-360`):** Plugins can register canvas
  overlays via `trace.tracks.registerOverlay(overlay: Overlay)`. Overlays
  receive `(ctx, timescale, size, tracks, theme, rootNode)` every animation
  frame, rendering on top of all tracks after area selections are painted
  (`ui/src/core_plugins/dev.perfetto.Timeline/track_tree_view.ts:488`). However,
  `Overlay` was historically designed as a stateless post-track 2D canvas paint
  pass (e.g. `FlowEvents`, `WakerOverlay`, `RelatedEventsOverlay`) and
  exposes no pointer or keyboard input hooks.
- **TrackTreeView and ZonedInteractionHandler:** Viewport gesture arbitration
  lives in `TrackTreeView`'s declarative `ZonedInteractionHandler`
  (`ui/src/base/zoned_interaction_handler.ts`). Crucially, `TimelinePage` mounts
  *two* separate `TrackTreeView` instances (`pinnedTracksNode` for pinned tracks
  and `tracks` for scrollable tracks), each maintaining its own HTML canvas and
  its own independent `ZonedInteractionHandler`.
- **Track bounds and workspace (`ui/src/public/track.ts`,
  `ui/src/public/workspace.ts`):** Tracks are organized into a hierarchy of
  `TrackNode`s. Each node has a stable plugin-defined string `uri`, while
  `node.id` is session-ephemeral (`createSessionUniqueId`, `workspace.ts:37`).
  `TrackBounds` (`track.ts:346`) pairs a `TrackNode` with its current rendered
  `verticalBounds`.
- **Area selection (`ui/src/public/selection.ts:238-245`):** Area selections
  are defined by
  `Area {start: time, end: time, trackUris: ReadonlyArray<string>}`.
  This structure is already serialized and restored across permalinks.
- **Synthetic tracks (`ui/src/components/tracks/debug_tracks.ts`):** Plugins
  can execute `trace.engine.query('CREATE TABLE ...')` and register custom slice
  tracks using `SliceTrack.create({...})` (precedent in `com.example.Tracks`).
- **State serialization (`ui/src/public/trace.ts:99`):** Plugins register
  per-trace persistent state via `trace.registerStorage<T>({id, schema,
  defaultValue})`. The core serializes this into `SerializedAppState.store[]`
  (`ui/src/core/state_serialization.ts:156-160`), which is uploaded to Cloud
  Storage (`perfetto-ui-data`) when generating permalinks
  (`permalink.ts:50-58`).

## Design

### Anchoring model: data-space positioning

Storing canvas pixels for the vertical dimension is the obvious shortcut and
the wrong one: pixels detach as soon as tracks are expanded, collapsed,
reordered or the track list is scrolled.

We establish a strict principle: **never store canvas pixels**. Every
annotation is anchored strictly in data space:

```ts
interface AreaAnchor {
  readonly start: time;
  readonly end: time;
  readonly trackUris: ReadonlyArray<string>;
}
interface AnchoredPoint {
  readonly ts: time;
  readonly trackUri: string;
  readonly yFrac: number; // 0.0 at top of track, 1.0 at bottom
}
```

- **Area anchors (rectangles, ellipses):** Anchored using `AreaAnchor`, the
  same interface the UI already serializes for area selections.
- **Point anchors (freehand paths, labels, arrow free ends):** Defined as an
  `AnchoredPoint` with a timestamp and fractional vertical track offset.
- **Connector/arrow endpoints:** An arrow endpoint binds either to an existing
  annotation ID (connecting to its boundary or centroid) or to an explicit
  `AnchoredPoint`.

At render time, the plugin resolves data anchors against `TrackBounds`:
- `x` coordinates are computed dynamically via `timescale.timeToPx(ts)`.
- `y` coordinates are computed by looking up `TrackBounds` by `node.uri`.
  For an `AnchoredPoint`, `y = top + yFrac * (bottom - top)`.
  For an `AreaAnchor`, `top = min(track.top)` and `bottom = max(track.bottom)`
  across all resolved tracks.

`TrackNode.id` is session-ephemeral (`workspace.ts:37`) and must never be
stored. The plugin uses `node.uri` as the unique, stable key.

To mitigate cases where auto-generated or debug tracks use session-specific URI
suffixes (e.g. `__debug_track_1`), the plugin stores an optional `trackName`
alongside each `trackUri`. If URI lookup fails at render time, the plugin
attempts fuzzy name matching against visible tracks in `rootNode`, matching the
precedent established by `AutoPinAndExpandTracks`.

### Staying in sync with tracks

During review of issue #6626, Primiano asked how annotations stay in sync when
the track layout changes:
1. What happens if a user hides or expands a track?
2. What happens if tracks get reordered, especially since track ordering is not
   guaranteed idempotent across plugin execution orders or differing setups?
3. What happens if a user adds a debug track, switches workspaces, or opens a
   trace with different active plugins?

The anchoring model resolves each of these through a deterministic degradation
ladder:

| Event | Anchoring resolution & visual behavior |
|---|---|
| **Track collapsed inside a group** | The plugin walks `rootNode` to find the nearest visible ancestor `TrackNode` (e.g. parent process/group) and projects vertical bounds onto that ancestor. Multi-track shapes contract to visible ancestor bounds. |
| **Track expanded from group** | Child `TrackBounds` become visible; annotations immediately snap back to exact track bounds. |
| **Tracks reordered or pinned** | Lookup is by `trackUri`, not vertical index. Shapes move vertically with their tracks. If the member tracks of a multi-track shape are no longer contiguous, the shape spans from the topmost to the bottommost resolved track, exactly as an area selection does today; unrelated tracks in between are visually included. We accept this rather than splitting the shape. |
| **Track missing entirely (different plugins, debug track removed)** | The annotation degrades to "unanchored" mode: it renders as a semi-transparent time-range vertical band across the timeline (similar to a SPAN note). The Annotations tab flags the item with a missing-track badge. It is never silently dropped. |
| **Differing per-user plugins / macros** | If a track URI is absent, fuzzy matching checks visible track names. If fuzzy matching succeeds, it anchors to that track. If it fails, it falls back to unanchored time-band mode. |

### The Annotations slice track (hybrid model)

Primiano suggested that letting users create actual tracks with draggable
slices would degrade far more gracefully than pure freeform drawings. We adopt
this insight as a complementary, hybrid layer rather than an either-or choice.

The plugin materializes an "Annotations" synthetic track on the timeline:
- On trace load, the plugin creates an in-memory SQL table:
  ```sql
  CREATE TABLE __timeline_annotations (
    id TEXT PRIMARY KEY, ts INT64 NOT NULL, dur INT64 NOT NULL,
    name TEXT NOT NULL, kind TEXT NOT NULL,
    color TEXT NOT NULL, description TEXT
  );
  ```
- The plugin registers a standard slice track displaying this table using
  `SliceTrack.create({...})` and inserts a `TrackNode` into the workspace
  (following `com.example.Tracks` and `debug_tracks.ts`).
- Whenever an annotation is created, updated, or deleted, the plugin updates
  `__timeline_annotations` and schedules a redraw via
  `trace.raf.scheduleFullRedraw()`.
- The table is derived state: it is rebuilt from the plugin's serialized
  annotations on every trace load and is never itself persisted. Arrows and
  labels have no natural duration; they materialize as a slice spanning the
  time range of their endpoints (an instant slice for a label).

This hybrid architecture provides distinct advantages:
1. **Universal fallback:** Even if every anchored track is missing or hidden,
   every annotation remains visible, clickable, and navigable as a slice on the
   Annotations track.
2. **Standard interaction:** Clicking an annotation slice focuses the timeline
   both horizontally and vertically via
   `trace.scrollTo({time: {start: ts, end: ts + dur},`
   `track: {uri, expandGroup: true}})`,
   selects the annotation, and opens its details in the Annotations tab.
3. **PerfettoSQL queryability:** Annotations can be queried and joined directly:
  ```sql
  SELECT a.name, a.description, s.name AS slice_name, s.dur
  FROM __timeline_annotations a
  JOIN slice s ON s.ts >= a.ts AND s.ts + s.dur <= a.ts + a.dur;
  ```
4. **No-drawing creation path:** Users can drag-select an area on any track
   using standard area selection and execute the command "Annotate selection",
   creating an annotation without switching into drawing mode.

### Core change: Timeline overlay interaction API

A drawing tool needs pointer input over the track canvas. Today a plugin can
only obtain it by attaching global `window` listeners and injecting its own DOM,
which violates the plugin guidelines (`docs/contributing/ui-plugins.md:25-27`),
intercepts events meant for other panels (tabs, omnibox, sidebar) and drifts out
of sync when the track list scrolls.

#### Architectural critique of raw imperative callbacks

An intuitive proposal is to expose raw imperative pointer callbacks
(`onPointerDown`, `onPointerMove`, `onPointerUp`) guarded by a boolean
`isInteractive()` predicate directly on `TrackManager.registerOverlay`.
However, in Perfetto's architecture this is suboptimal for three reasons:

1. **Mismatched abstraction level:** `Overlay` on `TrackManager` was conceived
   and designed as a stateless post-track 2D canvas paint pass (`FlowEvents`,
   `WakerOverlay`, `RelatedEventsOverlay`). In contrast, viewport gesture
   arbitration, hit-testing priority, and drag life cycles live in
   `TrackTreeView`'s declarative `ZonedInteractionHandler`
   (`ui/src/base/zoned_interaction_handler.ts`).
2. **Coarse hit-testing and event starvation:** A simple boolean
   `isInteractive()` forces a coarse full-viewport interaction zone (`area:
   timelineRect`). In `select` or navigation mode, this monolithic zone swallows
   all mouse clicks, drags, and hover events across the entire timeline canvas.
   Normal slice selection, area selection, and shift-drag panning on empty
   canvas space are completely blocked. Furthermore, `ZonedInteractionHandler`
   does not fire `onPointerMove` during unpressed mouse hover, making per-shape
   hover highlights and per-handle cursors (`move`, `nwse-resize`, `grab`)
   impossible with raw overlay callbacks alone.
3. **Dual-canvas view hierarchy:** `TimelinePage` mounts *two* independent
   `TrackTreeView` instances: `pinnedTracksNode` (for pinned tracks at the top)
   and `tracks` (for the scrollable track tree below). Each tree view operates
   its own HTML `<canvas>` element and its own `ZonedInteractionHandler`. A
   single global imperative overlay hook cannot properly route interactions
   across this dual-canvas split or respect individual track clipping.

#### The refined hybrid zone + pointer design

To bridge this gap, we adopt a hybrid interaction architecture:
- `Overlay` adds an optional `getInteractionZones(ctx)` method alongside
  `isInteractive?()`.
- `TrackTreeView.drawCanvas` invokes `overlay.render(...)` *before*
  `updateInteractions(...)`. On every animation frame, `render` calculates and
  updates screen-space geometries (bounding boxes, corner resize handles, Bezier
  curvature control points) for the given `rootNode`.
- When creation tools (`rect`, `ellipse`, `pen`, `arrow`, `label`) are active,
  `isInteractive()` returns `true`. This prepends a full-viewport `timelineRect`
  capture zone with `cursor: 'crosshair'`, delivering down/move/up drag
  events to the active creation tool.
- When in `select` or navigation mode, `isInteractive()` returns `false`, and
  `getInteractionZones` returns localized, shape-specific hit-zones:
  - Annotation bounding boxes with `cursor: 'move'` for dragging/repositioning.
  - Corner and edge resize handles with directional cursors (e.g.
    `cursor: 'nwse-resize'`).
  - Bezier midpoint curvature handles with `cursor: 'grab'`.
- Crucially, all unannotated, empty timeline canvas space falls through to
  Perfetto's standard `ZonedInteractionHandler` entries, enabling uninterrupted
  slice selection, time-range scrubbing, and shift-drag panning.

```ts
export interface OverlayInteractionContext {
  readonly timescale: TimeScale;
  readonly size: Size2D;
  readonly tracks: ReadonlyArray<TrackBounds>;
  readonly rootNode: TrackNode;
  readonly visibleArea: Rect2D;
}

export interface OverlayInteractionZone {
  readonly id: string;
  readonly bounds: Rect2D;
  readonly cursor?: string;
  readonly onPointerDown?: (ev: OverlayPointerEvent) => void;
  readonly onPointerMove?: (ev: OverlayPointerEvent) => void;
  readonly onPointerUp?: (ev: OverlayPointerEvent) => void;
}

export interface OverlayPointerEvent {
  // CSS px in container space matching Overlay.render() and timescale:
  readonly x: number;
  readonly y: number;
  readonly ts: time; // pxToHpTime(x).toTime()
  readonly track?: TrackBounds; // Track under pointer, if any
  readonly tracks: ReadonlyArray<TrackBounds>;
  readonly timescale: TimeScale;
  readonly rootNode: TrackNode;
  readonly buttons: number; // MouseEvent.buttons
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly zoneId?: string;
}

export interface Overlay {
  render(
    ctx: CanvasRenderingContext2D,
    timescale: TimeScale,
    size: Size2D,
    tracks: ReadonlyArray<TrackBounds>,
    theme: CanvasColors,
    rootNode: TrackNode,
  ): void;

  isInteractive?(): boolean;
  getInteractionZones?(
    ctx: OverlayInteractionContext,
  ): ReadonlyArray<OverlayInteractionZone>;

  onPointerDown?(ev: OverlayPointerEvent): void;
  onPointerMove?(ev: OverlayPointerEvent): void;
  onPointerUp?(ev: OverlayPointerEvent): void;
}
```

#### Frame lifecycle and multi-canvas dispatch in TrackTreeView

In `TrackTreeView.drawCanvas`:
1. `overlay.render(ctx, timescale, size, tracks, theme, rootNode)` executes for
   each registered overlay. The annotation overlay projects data anchors into
   screen pixels and caches hit-test geometry for the current `rootNode`.
2. `TrackTreeView` calls `updateInteractions(...)`. If `overlay.isInteractive()`
   is true, it registers the full-viewport capture zone. Otherwise, it calls
   `overlay.getInteractionZones(ctx)` and injects the returned localized zones
   into `ZonedInteractionHandler`.
3. Because `pinnedTracksNode` and `tracks` invoke `drawCanvas` independently,
   each tree view passes its own `rootNode` and `tracks` array. Annotations
   anchored to pinned tracks register interaction zones on the pinned canvas;
   annotations on regular tracks register zones on the scrollable canvas.
4. Any pointer gesture outside the localized annotation zones falls through to
   native Perfetto timeline handlers: slice selection, shift-drag horizontal
   panning, time-range selection, and track hover.

Keyboard input needs no new hook: tool switching, cancel (`Escape`), delete
(`Backspace`/`Delete`), and undo/redo (`Mod+Z`/`Mod+Shift+Z`) are registered as
commands with default hotkeys via `trace.commands`.

This change is strictly additive and backward compatible: existing overlays omit
the optional hooks and experience zero behavioral change.

### Optional core follow-ups

We identify two optional, non-blocking core improvements:
1. **Public NoteManager mutations:** Expose `removeNote()` and `changeNote()` on
   public `NoteManager` (`ui/src/public/note.ts:17`). Currently these exist only
   in private core (`ui/src/core/note_manager.ts:72-86`). Exposing them would
   allow a "Promote annotation to span note" command.
2. **Timeline toolbar slot:** For v1 the plugin selects tools through commands,
   hotkeys, a statusbar item and the Annotations tab. A core-provided timeline
   toolbar slot would be a cleaner home for drawing tools.

### Data model and schema

All annotations are governed by a canonical, versioned Zod schema:

```ts
import {z} from 'zod';
import {Time} from '../../base/time';

// Same convention as core's state_serialization_schema.ts: time is serialized
// as a decimal string and parsed back with Time.fromRaw(BigInt(s)).
const zTime = z.string().transform((s) => Time.fromRaw(BigInt(s)));

const PointSchema = z.object({
  ts: zTime,
  trackUri: z.string(),
  trackName: z.string().optional(),
  yFrac: z.number().min(0).max(1),
});

const AreaAnchorSchema = z.object({
  start: zTime,
  end: zTime,
  trackUris: z.array(z.string()),
  trackNames: z.array(z.string()).optional(),
});

const ArrowEndpointSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('annotation'), id: z.string().uuid()}),
  z.object({kind: z.literal('point'), point: PointSchema}),
]);

const BaseAnnotationSchema = z.object({
  id: z.string().uuid(),
  title: z.string().optional(),
  description: z.string().optional(),
  color: z.string(), // Hex or CSS stroke color string
  fillColor: z.string().optional(), // Selectable dim/fill color
  fillOpacity: z.number().min(0).max(1).optional(), // 0.0 to 1.0 opacity
  author: z.string().optional(), // Free text, never auto-filled from account
  createdAt: z.number(), // Epoch ms
  updatedAt: z.number(),
});

const RectAnnotationSchema = BaseAnnotationSchema.extend({
  kind: z.literal('rect'),
  anchor: AreaAnchorSchema,
});

const EllipseAnnotationSchema = BaseAnnotationSchema.extend({
  kind: z.literal('ellipse'),
  anchor: AreaAnchorSchema,
});

const LabelAnnotationSchema = BaseAnnotationSchema.extend({
  kind: z.literal('label'),
  position: PointSchema,
  text: z.string(),
  fontFamily: z.enum(['sans-serif', 'monospace', 'serif']).optional(),
  fontSize: z.number().min(8).max(72).optional(),
  textColor: z.string().optional(),
  backgroundColor: z.string().optional(),
});

const PathAnnotationSchema = BaseAnnotationSchema.extend({
  kind: z.literal('path'),
  points: z.array(PointSchema).max(256),
});

const ArrowControlOffsetSchema = z.object({
  alongFrac: z.number().min(0).max(1),
  normalPx: z.number(),
});

const ArrowAnnotationSchema = BaseAnnotationSchema.extend({
  kind: z.literal('arrow'),
  from: ArrowEndpointSchema,
  to: ArrowEndpointSchema,
  curvature: z.number().optional(), // Normalized displacement along normal
  controlOffset: ArrowControlOffsetSchema.optional(),
});

export const AnnotationSchema = z.discriminatedUnion('kind', [
  RectAnnotationSchema,
  EllipseAnnotationSchema,
  LabelAnnotationSchema,
  PathAnnotationSchema,
  ArrowAnnotationSchema,
]);

export const SerializedAnnotationsSchema = z.object({
  version: z.literal(1),
  annotations: z.array(AnnotationSchema),
});

export type Annotation = z.infer<typeof AnnotationSchema>;
export type SerializedAnnotations = z.infer<typeof SerializedAnnotationsSchema>;
```

#### Curved arrows and Bezier geometry

Straight arrows can visually collide with intermediate tracks and slices.
`ArrowAnnotation` supports quadratic Bezier curves parameterized by
`curvature` and optional `controlOffset: {alongFrac, normalPx}`:
- The baseline vector spans start point $P_0$ to end point $P_1$.
- The Bezier control point $P_c$ is displaced perpendicular to the baseline at
  fractional distance `alongFrac` (default 0.5) by `normalPx` pixels.
- The quadratic curve evaluates $B(t) = (1-t)^2 P_0 + 2(1-t)t P_c + t^2 P_1$.
- A draggable curvature handle sits at the midpoint ($t = 0.5$, cursor:
  `grab`), allowing users to arc connectors around obstructing track data.
- Arrowheads are dynamically calculated from the derivative tangent vector
  $B'(1) = 2(P_1 - P_c)$, ensuring arrowheads are tangent-aligned to the curve
  at the destination endpoint.

#### Type conversion (changeKind)

Users frequently sketch an initial bounding box and later realize an ellipse,
callout label, or arrow connector would better convey the pattern. The plugin
implements a lossless `changeKind(id, targetKind)` mutation:
- **Metadata preservation:** `id`, `title`, `description`, `color`,
  `fillColor`, `fillOpacity`, `author`, `createdAt`, and `updatedAt` are
  strictly preserved.
- **Conversion semantics:**
  - `rect` $\leftrightarrow$ `ellipse`: Direct swap of `kind`; identical
    `AreaAnchor` is retained.
  - `rect` / `ellipse` $\to$ `label`: Anchor centroid $(ts_{mid}, yFrac_{mid})$
    becomes `position: PointSchema`; `title` or `description` initializes
    `text`.
  - `label` $\to$ `rect` / `ellipse`: `position` expands into an `AreaAnchor`
    spanning $\pm 5\%$ of visible timeline width and full track height.
  - `rect` / `ellipse` $\to$ `arrow`: Creates a diagonal connector from top-left
    $(start, trackUris[0])$ to bottom-right $(end, trackUris[last])$.
  - `arrow` $\to$ `rect` / `ellipse`: Computes the bounding box of `from` and
    `to` endpoints into an `AreaAnchor`.
  - `path` $\to$ `rect` / `ellipse`: Computes the bounding envelope of stroke
    points into an `AreaAnchor`.

**Size discipline:** Freeform strokes can generate hundreds of intermediate
points. The plugin runs the Ramer-Douglas-Peucker simplification algorithm on
every stroke, capping paths at 256 points. Stroke recognition heuristically
converts eligible freehand loops and boxes into `ellipse` or `rect` shapes,
keeping serialized permalink payloads compact.

**Privacy:** `author` is optional free text set by the user. The plugin never
derives it from a signed-in identity, because permalink payloads are
world-readable to anyone holding the link.

### Storage, sharing, and serialization

The plugin implements one canonical schema across five distinct transports:

1. **Transport 1: Permalinks via `trace.registerStorage` (Default, zero core
   change):**
   The plugin registers its schema using `trace.registerStorage({id:
   'dev.perfetto.TimelineAnnotations', schema: SerializedAnnotationsSchema,
   defaultValue: {version: 1, annotations: []}})`. On permalink creation, this
   data is automatically included in `SerializedAppState.store[]`
   (`ui/src/core/state_serialization.ts:156-160`) and uploaded to Google Cloud
   Storage (`perfetto-ui-data`). Permalinks (`#!/?s=<hash>`) restore
   annotations transparently. State-only permalinks are fully supported for
   URL-loaded traces. For locally opened files the trace itself must be uploaded
   for a permalink to be useful, which is restricted to internal users
   (`trace_share_utils.ts:24-26`); the sidecar file transport below covers
   everyone else. Per plugin guidelines, migrations must be
   backward-compatible since permalinks live indefinitely.
2. **Transport 2: Local recovery storage (Zero core change):**
   To guard against accidental tab closure, annotations are debounced and
   auto-saved to `window.localStorage` under key
   `perfetto_annotations_${trace.traceInfo.uuid}`. To prevent unbounded storage
   growth, an LRU cache retains annotations for the last 20 traces. Global
   enablement is controlled via `trace.settings.register` (the Settings API is
   used solely for the boolean preference, not for trace data).
3. **Transport 3: Sidecar file export and import (Zero core change):**
   For workflows where traces are shared via external files or issue trackers,
   the plugin provides commands "Export annotations to JSON" and "Import
   annotations from JSON". Files are named `<trace-title>.annotations.json`.
   On import, existing annotations merge by UUID (latest `updatedAt` wins),
   preventing destructive overwrites.
4. **Transport 4: Dashboard injection via postMessage (Zero core change):**
   External dashboards embedding Perfetto via iframe can inject annotations
   directly upon loading by supplying
   `pluginArgs: {'dev.perfetto.TimelineAnnotations': serializedState}`
   in the initial `postMessage` (`ui/src/frontend/post_message_handler.ts:420`),
   or by referencing an `appStateHash`.
5. **Transport 5: Trace-bundled metadata (Future, RFC-0030 dependency):**
   In the future, annotations can be packaged directly into a trace archive via
   RFC-0030 (`perfetto_metadata.json` sidecar within zip/tar containers,
   ingested into Trace Processor's `metadata` table). We explicitly reject
   inventing a custom protobuf TracePacket or extending `UiState`
   (`ui_state.proto`), as RFC-0030 warns against trace mutation and the UI does
   not restore `UiState` at HEAD.

| Transport | Needs core changes? | Survives reload? | Cross-user sharing? | Works offline? | Availability |
|---|---|---|---|---|---|
| **Permalink (`registerStorage`)** | No | Yes | Yes (via URL hash) | No (requires GCS) | All users (state-only / internal) |
| **Local storage** | No | Yes | No (single browser) | Yes | All users |
| **Sidecar JSON file** | No | Yes (manual) | Yes (file attachment) | Yes | All users |
| **postMessage injection** | No | No (host managed) | Yes (host managed) | Yes | Embedded / dashboard users |
| **RFC-0030 trace bundle** | Yes (RFC-0030) | Yes | Yes (in trace file) | Yes | Future (post RFC-0030) |

### UX and interaction design

- **Drawing mode:** Toggled via the command palette or a hotkey (binding to be
  chosen; `Mod+Shift+A` is already used by `dev.perfetto.Intelletto`). An
  indicator appears in the status bar when active.
- **Available tools:**
  - *Select/Move:* Select, transform, or drag existing shapes. Hovering displays
    appropriate cursors (`move` for bodies, `nwse-resize` for resize handles,
    `grab` for curvature handles).
  - *Rectangle / Ellipse:* Click and drag across tracks.
  - *Pen:* Freeform sketching with heuristic shape recognition.
  - *Arrow / Connector:* Drag between shapes or points; snaps to bounding
    boxes. Displays a draggable curvature midpoint handle for quadratic Bezier
    arcs.
  - *Text Label:* Click on a track to place a text label.
- **Immediate inline text entry:** Clicking to place a `label` immediately
  spawns an auto-focused inline text input over the canvas. Pressing `Enter` or
  clicking away commits the text; pressing `Escape` cancels or deletes an
  empty label.
- **Keyboard shortcuts:**
  - `Backspace` / `Delete`: Deletes the currently selected annotation(s).
  - `Escape`: Deselects current shape or cancels in-flight drawing.
  - `Mod+Z` / `Mod+Shift+Z`: Undo and redo drawing actions.
- **Popup-based styling pickers:** Clicking a selected annotation or handle
  opens a compact floating style picker:
  - Stroke color palette and custom hex input.
  - Fill color palette and `fillOpacity` slider (0% to 100%).
  - Typography controls for labels: font family (`sans-serif`, `monospace`,
    `serif`), font size stepper (8px to 72px), text color, and background color.
  - Shape type conversion menu (`changeKind`).
- **Combined horizontal and vertical navigation:** Clicking an annotation in the
  Annotations tab or companion slice track issues:
  `trace.scrollTo({time: {start: ts, end: ts + dur},`
  `track: {uri, expandGroup: true}})`.
  The viewport smoothly centers the time interval and scrolls vertically to the
  anchored track, automatically expanding collapsed parent groups if necessary.
- **No-drawing path:** Users can drag-select an area using standard area
  selection and run the command "Annotate selection" to create a box with title
  and description immediately.
- **Annotations tab:** A dedicated bottom tab lists all annotations in
  chronological order. Users can edit titles and descriptions, change colors,
  jump to annotations, or toggle individual visibility.
- **Theme integration:** Colors adapt dynamically to light and dark modes
  using the `CanvasColors` object provided by `Overlay.render()`.

### Plugin structure

The plugin is split so that everything below the integration layer is plain data
in, plain data out, and unit-tested without a DOM:

- `schema.ts`: Versioned Zod schema of the JSON form; timestamps as decimal
  strings.
- `model.ts`: In-memory types with `time`, `AnnotationStore` with undo/redo,
  cascade delete of arrows, merge-by-id import, serialization round-trip, color
  normalization, and `changeKind` type conversion.
- `anchor.ts`: Resolution ladder exact -> visible ancestor -> fuzzy name; px ->
  anchor conversions.
- `geometry.ts`: Ramer-Douglas-Peucker, shape recognition, Bezier curves, hit
  tests.
- `tools.ts`: Tool state machine: select, rect, ellipse, pen, arrow, label;
  creation mode drives `isInteractive()`.
- `overlay.ts`: `Overlay` implementation: rendering, degradation visuals,
  gesture preview, and `getInteractionZones` provider for localized hit-zones.
- `annotation_track.ts`: Synthetic slice track over an in-memory
  `__timeline_annotations` table, re-queried by bumping the dataset source.
- `persistence.ts`: `registerStorage` sync, localStorage autosave with LRU, JSON
  export/import, `pluginArgs` import.
- `annotations_tab.ts`: List, style pickers, and editing UI.
- `index.ts`: Wiring, commands, statusbar, settings.
- `styles.scss`.

Core changes are confined to `ui/src/public/track.ts` (interface additions)
and, under `ui/src/core_plugins/dev.perfetto.Timeline/`, the new
`overlay_interactions.ts` plus wiring in `track_tree_view.ts`.

## Rollout plan

- **Phase 0 (Core PR):** Land the additive `OverlayInteractionZone`,
  `OverlayPointerEvent`, and `getInteractionZones` / `isInteractive` hooks in
  `ui/src/public/track.ts` and dispatch wiring in
  `overlay_interactions.ts` / `track_tree_view.ts` under
  `ui/src/core_plugins/dev.perfetto.Timeline/`.
- **Phase 1 (Initial Plugin):** Implement `dev.perfetto.TimelineAnnotations`
  behind an opt-in flag in `#!/plugins`. Includes drawing tools, data anchoring,
  Annotations slice track, and permalink serialization via `registerStorage`.
- **Phase 2 (Sharing & Transports):** Implement local storage auto-save,
  sidecar JSON export/import commands, and `postMessage` injection.
- **Phase 3 (Trace Bundling):** Integrate with RFC-0030 trace packaging once
  RFC-0030 lands.
- **Testing strategy:**
  - Unit tests for `anchor.ts`: verify coordinate resolution across track
    movement, collapsed parent projection, and missing-track degradation.
  - Unit tests for `schema.ts`: verify Zod validation, Ramer-Douglas-Peucker
    point reduction, and backward-compatible schema migrations.
  - Unit tests for `geometry.ts`: verify quadratic Bezier curvature evaluation
    and tangent arrowhead orientation.
  - UI regression tests: screenshot testing of canvas overlay rendering under
    light and dark themes.

## Alternatives considered

### Interaction architecture alternatives

We evaluated four architectural approaches for overlay interaction:

#### 1. Raw pointer events on Overlay (isInteractive only)

- **Design:** Add imperative pointer hooks (`onPointerDown`, `onPointerMove`,
  `onPointerUp`) to `Overlay` guarded by a boolean `isInteractive()` predicate.
- **Evaluation:**
  - *Pros:* Simple API signature.
  - *Cons:* Forces a coarse full-viewport capture zone (`timelineRect`). In
    `select` or navigation mode, this swallows all pointer clicks and drags
    across the entire canvas, breaking slice selection, area selection, and
    shift-drag panning on empty timeline space. Furthermore,
    `ZonedInteractionHandler` does not fire `onPointerMove` during unpressed
    mouse hover, preventing per-shape hover highlights and per-handle cursors
    (`move`, `nwse-resize`, `grab`). It also fails to account for the dual
    `TrackTreeView` instances (`pinnedTracksNode` vs `tracks`), which have
    separate canvases and clipping bounds.
  - *Verdict:* Rejected in favor of declarative hit-zones.

#### 2. Declarative OverlayInteractionZone integration (Chosen approach)

- **Design:** Extend `Overlay` with `getInteractionZones(ctx)` alongside
  `isInteractive?()`, integrating directly into `TrackTreeView`'s existing
  `ZonedInteractionHandler`.
- **Evaluation:**
  - *Pros:* Combines full-viewport capture for creation tools (`crosshair`) with
    fine-grained localized hit-zones for selection and manipulation (`move`,
    `grab`, resize). Empty canvas space falls through to native timeline pan,
    zoom, and slice selection. Invoking `render()` before `updateInteractions()`
    in `TrackTreeView.drawCanvas` guarantees fresh, pixel-accurate hit-test
    geometries per `rootNode` on every frame across both pinned and scrollable
    canvases.
  - *Cons:* Requires a slightly richer interface on `Overlay`.
  - *Verdict:* Chosen.

#### 3. Registering a TimelineInteractionProvider on trace.timeline

- **Design:** Introduce a new top-level registry
  `trace.timeline.registerInteractionProvider(...)` decoupled from
  `trace.tracks.registerOverlay(...)`.
- **Evaluation:**
  - *Pros:* Completely decouples interaction concerns from 2D canvas rendering.
  - *Cons:* Bifurcates state management: visual rendering would live on
    `trace.tracks` while interaction would live on `trace.timeline`. This
    requires synchronizing projected geometries, track bounds, and zoom state
    across two distinct plugin registration points. It also bypasses the track
    hierarchy context (`rootNode`, `tracks`) readily available inside
    `TrackTreeView`.
  - *Verdict:* Rejected due to unnecessary architectural complexity and
    redundant layout computation.

#### 4. A viewport-level DOM/SVG layer inside VirtualOverlayCanvas

- **Design:** Rather than 2D canvas drawing and hit-testing, mount an SVG or
  HTML DOM container over the timeline tracks for shapes and handles.
- **Evaluation:**
  - *Pros:* Native browser hit-testing, CSS hover cursors, and DOM event
    bubbling.
  - *Cons:* Severe performance penalties. A complex trace with dozens of shapes,
    control points, Bezier curves, and labels instantiates hundreds of DOM/SVG
    nodes. During 60/120 Hz panning and zooming, synchronizing DOM transforms or
    SVG coordinates triggers severe browser layout thrashing and dropped
    frames. Canvas rendering guarantees synchronized, zero-DOM-overhead painting
    in the same render frame as trace tracks.
  - *Verdict:* Rejected.

### System-level alternatives

#### Option 1: Global window listeners and injected DOM (no core change)

- **Pros:** Requires zero changes to Perfetto core.
- **Cons:** Violates the UI plugin policy
  (`docs/contributing/ui-plugins.md:25-27`); intercepts clicks intended for
  other panels; coordinates desynchronize when the track list scrolls; risks
  leaking DOM nodes and listeners across trace switches.

#### Option 2: Pure annotation track without canvas overlay

- **Pros:** Zero core changes; natural integration with timeline layout; robust
  degradation.
- **Cons:** Cannot draw cross-track bounding boxes, ellipses, directional arrows
  between distant tracks, or freehand sketches. Relegates visual annotation to
  simple time bands.
- **Verdict:** Adopted as a companion layer (the Annotations track) rather than
  a complete replacement.

#### Option 3: Extend the core Notes system

- **Pros:** Unifies notes and annotations in a single concept.
- **Cons:** Bloats core API surface with complex drawing primitives;
  `NoteManager` at HEAD lacks public `changeNote`/`removeNote` methods and
  arbitrary metadata; couples core timeline rendering to shape drawing.

#### Option 4: Store annotations in Trace Processor / trace protos

- **Pros:** Annotations are self-contained within the trace file.
- **Cons:** Mutates immutable raw trace files; requires Trace Processor C++
  changes and proto releases; violates RFC-0030 guidance; cannot support
  read-only traces or live in-browser analysis.

#### Option 5: Static image / PNG screenshot export only

- **Pros:** Familiar format for chat and documentation.
- **Cons:** Destroys trace interactivity, deep-linking, and queryability. Does
  not solve collaborative analysis within Perfetto.

## Open questions

1. **Plugin ownership and ID:** Should the plugin live under
   `dev.perfetto.TimelineAnnotations` (indicating core team ownership) or an
   external namespace (`com.google.*` or `com.android.*`)?
2. **Timeline interaction registry generalization:** Should
   `OverlayInteractionZone` remain tied to `Overlay`, or eventually be promoted
   to a standalone interaction zone API if other plugins need non-visual gesture
   zones? (Current consensus: keeping it on `Overlay` aligns render geometry
   directly with hit testing).
3. **Fuzzy name matching in core Area selection:** Should core `Area`
   serialization carry fallback `trackNames` natively, or should this remain a
   plugin-specific extension?
4. **Permalink storage limits:** Cloud Storage permalinks accommodate modest
   JSON payloads. If users create hundreds of detailed freeform sketches, should
   the plugin enforce a maximum total serialized byte cap?
5. **Dashboard integration:** How should embedding dashboards configure
   annotation permissions (e.g. read-only mode vs full editing)?
6. **Accessibility:** How can screen readers best announce canvas annotations?
   (The Annotations slice track provides an accessible DOM representation).

## References

- Implementation: branch `timeline-annotations` on the author's fork (core
  change + plugin)
- GitHub Issue: [Issue #6626](https://github.com/google/perfetto/issues/6626)
- Perfetto UI Plugin Guidelines: `docs/contributing/ui-plugins.md`
- State Serialization: `ui/src/core/state_serialization.ts`
- Overlay Interface: `ui/src/public/track.ts`
- ZonedInteractionHandler: `ui/src/base/zoned_interaction_handler.ts`
- Area Selection Interface: `ui/src/public/selection.ts`
- Workspace Hierarchy: `ui/src/public/workspace.ts`
- RFC-0030 (Trace Metadata and Bundling):
  `0030-trace-bundled-extensions.md` on the `rfcs` branch
