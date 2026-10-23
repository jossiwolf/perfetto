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

import {z} from 'zod';

export const SERIALIZED_ANNOTATIONS_VERSION = 1;

// Timestamps are decimal int64 strings validated with a regex.
// Supports negative numbers (e.g. Time.INVALID = -1), zero, and extreme values up to int64 max/min.
export const SerializedTimestampSchema = z
  .string()
  .regex(/^-?\d+$/, 'Timestamp must be a decimal int64 string')
  .refine((val) => {
    try {
      const parsedBigInt = BigInt(val);
      return (
        parsedBigInt >= -9223372036854775808n &&
        parsedBigInt <= 9223372036854775807n
      );
    } catch {
      return false;
    }
  }, 'Timestamp is outside the 64-bit signed integer range');

export const SerializedPointSchema = z.object({
  ts: SerializedTimestampSchema,
  trackUri: z.string().min(1),
  trackName: z.string().optional(),
  yFrac: z.number().min(0).max(1),
});

export const SerializedAreaAnchorSchema = z.object({
  start: SerializedTimestampSchema,
  end: SerializedTimestampSchema,
  trackUris: z.array(z.string().min(1)),
  trackNames: z.array(z.string()).optional(),
});

export const SerializedArrowEndpointSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('annotation'),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('point'),
    point: SerializedPointSchema,
  }),
]);

export const SerializedBaseAnnotationSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  color: z.string().min(1),
  fillColor: z.string().min(1).optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  author: z.string().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

export const SerializedRectAnnotationSchema =
  SerializedBaseAnnotationSchema.extend({
    kind: z.literal('rect'),
    anchor: SerializedAreaAnchorSchema,
  });

export const SerializedEllipseAnnotationSchema =
  SerializedBaseAnnotationSchema.extend({
    kind: z.literal('ellipse'),
    anchor: SerializedAreaAnchorSchema,
  });

export const LabelFontFamilySchema = z.enum([
  'sans-serif',
  'monospace',
  'serif',
]);
export type LabelFontFamily = 'sans-serif' | 'monospace' | 'serif';

export const SerializedLabelAnnotationSchema =
  SerializedBaseAnnotationSchema.extend({
    kind: z.literal('label'),
    position: SerializedPointSchema,
    text: z.string(),
    fontFamily: LabelFontFamilySchema.optional(),
    fontSize: z.number().min(8).max(72).optional(),
    textColor: z.string().min(1).optional(),
    backgroundColor: z.string().min(1).optional(),
  });

export const SerializedPathAnnotationSchema =
  SerializedBaseAnnotationSchema.extend({
    kind: z.literal('path'),
    points: z.array(SerializedPointSchema).max(256),
  });

export const ArrowControlOffsetSchema = z.object({
  alongFrac: z.number().min(0).max(1),
  normalPx: z.number().min(-1000).max(1000),
});
export type ArrowControlOffset = {
  readonly alongFrac: number;
  readonly normalPx: number;
};

export const SerializedArrowAnnotationSchema =
  SerializedBaseAnnotationSchema.extend({
    kind: z.literal('arrow'),
    from: SerializedArrowEndpointSchema,
    to: SerializedArrowEndpointSchema,
    curvature: z.number().min(-1000).max(1000).optional(),
    controlOffset: ArrowControlOffsetSchema.optional(),
  });

export const SerializedAnnotationSchema = z.discriminatedUnion('kind', [
  SerializedRectAnnotationSchema,
  SerializedEllipseAnnotationSchema,
  SerializedLabelAnnotationSchema,
  SerializedPathAnnotationSchema,
  SerializedArrowAnnotationSchema,
]);

export const SerializedAnnotationsSchema = z.object({
  version: z.literal(SERIALIZED_ANNOTATIONS_VERSION),
  annotations: z.array(SerializedAnnotationSchema),
});

export type SerializedTimestamp = z.infer<typeof SerializedTimestampSchema>;
export type SerializedPoint = z.infer<typeof SerializedPointSchema>;
export type SerializedAreaAnchor = z.infer<typeof SerializedAreaAnchorSchema>;
export type SerializedArrowEndpoint = z.infer<
  typeof SerializedArrowEndpointSchema
>;
export type SerializedBaseAnnotation = z.infer<
  typeof SerializedBaseAnnotationSchema
>;
export type SerializedRectAnnotation = z.infer<
  typeof SerializedRectAnnotationSchema
>;
export type SerializedEllipseAnnotation = z.infer<
  typeof SerializedEllipseAnnotationSchema
>;
export type SerializedLabelAnnotation = z.infer<
  typeof SerializedLabelAnnotationSchema
>;
export type SerializedPathAnnotation = z.infer<
  typeof SerializedPathAnnotationSchema
>;
export type SerializedArrowAnnotation = z.infer<
  typeof SerializedArrowAnnotationSchema
>;
export type SerializedAnnotation = z.infer<typeof SerializedAnnotationSchema>;
export type SerializedAnnotations = z.infer<typeof SerializedAnnotationsSchema>;

export function parseSerializedAnnotations(
  data: unknown,
): SerializedAnnotations {
  const parseResult = SerializedAnnotationsSchema.safeParse(data);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues
      .map((issue) => {
        const pathString =
          issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${pathString}: ${issue.message}`;
      })
      .join('; ');
    const parseError = new Error(
      `Failed to parse serialized annotations: ${errorDetails}`,
    );
    (parseError as {cause?: unknown}).cause = parseResult.error;
    throw parseError;
  }
  return parseResult.data;
}
