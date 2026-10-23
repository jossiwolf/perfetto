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

import type {Point2D, Size2D} from '../../base/geom';
import type {TimeScale} from '../../base/time_scale';
import type {CanvasColors} from '../../public/canvas_colors';
import type {
  Overlay,
  OverlayInteractionContext,
  OverlayInteractionZone,
  OverlayPointerEvent,
  TrackBounds,
} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import {type Annotation, type AnnotationStore, normalizeColor} from './model';
import {
  type ResolvedTrackY,
  resolveArea,
  resolvePoint,
  resolveTrackY,
} from './anchor';
import {
  bboxOf,
  computeQuadraticControlPoint,
  evaluateQuadraticBezier,
  quadraticBezierEndAngle,
  type RectBounds,
  sampleQuadraticBezier,
} from './geometry';
import type {AnnotationGeometry, ToolController} from './tools';

export type AnchorStatus = 'exact' | 'degraded' | 'unanchored';

export interface RenderedAnnotationInfo {
  readonly status: AnchorStatus;
  readonly missing: ReadonlyArray<string>;
}

export interface AnnotationsOverlayOptions {
  readonly trackExists?: (uri: string) => boolean;
}

export function colorWithAlpha(color: string, alpha: number): string {
  const normalized = normalizeColor(color);
  if (normalized.startsWith('#')) {
    let hexString = normalized.slice(1);
    if (hexString.length === 3) {
      hexString =
        hexString[0] +
        hexString[0] +
        hexString[1] +
        hexString[1] +
        hexString[2] +
        hexString[2];
    }
    if (hexString.length >= 6) {
      const redVal = parseInt(hexString.substring(0, 2), 16);
      const greenVal = parseInt(hexString.substring(2, 4), 16);
      const blueVal = parseInt(hexString.substring(4, 6), 16);
      if (
        !Number.isNaN(redVal) &&
        !Number.isNaN(greenVal) &&
        !Number.isNaN(blueVal)
      ) {
        return `rgba(${redVal}, ${greenVal}, ${blueVal}, ${alpha})`;
      }
    }
  }
  return color;
}

export function getAnnotationFillStyle(
  annotation: Annotation,
  defaultAlpha: number,
): string {
  if (annotation.fillColor === 'transparent') {
    return 'rgba(0, 0, 0, 0)';
  }
  const baseFill = annotation.fillColor ?? annotation.color;
  const alpha =
    annotation.fillOpacity ??
    (annotation.fillColor !== undefined
      ? Math.min(0.45, defaultAlpha * 1.8)
      : defaultAlpha);
  return colorWithAlpha(baseFill, alpha);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, Math.max(0, maxLength - 3)) + '...';
}

function nearestPointOnBbox(bbox: RectBounds, toward: Point2D): Point2D {
  return {
    x: Math.max(bbox.left, Math.min(bbox.right, toward.x)),
    y: Math.max(bbox.top, Math.min(bbox.bottom, toward.y)),
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  posX: number,
  posY: number,
  width: number,
  height: number,
  radius: number,
): void {
  const cornerRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(posX + cornerRadius, posY);
  ctx.lineTo(posX + width - cornerRadius, posY);
  ctx.arcTo(
    posX + width,
    posY,
    posX + width,
    posY + cornerRadius,
    cornerRadius,
  );
  ctx.lineTo(posX + width, posY + height - cornerRadius);
  ctx.arcTo(
    posX + width,
    posY + height,
    posX + width - cornerRadius,
    posY + height,
    cornerRadius,
  );
  ctx.lineTo(posX + cornerRadius, posY + height);
  ctx.arcTo(
    posX,
    posY + height,
    posX,
    posY + height - cornerRadius,
    cornerRadius,
  );
  ctx.lineTo(posX, posY + cornerRadius);
  ctx.arcTo(posX, posY, posX + cornerRadius, posY, cornerRadius);
  ctx.closePath();
}

export function drawSmoothPolyline(
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<Point2D>,
): void {
  if (points.length === 0) {
    return;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2 || typeof ctx.quadraticCurveTo !== 'function') {
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    return;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

function renderTitlePill(
  ctx: CanvasRenderingContext2D,
  title: string,
  color: string,
  themeBg: string,
  target:
    | {readonly kind: 'rect-or-ellipse'; readonly bbox: RectBounds}
    | {readonly kind: 'path'; readonly point: Point2D}
    | {readonly kind: 'arrow'; readonly midpoint: Point2D},
): void {
  const titleText = truncateText(title.trim(), 36);
  ctx.font = '600 11px sans-serif';
  const textWidth = ctx.measureText(titleText).width;
  const pillW = textWidth + 12;
  const pillH = 18;
  let pillX: number;
  let pillY: number;

  if (target.kind === 'rect-or-ellipse') {
    pillX = target.bbox.left + 4;
    pillY = target.bbox.top >= 22 ? target.bbox.top - 20 : target.bbox.top + 4;
  } else if (target.kind === 'path') {
    pillX = target.point.x + 4;
    pillY = Math.max(2, target.point.y - 20);
  } else {
    pillX = target.midpoint.x - pillW / 2;
    pillY = Math.max(2, target.midpoint.y - pillH - 6);
  }

  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 4);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = themeBg;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, pillX + 6, pillY + pillH / 2);
}

export class AnnotationsOverlay implements Overlay {
  private readonly store: AnnotationStore;
  private readonly tools: ToolController;
  private readonly trackExists: (uri: string) => boolean;
  private readonly geometriesByRoot = new WeakMap<
    TrackNode,
    Map<string, AnnotationGeometry>
  >();
  private readonly mergedGeometries = new Map<string, AnnotationGeometry>();
  private renderedAnnotationInfo = new Map<string, RenderedAnnotationInfo>();
  private readonly creationAnims = new Map<
    string,
    {fromRect: RectBounds; startMs: number}
  >();
  private readonly visibilityAnims = new Map<
    string,
    {fromAlpha: number; toAlpha: number; startMs: number}
  >();
  private readonly lastHiddenState = new Map<string, boolean>();
  private readonly lastKnownAnnotations = new Map<
    string,
    {annotation: Annotation; geometry: AnnotationGeometry}
  >();
  private readonly deleteAnims = new Map<
    string,
    {annotation: Annotation; geometry: AnnotationGeometry; startMs: number}
  >();

  constructor(
    store: AnnotationStore,
    tools: ToolController,
    options?: AnnotationsOverlayOptions,
  ) {
    this.store = store;
    this.tools = tools;
    this.trackExists = options?.trackExists ?? (() => false);
    this.tools.setGeometryProvider((id?: string, targetRoot?: TrackNode) => {
      const map =
        (targetRoot && this.geometriesByRoot.get(targetRoot)) ??
        this.mergedGeometries;
      return id ? map.get(id) : map;
    });
  }

  getCursor(): string | undefined {
    return this.tools.hoverCursor;
  }

  isInteractive(): boolean {
    return this.tools.isInteractive() && this.tools.tool !== 'select';
  }

  getInteractionZones(
    ctx: OverlayInteractionContext,
  ): ReadonlyArray<OverlayInteractionZone> {
    const rootGeoms = this.geometriesByRoot.get(ctx.rootNode);
    if (!rootGeoms) {
      return [];
    }
    if (this.tools.drawingMode && this.tools.tool !== 'select') {
      return [];
    }

    const zones: OverlayInteractionZone[] = [];
    for (const geom of rootGeoms.values()) {
      if (this.store.isHidden(geom.id)) {
        continue;
      }
      if (geom.kind === 'arrow' && geom.curveMidpoint !== undefined) {
        zones.push({
          id: `arrow-curve:${geom.id}`,
          area: {
            x: geom.curveMidpoint.x - 8,
            y: geom.curveMidpoint.y - 8,
            width: 16,
            height: 16,
          },
          cursor: 'grab',
        });
      }
      const width = Math.max(8, geom.bbox.width);
      const height = Math.max(8, geom.bbox.height);
      zones.push({
        id: `annotation:${geom.id}`,
        area: {
          x: geom.bbox.left,
          y: geom.bbox.top,
          width,
          height,
        },
        cursor: 'move',
      });
    }
    return zones;
  }

  onPointerDown(event: OverlayPointerEvent): void {
    this.tools.onPointerDown(event);
  }

  onPointerMove(event: OverlayPointerEvent): void {
    this.tools.onPointerMove(event);
  }

  onPointerUp(event: OverlayPointerEvent): void {
    this.tools.onPointerUp(event);
  }

  get lastRender(): ReadonlyMap<string, RenderedAnnotationInfo> {
    return this.renderedAnnotationInfo;
  }

  render(
    ctx: CanvasRenderingContext2D,
    timescale: TimeScale,
    size: Size2D,
    tracks: ReadonlyArray<TrackBounds>,
    theme: CanvasColors,
    rootNode: TrackNode,
  ): void {
    ctx.save();
    try {
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      let hasActiveAnims = false;

      // Check for deleted annotations from last known rendered set
      for (const [id, item] of this.lastKnownAnnotations.entries()) {
        if (this.store.get(id) === undefined) {
          this.deleteAnims.set(id, {
            annotation: item.annotation,
            geometry: item.geometry,
            startMs: now,
          });
          this.lastKnownAnnotations.delete(id);
          this.creationAnims.delete(id);
          this.visibilityAnims.delete(id);
          this.lastHiddenState.delete(id);
        }
      }

      // Check visibility state changes
      const annotationsList = this.store.list();
      for (const annotation of annotationsList) {
        const isCurrentlyHidden = this.store.isHidden(annotation.id);
        const wasHidden = this.lastHiddenState.get(annotation.id);
        if (wasHidden !== undefined && wasHidden !== isCurrentlyHidden) {
          this.visibilityAnims.set(annotation.id, {
            fromAlpha: wasHidden ? 0 : 1,
            toAlpha: isCurrentlyHidden ? 0 : 1,
            startMs: now,
          });
        }
        this.lastHiddenState.set(annotation.id, isCurrentlyHidden);
      }

      const clipLeft = timescale.pxBounds.left;
      ctx.beginPath();
      ctx.rect(clipLeft, 0, Math.max(0, size.width - clipLeft), size.height);
      ctx.clip();

      const trackYCache = new Map<string, ResolvedTrackY | undefined>();
      const memoResolveTrackY = (
        trackUri: string,
        trackName?: string,
      ): ResolvedTrackY | undefined => {
        const cacheKey = `${trackUri}\0${trackName ?? ''}`;
        if (trackYCache.has(cacheKey)) {
          return trackYCache.get(cacheKey);
        }
        const res = resolveTrackY(trackUri, trackName, tracks, rootNode);
        trackYCache.set(cacheKey, res);
        return res;
      };

      const nextRenderedInfo = new Map<string, RenderedAnnotationInfo>();
      const geometriesMap = new Map<string, AnnotationGeometry>();

      // Pass 1: Resolve geometry and compute status for all visible non-hidden annotations
      for (const annotation of annotationsList) {
        const isCurrentlyHidden = this.store.isHidden(annotation.id);
        let animAlpha = 1;
        const visAnim = this.visibilityAnims.get(annotation.id);
        if (visAnim !== undefined) {
          const elapsed = now - visAnim.startMs;
          if (elapsed < 180) {
            hasActiveAnims = true;
            const t = Math.max(0, Math.min(1, elapsed / 180));
            const ease = 1 - Math.pow(1 - t, 3);
            animAlpha = visAnim.toAlpha === 0 ? 1 - ease : ease;
          } else {
            this.visibilityAnims.delete(annotation.id);
            if (visAnim.toAlpha === 0) {
              animAlpha = 0;
            }
          }
        } else if (isCurrentlyHidden) {
          animAlpha = 0;
        }

        if (animAlpha <= 0) {
          continue;
        }

        if (annotation.kind === 'rect' || annotation.kind === 'ellipse') {
          const fromRect = this.tools.consumeCreatedRect?.(annotation.id);
          if (fromRect !== undefined) {
            this.creationAnims.set(annotation.id, {
              fromRect,
              startMs: now,
            });
          }
        }

        switch (annotation.kind) {
          case 'rect':
          case 'ellipse': {
            const startPx = timescale.timeToPx(annotation.anchor.start);
            const endPx = timescale.timeToPx(annotation.anchor.end);
            const leftPx = Math.min(startPx, endPx);
            const rightPx = Math.max(startPx, endPx);
            const anyExists = annotation.anchor.trackUris.some((uri) =>
              this.trackExists(uri),
            );
            const area = resolveArea(
              annotation.anchor,
              tracks,
              rootNode,
              memoResolveTrackY,
            );

            if (area === undefined) {
              if (anyExists) {
                if (this.renderedAnnotationInfo.has(annotation.id)) {
                  nextRenderedInfo.set(
                    annotation.id,
                    this.renderedAnnotationInfo.get(annotation.id)!,
                  );
                }
                continue;
              }
              nextRenderedInfo.set(annotation.id, {
                status: 'unanchored',
                missing: [...annotation.anchor.trackUris],
              });
              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: annotation.kind,
                bbox: {
                  left: leftPx,
                  top: 0,
                  right: rightPx,
                  bottom: size.height,
                  width: rightPx - leftPx,
                  height: size.height,
                },
              });
            } else {
              let hasDegradedTrack = false;
              for (
                let index = 0;
                index < annotation.anchor.trackUris.length;
                index += 1
              ) {
                const trackUri = annotation.anchor.trackUris[index];
                const trackName = annotation.anchor.trackNames?.[index];
                const trackRes = memoResolveTrackY(trackUri, trackName);
                if (
                  !trackRes ||
                  trackRes.status === 'ancestor' ||
                  trackRes.status === 'fuzzy'
                ) {
                  hasDegradedTrack = true;
                  break;
                }
              }

              const status: AnchorStatus =
                hasDegradedTrack || area.missing.length > 0
                  ? 'degraded'
                  : 'exact';
              nextRenderedInfo.set(annotation.id, {
                status,
                missing: area.missing,
              });

              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: annotation.kind,
                bbox: {
                  left: leftPx,
                  top: area.top,
                  right: rightPx,
                  bottom: area.bottom,
                  width: rightPx - leftPx,
                  height: area.bottom - area.top,
                },
              });
            }
            break;
          }
          case 'label': {
            const posX = timescale.timeToPx(annotation.position.ts);
            const exists = this.trackExists(annotation.position.trackUri);
            const pointRes = resolvePoint(
              annotation.position,
              tracks,
              rootNode,
              memoResolveTrackY,
            );

            const labelText = truncateText(
              annotation.title ?? annotation.text,
              50,
            );
            const fontSize = annotation.fontSize ?? 12;
            const fontFamily = annotation.fontFamily ?? 'sans-serif';
            ctx.font = `${fontSize}px ${fontFamily}`;
            const textMetrics = ctx.measureText(labelText);
            const padX = Math.max(6, Math.round(fontSize * 0.5));
            const labelHeight = Math.max(18, Math.round(fontSize * 1.5));
            const labelWidth = textMetrics.width + padX * 2;

            if (pointRes === undefined) {
              if (exists) {
                if (this.renderedAnnotationInfo.has(annotation.id)) {
                  nextRenderedInfo.set(
                    annotation.id,
                    this.renderedAnnotationInfo.get(annotation.id)!,
                  );
                }
                continue;
              }
              nextRenderedInfo.set(annotation.id, {
                status: 'unanchored',
                missing: [annotation.position.trackUri],
              });
              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: 'label',
                bbox: {
                  left: posX,
                  top: 0,
                  right: posX + labelWidth,
                  bottom: labelHeight,
                  width: labelWidth,
                  height: labelHeight,
                },
              });
            } else {
              const status: AnchorStatus =
                pointRes.status === 'exact' ? 'exact' : 'degraded';
              nextRenderedInfo.set(annotation.id, {
                status,
                missing: [],
              });

              geometriesMap.set(annotation.id, {
                id: annotation.id,
                kind: 'label',
                bbox: {
                  left: posX,
                  top: pointRes.y - labelHeight / 2,
                  right: posX + labelWidth,
                  bottom: pointRes.y + labelHeight / 2,
                  width: labelWidth,
                  height: labelHeight,
                },
              });
            }
            break;
          }
          case 'path': {
            const polyline: Point2D[] = [];
            const missingUris: string[] = [];
            let hasDegraded = false;

            for (const pt of annotation.points) {
              const ptX = timescale.timeToPx(pt.ts);
              const pointRes = resolvePoint(
                pt,
                tracks,
                rootNode,
                memoResolveTrackY,
              );
              if (pointRes === undefined) {
                missingUris.push(pt.trackUri);
              } else {
                polyline.push({x: ptX, y: pointRes.y});
                if (pointRes.status !== 'exact') {
                  hasDegraded = true;
                }
              }
            }

            if (polyline.length === 0) {
              const anyExists = annotation.points.some((pt) =>
                this.trackExists(pt.trackUri),
              );
              if (anyExists) {
                if (this.renderedAnnotationInfo.has(annotation.id)) {
                  nextRenderedInfo.set(
                    annotation.id,
                    this.renderedAnnotationInfo.get(annotation.id)!,
                  );
                }
                continue;
              }
            }

            let status: AnchorStatus = 'exact';
            if (polyline.length === 0) {
              status = 'unanchored';
            } else if (hasDegraded || missingUris.length > 0) {
              status = 'degraded';
            }

            nextRenderedInfo.set(annotation.id, {
              status,
              missing: Array.from(new Set(missingUris)),
            });

            geometriesMap.set(annotation.id, {
              id: annotation.id,
              kind: 'path',
              bbox: bboxOf(polyline),
              polyline,
            });
            break;
          }
          case 'arrow': {
            break;
          }
        }
      }

      // Pass 2: Draw non-arrow shapes
      for (const annotation of annotationsList) {
        if (annotation.kind === 'arrow') {
          continue;
        }

        const geometry = geometriesMap.get(annotation.id);
        const info = nextRenderedInfo.get(annotation.id);
        if (!geometry || !info) {
          continue;
        }

        let animAlpha = 1;
        const visAnim = this.visibilityAnims.get(annotation.id);
        if (visAnim !== undefined) {
          const elapsed = now - visAnim.startMs;
          if (elapsed < 180) {
            const t = Math.max(0, Math.min(1, elapsed / 180));
            const ease = 1 - Math.pow(1 - t, 3);
            animAlpha = visAnim.toAlpha === 0 ? 1 - ease : ease;
          }
        } else if (this.store.isHidden(annotation.id)) {
          animAlpha = 0;
        }

        if (animAlpha <= 0) {
          continue;
        }

        this.lastKnownAnnotations.set(annotation.id, {annotation, geometry});

        if (geometry.bbox.right < 0 || geometry.bbox.left > size.width) {
          continue;
        }

        const isSelected = this.store.selectedId === annotation.id;

        ctx.save();
        try {
          if (animAlpha < 1) {
            ctx.globalAlpha = animAlpha;
          }

          if (info.status === 'unanchored') {
            ctx.fillStyle = getAnnotationFillStyle(annotation, 0.12);
            ctx.fillRect(
              geometry.bbox.left,
              0,
              Math.max(1, geometry.bbox.width),
              size.height,
            );
            ctx.strokeStyle = colorWithAlpha(annotation.color, 0.5);
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(
              geometry.bbox.left,
              0,
              Math.max(1, geometry.bbox.width),
              size.height,
            );
            ctx.setLineDash([]);

            const displayTitle = truncateText(
              annotation.title ?? annotation.id,
              24,
            );
            ctx.font = '10px sans-serif';
            ctx.fillStyle = theme.COLOR_TEXT_MUTED;
            ctx.fillText(displayTitle, geometry.bbox.left + 4, 16);
            continue;
          }

          let renderBbox = geometry.bbox;
          const creationAnim = this.creationAnims.get(annotation.id);
          if (creationAnim !== undefined) {
            const elapsed = now - creationAnim.startMs;
            if (elapsed < 220) {
              hasActiveAnims = true;
              const t = Math.max(0, Math.min(1, elapsed / 220));
              const ease = 1 - Math.pow(1 - t, 3);
              const left =
                creationAnim.fromRect.left +
                (geometry.bbox.left - creationAnim.fromRect.left) * ease;
              const top =
                creationAnim.fromRect.top +
                (geometry.bbox.top - creationAnim.fromRect.top) * ease;
              const right =
                creationAnim.fromRect.right +
                (geometry.bbox.right - creationAnim.fromRect.right) * ease;
              const bottom =
                creationAnim.fromRect.bottom +
                (geometry.bbox.bottom - creationAnim.fromRect.bottom) * ease;
              renderBbox = {
                left,
                top,
                right,
                bottom,
                width: right - left,
                height: bottom - top,
              };
            } else {
              this.creationAnims.delete(annotation.id);
            }
          }

          switch (annotation.kind) {
            case 'rect': {
              ctx.fillStyle = getAnnotationFillStyle(
                annotation,
                isSelected ? 0.26 : 0.2,
              );
              ctx.fillRect(
                renderBbox.left,
                renderBbox.top,
                renderBbox.width,
                renderBbox.height,
              );

              // Contrast halo / casing
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.strokeRect(
                renderBbox.left,
                renderBbox.top,
                renderBbox.width,
                renderBbox.height,
              );

              // Primary stroke
              ctx.lineWidth = isSelected ? 3 : 2.5;
              ctx.strokeStyle = annotation.color;
              if (info.status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.strokeRect(
                renderBbox.left,
                renderBbox.top,
                renderBbox.width,
                renderBbox.height,
              );
              ctx.setLineDash([]);

              if (
                annotation.title !== undefined &&
                annotation.title.trim().length > 0
              ) {
                renderTitlePill(
                  ctx,
                  annotation.title,
                  annotation.color,
                  theme.COLOR_BACKGROUND,
                  {kind: 'rect-or-ellipse', bbox: renderBbox},
                );
              }
              break;
            }
            case 'ellipse': {
              ctx.beginPath();
              const centerX = renderBbox.left + renderBbox.width / 2;
              const centerY = renderBbox.top + renderBbox.height / 2;
              const radiusX = Math.max(0, renderBbox.width / 2);
              const radiusY = Math.max(0, renderBbox.height / 2);
              ctx.ellipse(
                centerX,
                centerY,
                radiusX,
                radiusY,
                0,
                0,
                2 * Math.PI,
              );
              ctx.fillStyle = getAnnotationFillStyle(
                annotation,
                isSelected ? 0.26 : 0.2,
              );
              ctx.fill();

              // Contrast halo / casing
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.stroke();

              // Primary stroke
              ctx.lineWidth = isSelected ? 3 : 2.5;
              ctx.strokeStyle = annotation.color;
              if (info.status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.stroke();
              ctx.setLineDash([]);

              if (
                annotation.title !== undefined &&
                annotation.title.trim().length > 0
              ) {
                renderTitlePill(
                  ctx,
                  annotation.title,
                  annotation.color,
                  theme.COLOR_BACKGROUND,
                  {kind: 'rect-or-ellipse', bbox: renderBbox},
                );
              }
              break;
            }
            case 'path': {
              if (geometry.polyline && geometry.polyline.length > 1) {
                const hasCustomFill =
                  annotation.fillColor !== undefined &&
                  annotation.fillColor !== 'transparent';

                if (hasCustomFill) {
                  ctx.beginPath();
                  drawSmoothPolyline(ctx, geometry.polyline);
                  ctx.lineWidth = 6;
                  ctx.strokeStyle = getAnnotationFillStyle(annotation, 0.22);
                  ctx.stroke();
                }

                // Contrast halo / casing
                ctx.beginPath();
                drawSmoothPolyline(ctx, geometry.polyline);
                ctx.lineWidth = isSelected ? 6 : 5;
                ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
                ctx.setLineDash([]);
                ctx.stroke();

                // Primary stroke
                ctx.beginPath();
                drawSmoothPolyline(ctx, geometry.polyline);
                ctx.lineWidth = isSelected ? 3 : 2.5;
                ctx.strokeStyle = annotation.color;
                if (info.status === 'degraded') {
                  ctx.setLineDash([4, 4]);
                } else {
                  ctx.setLineDash([]);
                }
                ctx.stroke();
                ctx.setLineDash([]);

                if (
                  annotation.title !== undefined &&
                  annotation.title.trim().length > 0 &&
                  geometry.polyline.length > 0
                ) {
                  renderTitlePill(
                    ctx,
                    annotation.title,
                    annotation.color,
                    theme.COLOR_BACKGROUND,
                    {kind: 'path', point: geometry.polyline[0]},
                  );
                }
              }
              break;
            }
            case 'label': {
              const labelText = truncateText(
                annotation.title ?? annotation.text,
                50,
              );
              const fontSize = annotation.fontSize ?? 12;
              const fontFamily = annotation.fontFamily ?? 'sans-serif';
              ctx.font = `${fontSize}px ${fontFamily}`;
              const padX = Math.max(6, Math.round(fontSize * 0.5));

              drawRoundedRect(
                ctx,
                geometry.bbox.left,
                geometry.bbox.top,
                geometry.bbox.width,
                geometry.bbox.height,
                4,
              );

              if (annotation.backgroundColor === 'transparent') {
                // transparent: do not fill
              } else if (annotation.backgroundColor !== undefined) {
                ctx.fillStyle = colorWithAlpha(
                  annotation.backgroundColor,
                  annotation.fillOpacity ?? 0.85,
                );
                ctx.fill();
              } else {
                ctx.fillStyle = getAnnotationFillStyle(annotation, 0.12);
                ctx.fill();
              }

              ctx.lineWidth = 1;
              ctx.strokeStyle = annotation.color;
              ctx.stroke();

              ctx.fillStyle = annotation.textColor ?? theme.COLOR_TEXT;
              ctx.textBaseline = 'middle';
              ctx.fillText(
                labelText,
                geometry.bbox.left + padX,
                geometry.bbox.top + geometry.bbox.height / 2,
              );
              break;
            }
          }
        } finally {
          ctx.restore();
        }
      }

      // Pass 3: Resolve and draw arrows
      for (const annotation of annotationsList) {
        if (annotation.kind !== 'arrow') {
          continue;
        }

        let animAlpha = 1;
        const visAnim = this.visibilityAnims.get(annotation.id);
        if (visAnim !== undefined) {
          const elapsed = now - visAnim.startMs;
          if (elapsed < 180) {
            const t = Math.max(0, Math.min(1, elapsed / 180));
            const ease = 1 - Math.pow(1 - t, 3);
            animAlpha = visAnim.toAlpha === 0 ? 1 - ease : ease;
          }
        } else if (this.store.isHidden(annotation.id)) {
          animAlpha = 0;
        }

        if (animAlpha <= 0) {
          continue;
        }

        let startPoint: Point2D | undefined;
        let endPoint: Point2D | undefined;
        const missingUris: string[] = [];
        let hasDegraded = false;

        // Resolve endpoint 'to'
        if (annotation.to.kind === 'point') {
          const toPointRes = resolvePoint(
            annotation.to.point,
            tracks,
            rootNode,
            memoResolveTrackY,
          );
          if (toPointRes === undefined) {
            missingUris.push(annotation.to.point.trackUri);
          } else {
            endPoint = {
              x: timescale.timeToPx(annotation.to.point.ts),
              y: toPointRes.y,
            };
            if (toPointRes.status !== 'exact') {
              hasDegraded = true;
            }
          }
        }

        // Resolve endpoint 'from'
        if (annotation.from.kind === 'point') {
          const fromPointRes = resolvePoint(
            annotation.from.point,
            tracks,
            rootNode,
            memoResolveTrackY,
          );
          if (fromPointRes === undefined) {
            missingUris.push(annotation.from.point.trackUri);
          } else {
            startPoint = {
              x: timescale.timeToPx(annotation.from.point.ts),
              y: fromPointRes.y,
            };
            if (fromPointRes.status !== 'exact') {
              hasDegraded = true;
            }
          }
        } else {
          const targetGeomA = geometriesMap.get(annotation.from.id);
          if (targetGeomA !== undefined) {
            if (endPoint !== undefined) {
              startPoint = nearestPointOnBbox(targetGeomA.bbox, endPoint);
            } else if (annotation.to.kind === 'annotation') {
              const targetGeomB = geometriesMap.get(annotation.to.id);
              if (targetGeomB !== undefined) {
                const centerB: Point2D = {
                  x: (targetGeomB.bbox.left + targetGeomB.bbox.right) / 2,
                  y: (targetGeomB.bbox.top + targetGeomB.bbox.bottom) / 2,
                };
                startPoint = nearestPointOnBbox(targetGeomA.bbox, centerB);
              }
            }
          } else {
            missingUris.push(annotation.from.id);
          }
        }

        if (annotation.to.kind === 'annotation') {
          const targetGeomB = geometriesMap.get(annotation.to.id);
          if (targetGeomB !== undefined) {
            if (startPoint !== undefined) {
              endPoint = nearestPointOnBbox(targetGeomB.bbox, startPoint);
            }
          } else {
            missingUris.push(annotation.to.id);
          }
        }

        if (startPoint === undefined || endPoint === undefined) {
          const fromExists =
            annotation.from.kind === 'point'
              ? this.trackExists(annotation.from.point.trackUri)
              : this.store.get(annotation.from.id) !== undefined;
          const toExists =
            annotation.to.kind === 'point'
              ? this.trackExists(annotation.to.point.trackUri)
              : this.store.get(annotation.to.id) !== undefined;

          if (fromExists && toExists) {
            if (this.renderedAnnotationInfo.has(annotation.id)) {
              nextRenderedInfo.set(
                annotation.id,
                this.renderedAnnotationInfo.get(annotation.id)!,
              );
            }
            continue;
          }
        }

        let status: AnchorStatus = 'exact';
        if (startPoint === undefined || endPoint === undefined) {
          status = 'unanchored';
        } else if (hasDegraded || missingUris.length > 0) {
          status = 'degraded';
        }

        nextRenderedInfo.set(annotation.id, {
          status,
          missing: missingUris,
        });

        if (startPoint !== undefined && endPoint !== undefined) {
          const curvature =
            annotation.controlOffset?.normalPx ?? annotation.curvature ?? 0;
          const alongFrac = annotation.controlOffset?.alongFrac ?? 0.5;

          let curveMidpoint: Point2D;
          let controlPoint: Point2D | undefined;
          let sampledPolyline: Point2D[] | undefined;
          let arrowBbox: RectBounds;
          let arrowAngle: number;

          if (Math.abs(curvature) > 0.5) {
            controlPoint = computeQuadraticControlPoint(
              startPoint,
              endPoint,
              curvature,
              alongFrac,
            );
            curveMidpoint = evaluateQuadraticBezier(
              startPoint,
              controlPoint,
              endPoint,
              0.5,
            );
            sampledPolyline = sampleQuadraticBezier(
              startPoint,
              controlPoint,
              endPoint,
              16,
            );
            arrowBbox = bboxOf(sampledPolyline);
            arrowAngle = quadraticBezierEndAngle(
              startPoint,
              controlPoint,
              endPoint,
            );
          } else {
            curveMidpoint = {
              x: (startPoint.x + endPoint.x) / 2,
              y: (startPoint.y + endPoint.y) / 2,
            };
            arrowBbox = bboxOf([startPoint, endPoint]);
            arrowAngle = Math.atan2(
              endPoint.y - startPoint.y,
              endPoint.x - startPoint.x,
            );
          }

          const isSelected = this.store.selectedId === annotation.id;

          const arrowGeometry: AnnotationGeometry = {
            id: annotation.id,
            kind: 'arrow',
            bbox: arrowBbox,
            start: startPoint,
            end: endPoint,
            ...(controlPoint !== undefined ? {control: controlPoint} : {}),
            curveMidpoint,
            ...(sampledPolyline !== undefined
              ? {polyline: sampledPolyline}
              : {}),
          };
          geometriesMap.set(annotation.id, arrowGeometry);
          this.lastKnownAnnotations.set(annotation.id, {
            annotation,
            geometry: arrowGeometry,
          });

          if (arrowBbox.right >= 0 && arrowBbox.left <= size.width) {
            ctx.save();
            try {
              if (animAlpha < 1) {
                ctx.globalAlpha = animAlpha;
              }

              const hasCustomFill =
                annotation.fillColor !== undefined &&
                annotation.fillColor !== 'transparent';

              if (hasCustomFill) {
                ctx.beginPath();
                ctx.moveTo(startPoint.x, startPoint.y);
                if (controlPoint !== undefined) {
                  if (typeof ctx.quadraticCurveTo === 'function') {
                    ctx.quadraticCurveTo(
                      controlPoint.x,
                      controlPoint.y,
                      endPoint.x,
                      endPoint.y,
                    );
                  } else {
                    for (const pt of sampledPolyline!) {
                      ctx.lineTo(pt.x, pt.y);
                    }
                  }
                } else {
                  ctx.lineTo(endPoint.x, endPoint.y);
                }
                ctx.lineWidth = 6;
                ctx.strokeStyle = getAnnotationFillStyle(annotation, 0.22);
                ctx.stroke();
              }

              // Contrast halo / casing
              ctx.beginPath();
              ctx.moveTo(startPoint.x, startPoint.y);
              if (controlPoint !== undefined) {
                if (typeof ctx.quadraticCurveTo === 'function') {
                  ctx.quadraticCurveTo(
                    controlPoint.x,
                    controlPoint.y,
                    endPoint.x,
                    endPoint.y,
                  );
                } else {
                  for (const pt of sampledPolyline!) {
                    ctx.lineTo(pt.x, pt.y);
                  }
                }
              } else {
                ctx.lineTo(endPoint.x, endPoint.y);
              }
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.stroke();

              // Primary stroke
              ctx.beginPath();
              ctx.moveTo(startPoint.x, startPoint.y);
              if (controlPoint !== undefined) {
                if (typeof ctx.quadraticCurveTo === 'function') {
                  ctx.quadraticCurveTo(
                    controlPoint.x,
                    controlPoint.y,
                    endPoint.x,
                    endPoint.y,
                  );
                } else {
                  for (const pt of sampledPolyline!) {
                    ctx.lineTo(pt.x, pt.y);
                  }
                }
              } else {
                ctx.lineTo(endPoint.x, endPoint.y);
              }
              ctx.lineWidth = isSelected ? 3 : 2.5;
              ctx.strokeStyle = annotation.color;
              if (status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.stroke();
              ctx.setLineDash([]);

              // Draw arrowhead at endPoint
              const headLength = 10;
              const headAngle = Math.PI / 6;
              const leftArrowPt = {
                x: endPoint.x - headLength * Math.cos(arrowAngle - headAngle),
                y: endPoint.y - headLength * Math.sin(arrowAngle - headAngle),
              };
              const rightArrowPt = {
                x: endPoint.x - headLength * Math.cos(arrowAngle + headAngle),
                y: endPoint.y - headLength * Math.sin(arrowAngle + headAngle),
              };

              if (hasCustomFill) {
                ctx.beginPath();
                ctx.moveTo(endPoint.x, endPoint.y);
                ctx.lineTo(leftArrowPt.x, leftArrowPt.y);
                ctx.lineTo(rightArrowPt.x, rightArrowPt.y);
                ctx.closePath();
                ctx.fillStyle = getAnnotationFillStyle(annotation, 0.4);
                ctx.fill();
              }

              // Arrowhead halo casing
              ctx.beginPath();
              ctx.moveTo(endPoint.x, endPoint.y);
              ctx.lineTo(leftArrowPt.x, leftArrowPt.y);
              ctx.moveTo(endPoint.x, endPoint.y);
              ctx.lineTo(rightArrowPt.x, rightArrowPt.y);
              ctx.lineWidth = isSelected ? 6 : 5;
              ctx.strokeStyle = colorWithAlpha(theme.COLOR_BACKGROUND, 0.85);
              ctx.setLineDash([]);
              ctx.stroke();

              // Arrowhead primary stroke
              ctx.beginPath();
              ctx.moveTo(endPoint.x, endPoint.y);
              ctx.lineTo(leftArrowPt.x, leftArrowPt.y);
              ctx.moveTo(endPoint.x, endPoint.y);
              ctx.lineTo(rightArrowPt.x, rightArrowPt.y);
              ctx.lineWidth = isSelected ? 3 : 2.5;
              ctx.strokeStyle = annotation.color;
              ctx.stroke();

              if (
                annotation.title !== undefined &&
                annotation.title.trim().length > 0
              ) {
                renderTitlePill(
                  ctx,
                  annotation.title,
                  annotation.color,
                  theme.COLOR_BACKGROUND,
                  {kind: 'arrow', midpoint: curveMidpoint},
                );
              }
            } finally {
              ctx.restore();
            }
          }
        }
      }

      // Pass 4: Draw selection outline and handles
      const selectedId = this.store.selectedId;
      if (selectedId !== undefined) {
        const selectedGeom = geometriesMap.get(selectedId);
        if (selectedGeom !== undefined) {
          const selBbox = selectedGeom.bbox;
          ctx.strokeStyle = theme.COLOR_ACCENT;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(
            selBbox.left - 1,
            selBbox.top - 1,
            selBbox.width + 2,
            selBbox.height + 2,
          );
          ctx.setLineDash([]);

          if (selectedGeom.kind === 'rect' || selectedGeom.kind === 'ellipse') {
            const corners: Point2D[] = [
              {x: selBbox.left, y: selBbox.top},
              {x: selBbox.right, y: selBbox.top},
              {x: selBbox.right, y: selBbox.bottom},
              {x: selBbox.left, y: selBbox.bottom},
            ];
            for (const corner of corners) {
              ctx.fillStyle = theme.COLOR_BACKGROUND;
              ctx.fillRect(corner.x - 3, corner.y - 3, 6, 6);
              ctx.strokeRect(corner.x - 3, corner.y - 3, 6, 6);
            }
          } else if (
            selectedGeom.kind === 'arrow' &&
            selectedGeom.curveMidpoint !== undefined
          ) {
            ctx.beginPath();
            if (typeof ctx.arc === 'function') {
              ctx.arc(
                selectedGeom.curveMidpoint.x,
                selectedGeom.curveMidpoint.y,
                4.5,
                0,
                Math.PI * 2,
              );
            } else {
              ctx.rect(
                selectedGeom.curveMidpoint.x - 4,
                selectedGeom.curveMidpoint.y - 4,
                8,
                8,
              );
            }
            ctx.fillStyle = theme.COLOR_ACCENT;
            ctx.fill();
            ctx.strokeStyle = theme.COLOR_BACKGROUND;
            ctx.lineWidth = 1;
            ctx.stroke();

            if (selectedGeom.start !== undefined) {
              ctx.fillStyle = theme.COLOR_BACKGROUND;
              ctx.strokeStyle = theme.COLOR_ACCENT;
              ctx.fillRect(
                selectedGeom.start.x - 3,
                selectedGeom.start.y - 3,
                6,
                6,
              );
              ctx.strokeRect(
                selectedGeom.start.x - 3,
                selectedGeom.start.y - 3,
                6,
                6,
              );
            }
            if (selectedGeom.end !== undefined) {
              ctx.fillStyle = theme.COLOR_BACKGROUND;
              ctx.strokeStyle = theme.COLOR_ACCENT;
              ctx.fillRect(
                selectedGeom.end.x - 3,
                selectedGeom.end.y - 3,
                6,
                6,
              );
              ctx.strokeRect(
                selectedGeom.end.x - 3,
                selectedGeom.end.y - 3,
                6,
                6,
              );
            }
          }
        }
      }

      // Render active delete animations
      for (const [id, delAnim] of this.deleteAnims.entries()) {
        const elapsed = now - delAnim.startMs;
        if (elapsed < 180) {
          hasActiveAnims = true;
          const t = Math.max(0, Math.min(1, elapsed / 180));
          const ease = 1 - Math.pow(1 - t, 3);
          ctx.save();
          try {
            ctx.globalAlpha = (1 - ease) * 0.7;
            ctx.strokeStyle = delAnim.annotation.color;
            ctx.lineWidth = 2;
            const inset = ease * 4;
            const b = delAnim.geometry.bbox;
            ctx.strokeRect(
              b.left + inset,
              b.top + inset,
              Math.max(0, b.width - inset * 2),
              Math.max(0, b.height - inset * 2),
            );
          } finally {
            ctx.restore();
          }
        } else {
          this.deleteAnims.delete(id);
        }
      }

      // Pass 5: Draw gesture preview
      const preview = this.tools.preview;
      if (preview !== undefined) {
        switch (preview.kind) {
          case 'arrow-curve': {
            ctx.beginPath();
            ctx.moveTo(preview.start.x, preview.start.y);
            if (typeof ctx.quadraticCurveTo === 'function') {
              ctx.quadraticCurveTo(
                preview.control.x,
                preview.control.y,
                preview.end.x,
                preview.end.y,
              );
            } else {
              const sampled = sampleQuadraticBezier(
                preview.start,
                preview.control,
                preview.end,
                16,
              );
              for (const pt of sampled) {
                ctx.lineTo(pt.x, pt.y);
              }
            }
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);

            const angle = quadraticBezierEndAngle(
              preview.start,
              preview.control,
              preview.end,
            );
            const headLength = 10;
            const headAngle = Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(preview.end.x, preview.end.y);
            ctx.lineTo(
              preview.end.x - headLength * Math.cos(angle - headAngle),
              preview.end.y - headLength * Math.sin(angle - headAngle),
            );
            ctx.moveTo(preview.end.x, preview.end.y);
            ctx.lineTo(
              preview.end.x - headLength * Math.cos(angle + headAngle),
              preview.end.y - headLength * Math.sin(angle + headAngle),
            );
            ctx.stroke();
            break;
          }
          case 'rect': {
            ctx.fillStyle = colorWithAlpha(preview.color, 0.12);
            ctx.fillRect(
              preview.rect.left,
              preview.rect.top,
              preview.rect.width,
              preview.rect.height,
            );
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(
              preview.rect.left,
              preview.rect.top,
              preview.rect.width,
              preview.rect.height,
            );
            ctx.setLineDash([]);
            break;
          }
          case 'ellipse': {
            ctx.beginPath();
            const centerX = preview.rect.left + preview.rect.width / 2;
            const centerY = preview.rect.top + preview.rect.height / 2;
            const radiusX = Math.max(0, preview.rect.width / 2);
            const radiusY = Math.max(0, preview.rect.height / 2);
            ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
            ctx.fillStyle = colorWithAlpha(preview.color, 0.12);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            break;
          }
          case 'pen': {
            if (preview.points.length > 1) {
              ctx.beginPath();
              drawSmoothPolyline(ctx, preview.points);
              ctx.lineWidth = 2;
              ctx.strokeStyle = preview.color;
              ctx.stroke();
            }
            break;
          }
          case 'arrow': {
            ctx.beginPath();
            ctx.moveTo(preview.from.x, preview.from.y);
            ctx.lineTo(preview.to.x, preview.to.y);
            ctx.lineWidth = 2;
            ctx.strokeStyle = preview.color;
            ctx.stroke();

            const angle = Math.atan2(
              preview.to.y - preview.from.y,
              preview.to.x - preview.from.x,
            );
            const headLength = 10;
            const headAngle = Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(preview.to.x, preview.to.y);
            ctx.lineTo(
              preview.to.x - headLength * Math.cos(angle - headAngle),
              preview.to.y - headLength * Math.sin(angle - headAngle),
            );
            ctx.moveTo(preview.to.x, preview.to.y);
            ctx.lineTo(
              preview.to.x - headLength * Math.cos(angle + headAngle),
              preview.to.y - headLength * Math.sin(angle + headAngle),
            );
            ctx.stroke();
            break;
          }
          case 'move': {
            const targetGeom =
              geometriesMap.get(preview.annotationId) ??
              this.mergedGeometries.get(preview.annotationId);
            if (targetGeom !== undefined) {
              const shiftedLeft = targetGeom.bbox.left + preview.deltaX;
              const shiftedTop = targetGeom.bbox.top + preview.deltaY;
              ctx.lineWidth = 1;
              ctx.strokeStyle = theme.COLOR_ACCENT;
              ctx.setLineDash([4, 4]);
              ctx.strokeRect(
                shiftedLeft,
                shiftedTop,
                targetGeom.bbox.width,
                targetGeom.bbox.height,
              );
              ctx.setLineDash([]);
            }
            break;
          }
        }
      }

      for (const key of this.mergedGeometries.keys()) {
        if (this.store.get(key) === undefined) {
          this.mergedGeometries.delete(key);
        }
      }
      for (const key of this.renderedAnnotationInfo.keys()) {
        if (this.store.get(key) === undefined) {
          this.renderedAnnotationInfo.delete(key);
        }
      }

      this.geometriesByRoot.set(rootNode, geometriesMap);
      for (const [id, geom] of geometriesMap.entries()) {
        this.mergedGeometries.set(id, geom);
      }
      for (const [id, info] of nextRenderedInfo.entries()) {
        this.renderedAnnotationInfo.set(id, info);
      }

      this.tools.setGeometryProvider((id?: string, targetRoot?: TrackNode) => {
        const map =
          (targetRoot && this.geometriesByRoot.get(targetRoot)) ??
          this.mergedGeometries;
        return id ? map.get(id) : map;
      });

      if (hasActiveAnims) {
        this.tools.requestRedraw?.();
      }
    } finally {
      ctx.restore();
    }
  }
}
