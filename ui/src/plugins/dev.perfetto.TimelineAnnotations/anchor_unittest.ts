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

import {describe, expect, test} from 'vitest';
import {Time} from '../../base/time';
import type {TrackBounds} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import {
  areaForTrackRange,
  pointAtY,
  resolveArea,
  resolvePoint,
  resolveTrackY,
} from './anchor';

describe('anchor.ts', () => {
  // Construct a realistic TrackNode hierarchy:
  // root
  //   group1 (uri: 'group_1', name: 'Process Group 1')
  //     track1 (uri: 'track_1', name: 'Main Thread')
  //     track2 (uri: 'track_2', name: 'Render Thread')
  //   group2 (uri: 'group_2', name: 'Process Group 2')
  //     track3 (uri: 'track_3', name: 'Worker Thread A')
  //     track4 (uri: 'track_4', name: 'Worker Thread B')

  const rootNode = new TrackNode({name: 'Root'});
  const group1 = new TrackNode({uri: 'group_1', name: 'Process Group 1'});
  const track1 = new TrackNode({uri: 'track_1', name: 'Main Thread'});
  const track2 = new TrackNode({uri: 'track_2', name: 'Render Thread'});
  group1.addChildLast(track1);
  group1.addChildLast(track2);

  const group2 = new TrackNode({uri: 'group_2', name: 'Process Group 2'});
  const track3 = new TrackNode({uri: 'track_3', name: 'Worker Thread A'});
  const track4 = new TrackNode({uri: 'track_4', name: 'Worker Thread B'});
  group2.addChildLast(track3);
  group2.addChildLast(track4);

  rootNode.addChildLast(group1);
  rootNode.addChildLast(group2);

  describe('resolveTrackY degradation ladder', () => {
    test('exact match by trackUri', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 150}},
        {node: track2, verticalBounds: {top: 150, bottom: 200}},
      ];

      const result = resolveTrackY(
        'track_1',
        'Main Thread',
        visibleTracks,
        rootNode,
      );
      expect(result).toEqual({top: 100, bottom: 150, status: 'exact'});
    });

    test('nearest visible ancestor when child track is collapsed', () => {
      // Group 1 is visible in tracks, but track1 is not in visibleTracks
      const visibleTracks: TrackBounds[] = [
        {node: group1, verticalBounds: {top: 50, bottom: 120}},
      ];

      const result = resolveTrackY(
        'track_1',
        'Main Thread',
        visibleTracks,
        rootNode,
      );
      expect(result).toEqual({top: 50, bottom: 120, status: 'ancestor'});
    });

    test('fuzzy name matching precedence: exact > startsWith > includes', () => {
      const trackAlpha = new TrackNode({
        uri: 'vis_alpha',
        name: 'Worker Thread',
      });
      const trackBeta = new TrackNode({
        uri: 'vis_beta',
        name: 'Worker Thread Pool',
      });
      const trackGamma = new TrackNode({
        uri: 'vis_gamma',
        name: 'Dedicated Worker Thread',
      });

      const visibleTracks: TrackBounds[] = [
        {node: trackGamma, verticalBounds: {top: 300, bottom: 350}},
        {node: trackBeta, verticalBounds: {top: 200, bottom: 250}},
        {node: trackAlpha, verticalBounds: {top: 100, bottom: 150}},
      ];

      // Exact case-insensitive match should pick trackAlpha despite order
      const exactResult = resolveTrackY(
        'missing_uri',
        'worker thread',
        visibleTracks,
        rootNode,
      );
      expect(exactResult).toEqual({top: 100, bottom: 150, status: 'fuzzy'});

      // startsWith match when exact not found
      const startsWithResult = resolveTrackY(
        'missing_uri',
        'worker thread p',
        visibleTracks,
        rootNode,
      );
      expect(startsWithResult).toEqual({
        top: 200,
        bottom: 250,
        status: 'fuzzy',
      });

      // includes match when exact and startsWith not found
      const includesResult = resolveTrackY(
        'missing_uri',
        'dedicated',
        visibleTracks,
        rootNode,
      );
      expect(includesResult).toEqual({top: 300, bottom: 350, status: 'fuzzy'});
    });

    test('returns undefined when nothing matches', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 150}},
      ];
      const result = resolveTrackY(
        'non_existent_uri',
        'No such name',
        visibleTracks,
        rootNode,
      );
      expect(result).toBeUndefined();
    });
  });

  describe('resolveArea', () => {
    test('returns union [min top, max bottom] and partition of resolved/missing', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 150}},
        {node: track2, verticalBounds: {top: 150, bottom: 220}},
      ];

      const areaAnchor = {
        start: Time.fromRaw(0n),
        end: Time.fromRaw(100n),
        trackUris: ['track_1', 'track_2', 'missing_track'],
        trackNames: ['Main Thread', 'Render Thread', 'Missing'],
      };

      const result = resolveArea(areaAnchor, visibleTracks, rootNode);
      expect(result).toEqual({
        top: 100,
        bottom: 220,
        resolved: ['track_1', 'track_2'],
        missing: ['missing_track'],
      });
    });

    test('returns undefined when zero tracks resolve or trackUris empty', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 150}},
      ];

      expect(
        resolveArea(
          {start: Time.fromRaw(0n), end: Time.fromRaw(10n), trackUris: []},
          visibleTracks,
          rootNode,
        ),
      ).toBeUndefined();

      expect(
        resolveArea(
          {
            start: Time.fromRaw(0n),
            end: Time.fromRaw(10n),
            trackUris: ['missing_1', 'missing_2'],
          },
          visibleTracks,
          rootNode,
        ),
      ).toBeUndefined();
    });

    test('applies fractional bounds topYFrac and bottomYFrac to exact matches', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 200}}, // height: 100
        {node: track2, verticalBounds: {top: 200, bottom: 400}}, // height: 200
      ];

      // Single track exact match: topYFrac=0.2 => 100 + 100*0.2 = 120
      // bottomYFrac=0.8 => 100 + 100*0.8 = 180
      const singleTrack = resolveArea(
        {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['track_1'],
          topYFrac: 0.2,
          bottomYFrac: 0.8,
        },
        visibleTracks,
        rootNode,
      );
      expect(singleTrack).toEqual({
        top: 120,
        bottom: 180,
        resolved: ['track_1'],
        missing: [],
      });

      // Spanning two tracks:
      // firstBounds (track_1): top = 100, height = 100 => topYFrac 0.4 => 100 + 40 = 140
      // lastBounds (track_2): top = 200, height = 200 => bottomYFrac 0.6 => 200 + 120 = 320
      const multiTrack = resolveArea(
        {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['track_1', 'track_2'],
          topYFrac: 0.4,
          bottomYFrac: 0.6,
        },
        visibleTracks,
        rootNode,
      );
      expect(multiTrack).toEqual({
        top: 140,
        bottom: 320,
        resolved: ['track_1', 'track_2'],
        missing: [],
      });
    });

    test('enforces minimum height when bottomYFrac <= topYFrac', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 200}},
      ];

      const zeroHeight = resolveArea(
        {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['track_1'],
          topYFrac: 0.5,
          bottomYFrac: 0.5,
        },
        visibleTracks,
        rootNode,
      );
      expect(zeroHeight?.top).toBe(150);
      expect(zeroHeight?.bottom).toBe(152); // minTop + 2

      const invertedHeight = resolveArea(
        {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['track_1'],
          topYFrac: 0.8,
          bottomYFrac: 0.2,
        },
        visibleTracks,
        rootNode,
      );
      expect(invertedHeight?.top).toBe(180);
      expect(invertedHeight?.bottom).toBe(182); // minTop + 2
    });

    test('fractional bounds only apply when first/last status is exact', () => {
      // track1 is child of group1. If track1 is collapsed and group1 is visible,
      // resolution status is 'ancestor', so topYFrac is ignored (preserves full ancestor bounds)
      const visibleTracks: TrackBounds[] = [
        {node: group1, verticalBounds: {top: 50, bottom: 120}},
      ];

      const ancestorResult = resolveArea(
        {
          start: Time.fromRaw(0n),
          end: Time.fromRaw(10n),
          trackUris: ['track_1'],
          topYFrac: 0.25,
          bottomYFrac: 0.75,
        },
        visibleTracks,
        rootNode,
      );
      expect(ancestorResult).toEqual({
        top: 50,
        bottom: 120,
        resolved: ['track_1'],
        missing: [],
      });
    });
  });

  describe('resolvePoint', () => {
    test('resolves point within track and clamps yFrac', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 200}},
      ];

      const midpoint = resolvePoint(
        {ts: Time.fromRaw(10n), trackUri: 'track_1', yFrac: 0.5},
        visibleTracks,
        rootNode,
      );
      expect(midpoint).toEqual({y: 150, status: 'exact'});

      // Negative yFrac clamped to 0
      const clampedLow = resolvePoint(
        {ts: Time.fromRaw(10n), trackUri: 'track_1', yFrac: -0.5},
        visibleTracks,
        rootNode,
      );
      expect(clampedLow?.y).toBe(100);

      // yFrac > 1 clamped to 1
      const clampedHigh = resolvePoint(
        {ts: Time.fromRaw(10n), trackUri: 'track_1', yFrac: 1.8},
        visibleTracks,
        rootNode,
      );
      expect(clampedHigh?.y).toBe(200);

      // Missing track returns undefined
      const missing = resolvePoint(
        {ts: Time.fromRaw(10n), trackUri: 'missing_track', yFrac: 0.5},
        visibleTracks,
        rootNode,
      );
      expect(missing).toBeUndefined();
    });
  });

  describe('pointAtY', () => {
    test('converts pixel y to track uri and yFrac', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 200}},
        {node: track2, verticalBounds: {top: 200, bottom: 300}},
      ];

      const pointInside = pointAtY(125, visibleTracks);
      expect(pointInside).toEqual({
        trackUri: 'track_1',
        trackName: 'Main Thread',
        yFrac: 0.25,
      });

      const boundaryPoint = pointAtY(200, visibleTracks);
      expect(boundaryPoint?.trackUri).toBe('track_1');
      expect(boundaryPoint?.yFrac).toBe(1);

      const outsidePoint = pointAtY(50, visibleTracks);
      expect(outsidePoint).toBeUndefined();
    });
  });

  describe('areaForTrackRange', () => {
    test('returns intersecting track URIs independent of yTop/yBottom order', () => {
      const visibleTracks: TrackBounds[] = [
        {node: track1, verticalBounds: {top: 100, bottom: 150}},
        {node: track2, verticalBounds: {top: 150, bottom: 200}},
        {node: track3, verticalBounds: {top: 200, bottom: 250}},
      ];

      const resultAsc = areaForTrackRange(120, 180, visibleTracks);
      expect(resultAsc).toEqual(['track_1', 'track_2']);

      const resultDesc = areaForTrackRange(180, 120, visibleTracks);
      expect(resultDesc).toEqual(['track_1', 'track_2']);

      // Exact instant point range
      const singlePoint = areaForTrackRange(150, 150, visibleTracks);
      expect(singlePoint).toEqual(['track_1', 'track_2']);
    });
  });
});
