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
  OverlayPointerEvent,
  TrackBounds,
} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import {type AnnotationStore, normalizeColor} from './model';
import {
  type ResolvedTrackY,
  resolveArea,
  resolvePoint,
  resolveTrackY,
} from './anchor';
import {bboxOf, type RectBounds} from './geometry';
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

export class AnnotationsOverlay implements Overlay {
  private readonly store: AnnotationStore;
  private readonly tools: ToolController;
  private readonly trackExists: (uri: string) => boolean;
  private renderedAnnotationInfo = new Map<string, RenderedAnnotationInfo>();

  constructor(
    store: AnnotationStore,
    tools: ToolController,
    options?: AnnotationsOverlayOptions,
  ) {
    this.store = store;
    this.tools = tools;
    this.trackExists = options?.trackExists ?? (() => false);
  }

  getCursor(): string | undefined {
    return this.tools.hoverCursor;
  }

  isInteractive(): boolean {
    return this.tools.isInteractive();
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
      const annotationsList = this.store.list();

      // Pass 1: Resolve geometry and compute status for all visible non-hidden annotations
      for (const annotation of annotationsList) {
        if (this.store.isHidden(annotation.id)) {
          continue;
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
                // Exists in workspace (e.g. in the other tree), skip drawing in this tree
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

            if (pointRes === undefined) {
              if (exists) {
                // Exists in workspace (in the other tree), skip drawing in this tree
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
                  right: posX + 60,
                  bottom: 20,
                  width: 60,
                  height: 20,
                },
              });
            } else {
              const status: AnchorStatus =
                pointRes.status === 'exact' ? 'exact' : 'degraded';
              nextRenderedInfo.set(annotation.id, {
                status,
                missing: [],
              });

              const labelText = truncateText(
                annotation.title ?? annotation.text,
                50,
              );
              ctx.font = '12px sans-serif';
              const textMetrics = ctx.measureText(labelText);
              const labelWidth = textMetrics.width + 12;
              const labelHeight = 18;

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
            // Computed in pass 2 once bounding boxes of target annotations are resolved
            break;
          }
        }
      }

      // Pass 2: Draw non-arrow shapes
      for (const annotation of annotationsList) {
        if (this.store.isHidden(annotation.id) || annotation.kind === 'arrow') {
          continue;
        }

        const geometry = geometriesMap.get(annotation.id);
        const info = nextRenderedInfo.get(annotation.id);
        if (!geometry || !info) {
          continue;
        }

        // Skip annotations fully outside viewport horizontal bounds
        if (geometry.bbox.right < 0 || geometry.bbox.left > size.width) {
          continue;
        }

        if (info.status === 'unanchored') {
          // Unanchored translucent vertical band
          ctx.fillStyle = colorWithAlpha(annotation.color, 0.12);
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

        switch (annotation.kind) {
          case 'rect': {
            ctx.fillStyle = colorWithAlpha(annotation.color, 0.12);
            ctx.fillRect(
              geometry.bbox.left,
              geometry.bbox.top,
              geometry.bbox.width,
              geometry.bbox.height,
            );
            ctx.lineWidth = 2;
            ctx.strokeStyle = annotation.color;
            if (info.status === 'degraded') {
              ctx.setLineDash([4, 4]);
            } else {
              ctx.setLineDash([]);
            }
            ctx.strokeRect(
              geometry.bbox.left,
              geometry.bbox.top,
              geometry.bbox.width,
              geometry.bbox.height,
            );
            ctx.setLineDash([]);
            break;
          }
          case 'ellipse': {
            ctx.beginPath();
            const centerX = geometry.bbox.left + geometry.bbox.width / 2;
            const centerY = geometry.bbox.top + geometry.bbox.height / 2;
            const radiusX = Math.max(0, geometry.bbox.width / 2);
            const radiusY = Math.max(0, geometry.bbox.height / 2);
            ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
            ctx.fillStyle = colorWithAlpha(annotation.color, 0.12);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = annotation.color;
            if (info.status === 'degraded') {
              ctx.setLineDash([4, 4]);
            } else {
              ctx.setLineDash([]);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            break;
          }
          case 'path': {
            if (geometry.polyline && geometry.polyline.length > 1) {
              ctx.beginPath();
              ctx.moveTo(geometry.polyline[0].x, geometry.polyline[0].y);
              for (let i = 1; i < geometry.polyline.length; i += 1) {
                ctx.lineTo(geometry.polyline[i].x, geometry.polyline[i].y);
              }
              ctx.lineWidth = 2;
              ctx.strokeStyle = annotation.color;
              if (info.status === 'degraded') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.stroke();
              ctx.setLineDash([]);
            }
            break;
          }
          case 'label': {
            const labelText = truncateText(
              annotation.title ?? annotation.text,
              50,
            );
            ctx.font = '12px sans-serif';
            ctx.fillStyle = colorWithAlpha(annotation.color, 0.12);
            ctx.strokeStyle = annotation.color;
            ctx.lineWidth = 1;
            drawRoundedRect(
              ctx,
              geometry.bbox.left,
              geometry.bbox.top,
              geometry.bbox.width,
              geometry.bbox.height,
              4,
            );
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = theme.COLOR_TEXT;
            ctx.textBaseline = 'middle';
            ctx.fillText(
              labelText,
              geometry.bbox.left + 6,
              geometry.bbox.top + geometry.bbox.height / 2,
            );
            break;
          }
        }
      }

      // Pass 3: Resolve and draw arrows
      for (const annotation of annotationsList) {
        if (this.store.isHidden(annotation.id) || annotation.kind !== 'arrow') {
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
          // Snap 'from' annotation bbox toward endPoint (or center of 'to' annotation)
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

        // Snap 'to' annotation bbox toward startPoint
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
          // Check if endpoints exist in workspace
          const fromExists =
            annotation.from.kind === 'point'
              ? this.trackExists(annotation.from.point.trackUri)
              : this.store.get(annotation.from.id) !== undefined;
          const toExists =
            annotation.to.kind === 'point'
              ? this.trackExists(annotation.to.point.trackUri)
              : this.store.get(annotation.to.id) !== undefined;

          if (fromExists && toExists) {
            // Drawn in the other tree
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
          geometriesMap.set(annotation.id, {
            id: annotation.id,
            kind: 'arrow',
            bbox: bboxOf([startPoint, endPoint]),
            start: startPoint,
            end: endPoint,
          });

          const minX = Math.min(startPoint.x, endPoint.x);
          const maxX = Math.max(startPoint.x, endPoint.x);
          if (maxX >= 0 && minX <= size.width) {
            ctx.beginPath();
            ctx.moveTo(startPoint.x, startPoint.y);
            ctx.lineTo(endPoint.x, endPoint.y);
            ctx.lineWidth = 2;
            ctx.strokeStyle = annotation.color;
            if (status === 'degraded') {
              ctx.setLineDash([4, 4]);
            } else {
              ctx.setLineDash([]);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw arrowhead at endPoint
            const angle = Math.atan2(
              endPoint.y - startPoint.y,
              endPoint.x - startPoint.x,
            );
            const headLength = 10;
            const headAngle = Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(endPoint.x, endPoint.y);
            ctx.lineTo(
              endPoint.x - headLength * Math.cos(angle - headAngle),
              endPoint.y - headLength * Math.sin(angle - headAngle),
            );
            ctx.moveTo(endPoint.x, endPoint.y);
            ctx.lineTo(
              endPoint.x - headLength * Math.cos(angle + headAngle),
              endPoint.y - headLength * Math.sin(angle + headAngle),
            );
            ctx.stroke();
          }
        }
      }

      // Pass 4: Draw selection outline and corner handles
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
          }
        }
      }

      // Pass 5: Draw gesture preview
      const preview = this.tools.preview;
      if (preview !== undefined) {
        switch (preview.kind) {
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
              ctx.moveTo(preview.points[0].x, preview.points[0].y);
              for (let i = 1; i < preview.points.length; i += 1) {
                ctx.lineTo(preview.points[i].x, preview.points[i].y);
              }
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
            const targetGeom = geometriesMap.get(preview.annotationId);
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

      this.renderedAnnotationInfo = nextRenderedInfo;
      this.tools.setGeometryProvider((id?: string) =>
        id ? geometriesMap.get(id) : geometriesMap,
      );
    } finally {
      ctx.restore();
    }
  }
}
