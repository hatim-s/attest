import type { CaseRecord, RunRecord, StoredMetricEvaluation } from '../store/types.js';
import { computeCaseVerdict } from './classify.js';

/** Retains only XML 1.0-permitted Unicode code points before escaping markup. */
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

const escapeXml = (value: string): string =>
  stripInvalidXmlCodePoints(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const compareText = (left: string, right: string): number =>
  (left > right ? 1 : 0) - (left < right ? 1 : 0);

const failingMetricNames = (caseRecord: CaseRecord): string[] =>
  caseRecord.metrics
    .filter((metric) => metric.status === 'evaluated' && metric.pass !== true)
    .map((metric) => metric.metricName)
    .toSorted();

const metricErrorMessages = (metrics: StoredMetricEvaluation[]): string[] =>
  metrics
    .filter((metric) => metric.status === 'error')
    .map(
      (metric) =>
        `${metric.metricName}: ${metric.error?.message ?? 'metric evaluation failed without a message'}`,
    )
    .toSorted();

const errorMessage = (caseRecord: CaseRecord): string => {
  const messages: string[] = [];
  if (caseRecord.outcome !== 'completed') {
    messages.push(`${caseRecord.errorCode}: ${caseRecord.errorMessage}`);
  }
  messages.push(...metricErrorMessages(caseRecord.metrics));
  return messages.join('; ');
};

const serializeTestCase = (caseRecord: CaseRecord): string => {
  const attributes =
    `name="${escapeXml(caseRecord.caseId)}" classname="${escapeXml(caseRecord.suiteName)}" ` +
    `time="${caseRecord.durationMs / 1000}"`;
  const verdict = computeCaseVerdict(caseRecord);
  if (verdict === 'pass') {
    return `    <testcase ${attributes}/>`;
  }
  if (verdict === 'fail') {
    const message = `failing metrics: ${failingMetricNames(caseRecord).join(', ')}`;
    return `    <testcase ${attributes}><failure message="${escapeXml(message)}">${escapeXml(message)}</failure></testcase>`;
  }

  const message = errorMessage(caseRecord);
  return `    <testcase ${attributes}><error message="${escapeXml(message)}">${escapeXml(message)}</error></testcase>`;
};

/** Emits deterministic dependency-free JUnit XML for a run. */
const runToJUnitXml = (run: RunRecord, cases: CaseRecord[]): string => {
  const suites = new Map<string, CaseRecord[]>();
  for (const caseRecord of cases) {
    const suiteCases = suites.get(caseRecord.suiteName) ?? [];
    suiteCases.push(caseRecord);
    suites.set(caseRecord.suiteName, suiteCases);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(run.id)}">`,
  ];
  for (const suiteName of [...suites.keys()].toSorted()) {
    const suiteCases = (suites.get(suiteName) ?? []).toSorted((left, right) =>
      compareText(left.caseId, right.caseId),
    );
    const failures = suiteCases.filter(
      (caseRecord) => computeCaseVerdict(caseRecord) === 'fail',
    ).length;
    const errors = suiteCases.filter(
      (caseRecord) => computeCaseVerdict(caseRecord) === 'error',
    ).length;
    lines.push(
      `  <testsuite name="${escapeXml(suiteName)}" tests="${suiteCases.length}" failures="${failures}" errors="${errors}">`,
      ...suiteCases.map(serializeTestCase),
      '  </testsuite>',
    );
  }
  lines.push('</testsuites>');
  return lines.join('\n');
};

export { runToJUnitXml };
