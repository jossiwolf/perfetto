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

import type {TrackBounds} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import type {AnchoredPoint, AreaAnchor} from './model';

export type ResolutionStatus = 'exact' | 'ancestor' | 'fuzzy';

export interface ResolvedTrackY {
  readonly top: number;
  readonly bottom: number;
  readonly status: ResolutionStatus;
}

export interface ResolvedArea {
  readonly top: number;
  readonly bottom: number;
  readonly resolved: string[];
  readonly missing: string[];
}

export interface ResolvedPoint {
  readonly y: number;
  readonly status: ResolutionStatus;
}

export interface AnchorAtY {
  readonly trackUri: string;
  readonly trackName?: string;
  readonly yFrac: number;
}

/**
 * Resolves a track's vertical bounds using a degradation ladder:
 * 1. Exact match on trackUri in visible tracks.
 * 2. Nearest visible ancestor by walking node.parent in rootNode until reaching a node in visible tracks.
 * 3. Fuzzy name match against visible tracks (case-insensitive exact, then startsWith, then includes).
 * 4. undefined if not found.
 */
export function resolveTrackY(
  trackUri: string,
  trackName: string | undefined,
  tracks: ReadonlyArray<TrackBounds>,
  rootNode: TrackNode,
): ResolvedTrackY | undefined {
  // 1. Exact match by trackUri
  for (const track of tracks) {
    if (track.node.uri === trackUri) {
      return {
        top: track.verticalBounds.top,
        bottom: track.verticalBounds.bottom,
        status: 'exact',
      };
    }
  }

  // 2. Nearest visible ancestor
  const targetNode = rootNode.getTrackByUri(trackUri);

  if (targetNode) {
    let currentAncestor = targetNode.parent;
    while (currentAncestor) {
      const ancestorTrack = tracks.find(
        (candidate) =>
          candidate.node === currentAncestor ||
          (currentAncestor?.uri !== undefined &&
            candidate.node.uri === currentAncestor.uri),
      );
      if (ancestorTrack) {
        return {
          top: ancestorTrack.verticalBounds.top,
          bottom: ancestorTrack.verticalBounds.bottom,
          status: 'ancestor',
        };
      }
      currentAncestor = currentAncestor.parent;
    }
  }

  // 3. Fuzzy name match against visible tracks
  if (trackName && trackName.trim().length > 0) {
    const targetNameLower = trackName.trim().toLowerCase();

    // 3a. Case-insensitive exact name match
    for (const track of tracks) {
      const candidateName = track.node.name.trim().toLowerCase();
      if (candidateName === targetNameLower) {
        return {
          top: track.verticalBounds.top,
          bottom: track.verticalBounds.bottom,
          status: 'fuzzy',
        };
      }
    }

    // 3b. Case-insensitive startsWith
    for (const track of tracks) {
      const candidateName = track.node.name.trim().toLowerCase();
      if (candidateName.startsWith(targetNameLower)) {
        return {
          top: track.verticalBounds.top,
          bottom: track.verticalBounds.bottom,
          status: 'fuzzy',
        };
      }
    }

    // 3c. Case-insensitive includes
    for (const track of tracks) {
      const candidateName = track.node.name.trim().toLowerCase();
      if (candidateName.includes(targetNameLower)) {
        return {
          top: track.verticalBounds.top,
          bottom: track.verticalBounds.bottom,
          status: 'fuzzy',
        };
      }
    }
  }

  return undefined;
}

/**
 * Resolves an AreaAnchor to vertical bounds.
 * Returns the union [min top, max bottom] over all resolved track URIs,
 * together with lists of resolved and missing URIs.
 * Returns undefined only when nothing resolves.
 */
export function resolveArea(
  anchor: AreaAnchor,
  tracks: ReadonlyArray<TrackBounds>,
  rootNode: TrackNode,
  resolver?: (uri: string, name?: string) => ResolvedTrackY | undefined,
): ResolvedArea | undefined {
  if (anchor.trackUris.length === 0) {
    return undefined;
  }

  let minTop = Infinity;
  let maxBottom = -Infinity;
  const resolved: string[] = [];
  const missing: string[] = [];

  let firstBounds: {top: number; bottom: number; height: number} | undefined;
  let firstStatus: ResolutionStatus | undefined;
  let lastBounds: {top: number; bottom: number; height: number} | undefined;
  let lastStatus: ResolutionStatus | undefined;

  for (let index = 0; index < anchor.trackUris.length; index += 1) {
    const uri = anchor.trackUris[index];
    const name = anchor.trackNames?.[index];
    const resolution = resolver
      ? resolver(uri, name)
      : resolveTrackY(uri, name, tracks, rootNode);
    if (resolution !== undefined) {
      resolved.push(uri);
      const bounds = {
        top: resolution.top,
        bottom: resolution.bottom,
        height: resolution.bottom - resolution.top,
      };
      if (firstBounds === undefined) {
        firstBounds = bounds;
        firstStatus = resolution.status;
      }
      lastBounds = bounds;
      lastStatus = resolution.status;

      if (resolution.top < minTop) {
        minTop = resolution.top;
      }
      if (resolution.bottom > maxBottom) {
        maxBottom = resolution.bottom;
      }
    } else {
      missing.push(uri);
    }
  }

  if (resolved.length === 0) {
    return undefined;
  }

  if (
    anchor.topYFrac !== undefined &&
    firstBounds !== undefined &&
    firstStatus === 'exact'
  ) {
    minTop =
      firstBounds.top +
      firstBounds.height * Math.max(0, Math.min(1, anchor.topYFrac));
  }
  if (
    anchor.bottomYFrac !== undefined &&
    lastBounds !== undefined &&
    lastStatus === 'exact'
  ) {
    maxBottom =
      lastBounds.top +
      lastBounds.height * Math.max(0, Math.min(1, anchor.bottomYFrac));
  }
  if (maxBottom <= minTop) {
    maxBottom = minTop + 2;
  }

  return {
    top: minTop,
    bottom: maxBottom,
    resolved,
    missing,
  };
}

/**
 * Resolves an AnchoredPoint to an absolute pixel y-coordinate.
 * Clamps yFrac between 0 and 1.
 */
export function resolvePoint(
  point: AnchoredPoint,
  tracks: ReadonlyArray<TrackBounds>,
  rootNode: TrackNode,
  resolver?: (uri: string, name?: string) => ResolvedTrackY | undefined,
): ResolvedPoint | undefined {
  const resolution = resolver
    ? resolver(point.trackUri, point.trackName)
    : resolveTrackY(point.trackUri, point.trackName, tracks, rootNode);
  if (resolution === undefined) {
    return undefined;
  }
  const clampedYFrac = Math.max(0, Math.min(1, point.yFrac));
  const posY =
    resolution.top + clampedYFrac * (resolution.bottom - resolution.top);
  return {
    y: posY,
    status: resolution.status,
  };
}

/**
 * Converts a pixel y-coordinate into an anchored point representation.
 * Finds the track containing y and calculates the fractional offset yFrac within it.
 * Returns undefined if y does not fall within any visible track.
 */
export function pointAtY(
  posY: number,
  tracks: ReadonlyArray<TrackBounds>,
): AnchorAtY | undefined {
  for (const track of tracks) {
    const top = track.verticalBounds.top;
    const bottom = track.verticalBounds.bottom;
    if (posY >= top && posY <= bottom) {
      const height = bottom - top;
      const yFrac =
        height > 0 ? Math.max(0, Math.min(1, (posY - top) / height)) : 0;
      const uri = track.node.uri;
      if (!uri) {
        continue;
      }
      return {
        trackUri: uri,
        ...(track.node.name ? {trackName: track.node.name} : {}),
        yFrac,
      };
    }
  }
  return undefined;
}

/**
 * Converts a pixel vertical range [yTop, yBottom] into a list of track URIs whose bounds intersect that range.
 */
export function areaForTrackRange(
  yTop: number,
  yBottom: number,
  tracks: ReadonlyArray<TrackBounds>,
): string[] {
  const rangeTop = Math.min(yTop, yBottom);
  const rangeBottom = Math.max(yTop, yBottom);
  const uris: string[] = [];

  for (const track of tracks) {
    const trackTop = track.verticalBounds.top;
    const trackBottom = track.verticalBounds.bottom;
    const intersects =
      rangeTop === rangeBottom
        ? trackTop <= rangeTop && trackBottom >= rangeTop
        : trackTop < rangeBottom && trackBottom > rangeTop;

    if (intersects && track.node.uri && !uris.includes(track.node.uri)) {
      uris.push(track.node.uri);
    }
  }

  return uris;
}
