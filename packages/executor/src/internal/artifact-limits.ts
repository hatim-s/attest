import type { AgentResource, Artifact, InlineArtifact } from '@attest/contracts';

import { AgentInvocationError } from '../errors.js';
import type { InvocationAttempt, InvocationResult } from '../types.js';
import {
  DEFAULT_ARTIFACT_BYTES,
  DEFAULT_ARTIFACT_COUNT,
  DEFAULT_TOTAL_ARTIFACT_BYTES,
} from './agent-defaults.js';
import { createFailedAttempt } from './failed-attempt.js';

type AgentLimits = AgentResource['limits'];

/** Bytes an artifact occupies once written to disk, not the length of its encoded content. */
const artifactByteLength = (artifact: InlineArtifact): number =>
  Buffer.byteLength(artifact.content, artifact.encoding === 'utf8' ? 'utf8' : 'base64');

/**
 * Checks what is known before any artifact is fetched: one file per path and the count cap.
 * Hosts write every artifact to `<dir>/<path>`, so a repeated path would silently overwrite.
 */
const assertArtifactManifest = (artifacts: readonly Artifact[], limits: AgentLimits): void => {
  const paths = new Set<string>();

  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) {
      throw new AgentInvocationError(
        'invalid_envelope',
        `Agent artifacts repeat the path ${artifact.path}.`,
      );
    }

    paths.add(artifact.path);
  }

  const maximum = limits?.artifact_count ?? DEFAULT_ARTIFACT_COUNT;

  if (artifacts.length > maximum) {
    throw new AgentInvocationError(
      'output_cap_exceeded',
      `Agent returned ${artifacts.length} artifacts; the limit is ${maximum}.`,
    );
  }
};

/** Enforces the per-artifact and per-response byte caps on decoded artifact contents. */
const assertArtifactSizes = (artifacts: readonly InlineArtifact[], limits: AgentLimits): void => {
  const perArtifact = limits?.artifact_bytes ?? DEFAULT_ARTIFACT_BYTES;
  const total = limits?.total_artifact_bytes ?? DEFAULT_TOTAL_ARTIFACT_BYTES;
  let totalBytes = 0;

  for (const artifact of artifacts) {
    const bytes = artifactByteLength(artifact);

    if (bytes > perArtifact) {
      throw new AgentInvocationError(
        'output_cap_exceeded',
        `Artifact ${artifact.path} exceeds the ${perArtifact}-byte artifact cap.`,
      );
    }

    totalBytes += bytes;

    if (totalBytes > total) {
      throw new AgentInvocationError(
        'output_cap_exceeded',
        `Agent artifacts exceed the ${total}-byte total artifact cap.`,
      );
    }
  }
};

/**
 * Applies the artifact caps to a finished invocation from any transport. Inline artifacts arrive
 * inside the response body, so every transport's parsed response passes through here once; a
 * violation turns the final attempt into an invocation error that keeps its evidence.
 */
const enforceArtifactLimits = (result: InvocationResult, limits: AgentLimits): InvocationResult => {
  if (result.status !== 'ok' || result.report?.ok !== true) return result;
  const artifacts = result.report.value.artifacts ?? [];

  try {
    assertArtifactManifest(artifacts, limits);
    assertArtifactSizes(artifacts, limits);

    return result;
  } catch (error: unknown) {
    if (!(error instanceof AgentInvocationError)) throw error;

    const failed: InvocationAttempt = createFailedAttempt(error, {
      diagnostics: result.diagnostics,
      durationMs: result.durationMs,
      rawExcerpt: result.rawExcerpt,
    });

    return { ...failed, attempts: [...result.attempts.slice(0, -1), failed] };
  }
};

export { assertArtifactManifest, assertArtifactSizes, enforceArtifactLimits };
