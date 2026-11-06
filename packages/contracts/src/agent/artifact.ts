import * as Schema from 'effect/Schema';

import { relativePathSchema } from '../project/shared.js';

// One file-name segment: no separators, no control characters, never `.` or `..`, and at most
// 255 characters, the common filesystem name limit.
const artifactSegment = String.raw`(?!\.{1,2}(?:/|(?![\s\S])))[^/\\\p{Cc}]{1,255}`;

/**
 * Hosts write artifacts to `<dir>/<path>`, so a path must name one file in exactly one spelling.
 * relativePathSchema already rejects empty, absolute and `..` paths; this also rejects `.`,
 * `./a`, `a//b`, `a/` and backslashes, which name a directory or alias another artifact's file.
 */
const artifactPathSchema = relativePathSchema.check(
  Schema.isPattern(
    new RegExp(String.raw`^${artifactSegment}(?:/${artifactSegment})*(?![\s\S])`, 'u'),
    {
      message:
        'must be a canonical file path: forward-slash segments of at most 255 characters without `.`, `..`, empty segments, backslashes or control characters',
    },
  ),
);

/** A file an agent produced, carried in the envelope as text or base64 bytes. */
const inlineArtifactSchema = Schema.Struct({
  kind: Schema.Literal('inline'),
  path: artifactPathSchema,
  media_type: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(255)),
  encoding: Schema.Literals(['utf8', 'base64']),
  content: Schema.String,
});

/** A file an agent produced but did not inline; the callback transport fetches it by `id`. */
const referenceArtifactSchema = Schema.Struct({
  kind: Schema.Literal('reference'),
  path: artifactPathSchema,
  media_type: Schema.optional(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(255)),
  ),
  id: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
});

/** Any artifact a completion may carry; responses and metric requests accept inline ones only. */
const artifactSchema = Schema.Union([inlineArtifactSchema, referenceArtifactSchema]);

type Artifact = typeof artifactSchema.Type;

type InlineArtifact = typeof inlineArtifactSchema.Type;

type ReferenceArtifact = typeof referenceArtifactSchema.Type;

export {
  artifactPathSchema,
  artifactSchema,
  inlineArtifactSchema,
  referenceArtifactSchema,
  type Artifact,
  type InlineArtifact,
  type ReferenceArtifact,
};
