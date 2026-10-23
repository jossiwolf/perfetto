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
import {
  SERIALIZED_ANNOTATIONS_VERSION,
  SerializedTimestampSchema,
  parseSerializedAnnotations,
} from './schema';

describe('schema.ts', () => {
  describe('SerializedTimestampSchema', () => {
    test('accepts valid decimal int64 strings', () => {
      expect(SerializedTimestampSchema.parse('0')).toEqual('0');
      expect(SerializedTimestampSchema.parse('1234567890')).toEqual(
        '1234567890',
      );
      expect(SerializedTimestampSchema.parse('-1')).toEqual('-1');
      expect(SerializedTimestampSchema.parse('9223372036854775807')).toEqual(
        '9223372036854775807',
      );
      expect(SerializedTimestampSchema.parse('-9223372036854775808')).toEqual(
        '-9223372036854775808',
      );
    });

    test('rejects non-int64 decimal strings', () => {
      expect(() => SerializedTimestampSchema.parse('')).toThrow();
      expect(() => SerializedTimestampSchema.parse('abc')).toThrow();
      expect(() => SerializedTimestampSchema.parse('12.34')).toThrow();
      expect(() => SerializedTimestampSchema.parse('1e5')).toThrow();
      expect(() =>
        SerializedTimestampSchema.parse('9223372036854775808'),
      ).toThrow();
      expect(() =>
        SerializedTimestampSchema.parse('-9223372036854775809'),
      ).toThrow();
    });
  });

  describe('parseSerializedAnnotations', () => {
    test('parses empty annotations container with version 1', () => {
      const parsed = parseSerializedAnnotations({
        version: SERIALIZED_ANNOTATIONS_VERSION,
        annotations: [],
      });
      expect(parsed.version).toBe(1);
      expect(parsed.annotations).toEqual([]);
    });

    test('rejects wrong version number', () => {
      expect(() =>
        parseSerializedAnnotations({
          version: 2,
          annotations: [],
        }),
      ).toThrow(/version/);
    });

    test('parses rect annotation', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'rect-1',
            kind: 'rect',
            title: 'Rect Title',
            description: 'Rect Description',
            color: '#ff0000',
            author: 'Alice',
            createdAt: 1000,
            updatedAt: 2000,
            anchor: {
              start: '100',
              end: '500',
              trackUris: ['cpu_0', 'cpu_1'],
              trackNames: ['CPU 0', 'CPU 1'],
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      expect(parsed.annotations.length).toBe(1);
      expect(parsed.annotations[0].kind).toBe('rect');
    });

    test('parses ellipse annotation', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'ellipse-1',
            kind: 'ellipse',
            color: '#00ff00',
            createdAt: 1000,
            updatedAt: 2000,
            anchor: {
              start: '200',
              end: '600',
              trackUris: ['track_a'],
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      expect(parsed.annotations.length).toBe(1);
      expect(parsed.annotations[0].kind).toBe('ellipse');
    });

    test('parses label annotation', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'label-1',
            kind: 'label',
            color: '#0000ff',
            createdAt: 1000,
            updatedAt: 2000,
            text: 'Important event',
            position: {
              ts: '350',
              trackUri: 'track_a',
              trackName: 'Track A',
              yFrac: 0.5,
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      expect(parsed.annotations.length).toBe(1);
      expect(parsed.annotations[0].kind).toBe('label');
    });

    test('parses path annotation with up to 256 points', () => {
      const points = [];
      for (let i = 0; i < 256; i += 1) {
        points.push({
          ts: String(i * 10),
          trackUri: 'track_a',
          yFrac: i / 256,
        });
      }
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'path-1',
            kind: 'path',
            color: '#ffff00',
            createdAt: 1000,
            updatedAt: 2000,
            points,
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      expect(parsed.annotations.length).toBe(1);
      expect(parsed.annotations[0].kind).toBe('path');
    });

    test('rejects path annotation exceeding 256 points', () => {
      const points = [];
      for (let i = 0; i < 257; i += 1) {
        points.push({
          ts: String(i * 10),
          trackUri: 'track_a',
          yFrac: 0.5,
        });
      }
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'path-oversize',
            kind: 'path',
            color: '#ffff00',
            createdAt: 1000,
            updatedAt: 2000,
            points,
          },
        ],
      };
      expect(() => parseSerializedAnnotations(raw)).toThrow(/points/);
    });

    test('parses arrow annotation with both endpoint variants', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'arrow-1',
            kind: 'arrow',
            color: '#ff00ff',
            createdAt: 1000,
            updatedAt: 2000,
            from: {
              kind: 'annotation',
              id: 'rect-1',
            },
            to: {
              kind: 'point',
              point: {
                ts: '900',
                trackUri: 'track_b',
                yFrac: 0.25,
              },
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      expect(parsed.annotations.length).toBe(1);
      expect(parsed.annotations[0].kind).toBe('arrow');
    });

    test('rejects yFrac out of bounds', () => {
      const rawNegative = {
        version: 1,
        annotations: [
          {
            id: 'label-err',
            kind: 'label',
            color: '#000000',
            createdAt: 1000,
            updatedAt: 2000,
            text: 'bad yFrac',
            position: {
              ts: '10',
              trackUri: 'track_a',
              yFrac: -0.1,
            },
          },
        ],
      };
      expect(() => parseSerializedAnnotations(rawNegative)).toThrow(/yFrac/);

      const rawOverOne = {
        version: 1,
        annotations: [
          {
            id: 'label-err-2',
            kind: 'label',
            color: '#000000',
            createdAt: 1000,
            updatedAt: 2000,
            text: 'bad yFrac',
            position: {
              ts: '10',
              trackUri: 'track_a',
              yFrac: 1.05,
            },
          },
        ],
      };
      expect(() => parseSerializedAnnotations(rawOverOne)).toThrow(/yFrac/);
    });

    test('rejects invalid JSON shapes and non-finite timestamps', () => {
      expect(() => parseSerializedAnnotations(null)).toThrow();
      expect(() => parseSerializedAnnotations('not an object')).toThrow();
      expect(() => parseSerializedAnnotations({})).toThrow();
      expect(() =>
        parseSerializedAnnotations({
          version: 1,
          annotations: [
            {
              id: '',
              kind: 'unknown_kind',
            },
          ],
        }),
      ).toThrow();
    });
  });

  describe('extended schema fields', () => {
    test('parses fillColor and fillOpacity on base annotations', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'rect-fill',
            kind: 'rect',
            color: '#ff0000',
            fillColor: '#00ff00',
            fillOpacity: 0.35,
            createdAt: 100,
            updatedAt: 200,
            anchor: {
              start: '10',
              end: '20',
              trackUris: ['t1'],
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      expect(parsed.annotations[0].fillColor).toBe('#00ff00');
      expect(parsed.annotations[0].fillOpacity).toBe(0.35);
    });

    test('rejects invalid fillOpacity out of [0, 1] range', () => {
      const invalidLow = {
        version: 1,
        annotations: [
          {
            id: 'r1',
            kind: 'rect',
            color: '#000',
            fillOpacity: -0.1,
            createdAt: 1,
            updatedAt: 2,
            anchor: {start: '0', end: '10', trackUris: ['t']},
          },
        ],
      };
      expect(() => parseSerializedAnnotations(invalidLow)).toThrow(
        /fillOpacity/,
      );

      const invalidHigh = {
        version: 1,
        annotations: [
          {
            id: 'r2',
            kind: 'rect',
            color: '#000',
            fillOpacity: 1.1,
            createdAt: 1,
            updatedAt: 2,
            anchor: {start: '0', end: '10', trackUris: ['t']},
          },
        ],
      };
      expect(() => parseSerializedAnnotations(invalidHigh)).toThrow(
        /fillOpacity/,
      );
    });

    test('parses label text styles: fontFamily, fontSize, textColor, backgroundColor', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'label-styled',
            kind: 'label',
            color: '#123456',
            createdAt: 10,
            updatedAt: 20,
            text: 'styled label',
            fontFamily: 'monospace',
            fontSize: 16,
            textColor: '#ffffff',
            backgroundColor: '#000000',
            position: {
              ts: '100',
              trackUri: 't',
              yFrac: 0.5,
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      const label = parsed.annotations[0];
      if (label.kind !== 'label') throw new Error('Expected label');
      expect(label.fontFamily).toBe('monospace');
      expect(label.fontSize).toBe(16);
      expect(label.textColor).toBe('#ffffff');
      expect(label.backgroundColor).toBe('#000000');
    });

    test('rejects invalid fontFamily and out-of-range fontSize', () => {
      expect(() =>
        parseSerializedAnnotations({
          version: 1,
          annotations: [
            {
              id: 'l1',
              kind: 'label',
              color: '#000',
              createdAt: 1,
              updatedAt: 1,
              text: 'bad font',
              fontFamily: 'comic-sans',
              position: {ts: '0', trackUri: 't', yFrac: 0.5},
            },
          ],
        }),
      ).toThrow(/fontFamily/);

      expect(() =>
        parseSerializedAnnotations({
          version: 1,
          annotations: [
            {
              id: 'l2',
              kind: 'label',
              color: '#000',
              createdAt: 1,
              updatedAt: 1,
              text: 'too small',
              fontSize: 7,
              position: {ts: '0', trackUri: 't', yFrac: 0.5},
            },
          ],
        }),
      ).toThrow(/fontSize/);

      expect(() =>
        parseSerializedAnnotations({
          version: 1,
          annotations: [
            {
              id: 'l3',
              kind: 'label',
              color: '#000',
              createdAt: 1,
              updatedAt: 1,
              text: 'too big',
              fontSize: 73,
              position: {ts: '0', trackUri: 't', yFrac: 0.5},
            },
          ],
        }),
      ).toThrow(/fontSize/);
    });

    test('parses arrow curvature and controlOffset', () => {
      const raw = {
        version: 1,
        annotations: [
          {
            id: 'arrow-curved',
            kind: 'arrow',
            color: '#111',
            createdAt: 1,
            updatedAt: 1,
            curvature: -150,
            controlOffset: {
              alongFrac: 0.4,
              normalPx: 75,
            },
            from: {
              kind: 'point',
              point: {ts: '0', trackUri: 't', yFrac: 0.5},
            },
            to: {
              kind: 'point',
              point: {ts: '100', trackUri: 't', yFrac: 0.5},
            },
          },
        ],
      };
      const parsed = parseSerializedAnnotations(raw);
      const arrow = parsed.annotations[0];
      if (arrow.kind !== 'arrow') throw new Error('Expected arrow');
      expect(arrow.curvature).toBe(-150);
      expect(arrow.controlOffset).toEqual({alongFrac: 0.4, normalPx: 75});
    });

    test('rejects arrow curvature and controlOffset out of bounds', () => {
      expect(() =>
        parseSerializedAnnotations({
          version: 1,
          annotations: [
            {
              id: 'a1',
              kind: 'arrow',
              color: '#000',
              createdAt: 1,
              updatedAt: 1,
              curvature: 1001,
              from: {
                kind: 'point',
                point: {ts: '0', trackUri: 't', yFrac: 0.5},
              },
              to: {
                kind: 'point',
                point: {ts: '100', trackUri: 't', yFrac: 0.5},
              },
            },
          ],
        }),
      ).toThrow(/curvature/);

      expect(() =>
        parseSerializedAnnotations({
          version: 1,
          annotations: [
            {
              id: 'a2',
              kind: 'arrow',
              color: '#000',
              createdAt: 1,
              updatedAt: 1,
              controlOffset: {alongFrac: 1.5, normalPx: 0},
              from: {
                kind: 'point',
                point: {ts: '0', trackUri: 't', yFrac: 0.5},
              },
              to: {
                kind: 'point',
                point: {ts: '100', trackUri: 't', yFrac: 0.5},
              },
            },
          ],
        }),
      ).toThrow(/controlOffset/);
    });
  });
});
