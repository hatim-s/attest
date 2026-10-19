import { z } from 'zod';

import { relativePathSchema } from '../project/shared.js';

// One file-name segment: no separators, no control characters, never `.` or `..`, and at most
// 255 characters, the common filesystem name limit.
const artifactSegment = String.raw`(?!\.{1,2}(?:/|(?![\s\S])))[^/\\\p{Cc}]{1,255}`;

/**
 * Hosts write artifacts to `<dir>/<path>`, so a path must name one file in exactly one spelling.
 * relativePathSchema already rejects empty, absolute and `..` paths; this also rejects `.`,
 * `./a`, `a//b`, `a/` and backslashes, which name a directory or alias another artifact's file.
 */
const artifactPathSchema = relativePathSchema.regex(
  new RegExp(String.raw`^${artifactSegment}(?:/${artifactSegment})*(?![\s\S])`, 'u'),
  'must be a canonical file path: forward-slash segments of at most 255 characters without `.`, `..`, empty segments, backslashes or control characters',
);

/** A file an agent produced, carried in the envelope as text or base64 bytes. */
const inlineArtifactSchema = z.strictObject({
  kind: z.literal('inline'),
  path: artifactPathSchema,
  media_type: z.string().min(1).max(255),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});

/** A file an agent produced but did not inline; the callback transport fetches it by `id`. */
const referenceArtifactSchema = z.strictObject({
  kind: z.literal('reference'),
  path: artifactPathSchema,
  media_type: z.string().min(1).max(255).optional(),
  id: z.string().min(1).max(256),
});

/** Any artifact a completion may carry; responses and metric requests accept inline ones only. */
const artifactSchema = z.discriminatedUnion('kind', [
  inlineArtifactSchema,
  referenceArtifactSchema,
]);

type Artifact = z.infer<typeof artifactSchema>;

type InlineArtifact = z.infer<typeof inlineArtifactSchema>;

type ReferenceArtifact = z.infer<typeof referenceArtifactSchema>;

export {
  artifactPathSchema,
  artifactSchema,
  inlineArtifactSchema,
  referenceArtifactSchema,
  type Artifact,
  type InlineArtifact,
  type ReferenceArtifact,
};
