import { createHash } from 'node:crypto';

import type { EvalJUnitPayload, NormalizedEvalCaseResult } from './types.js';

/** Removes code points forbidden by XML 1.0 before markup escaping. */
const stripInvalidXmlCodePoints = (value: string): string =>
  [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      );
    })
    .join('');

/** Escapes one XML attribute or text value after invalid-code-point removal. */
const escapeXml = (value: string): string =>
  stripInvalidXmlCodePoints(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/** Produces the actionable failure/error message for one normalized case. */
const caseMessage = (evalCase: NormalizedEvalCaseResult): string => {
  if (evalCase.verdict === 'fail') {
    const failedMetrics = evalCase.metric_results
      .filter((metric) => metric.status === 'evaluated' && !metric.pass)
      .map((metric) => metric.metric_name)
      .sort();
    return `failing metrics: ${failedMetrics.join(', ')}`;
  }

  const metricErrors = evalCase.metric_results
    .filter((metric) => metric.status === 'error')
    .map((metric) => `${metric.metric_name}: ${metric.error.message}`)
    .sort();
  return metricErrors.length > 0 ? metricErrors.join('; ') : `case ended with ${evalCase.outcome}`;
};

/** Serializes one case without exposing raw invocation evidence. */
const serializeCase = (evalCase: NormalizedEvalCaseResult): string => {
  const attributes =
    `name="${escapeXml(evalCase.case_id)}" classname="${escapeXml(evalCase.test_id)}" ` +
    `time="${String(evalCase.duration_ms / 1000)}"`;
  if (evalCase.verdict === 'pass') return `    <testcase ${attributes}/>`;
  const tag = evalCase.verdict === 'fail' ? 'failure' : 'error';
  const message = caseMessage(evalCase);
  return `    <testcase ${attributes}><${tag} message="${escapeXml(message)}">${escapeXml(message)}</${tag}></testcase>`;
};

/**
 * Generates deterministic configured-order JUnit bytes plus an integrity hash for atomic publication.
 * Completion order remains available in events and does not make the persisted report nondeterministic.
 */
const createEvalJUnitPayload = (
  runId: string,
  cases: readonly NormalizedEvalCaseResult[],
): EvalJUnitPayload => {
  const configuredCases = [...cases].sort(
    (left, right) => left.configured_index - right.configured_index,
  );
  const testIds = [...new Set(configuredCases.map((evalCase) => evalCase.test_id))].sort();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(runId)}">`,
  ];

  for (const testId of testIds) {
    const testCases = configuredCases.filter((evalCase) => evalCase.test_id === testId);
    const failures = testCases.filter(({ verdict }) => verdict === 'fail').length;
    const errors = testCases.filter(({ verdict }) => verdict === 'error').length;
    lines.push(
      `  <testsuite name="${escapeXml(testId)}" tests="${String(testCases.length)}" failures="${String(failures)}" errors="${String(errors)}">`,
      ...testCases.map(serializeCase),
      '  </testsuite>',
    );
  }
  lines.push('</testsuites>');

  const contents = lines.join('\n');
  return {
    contents,
    byte_length: Buffer.byteLength(contents, 'utf8'),
    sha256: createHash('sha256').update(contents, 'utf8').digest('hex'),
  };
};

export { createEvalJUnitPayload };
