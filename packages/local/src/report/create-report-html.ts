import type { CaseRecord, CaseSummary, RunRecord } from '@attest/core';
import type { JsonValue } from '@attest/contracts';

type ReportData = {
  schema: 'attest.report';
  generatedAt: string;
  run: RunRecord;
  cases: { record: CaseRecord; summary: CaseSummary }[];
  truncated: boolean;
};

const MODULE_SCRIPT_MARKER = '<script type="module"';

/** Serializes JSON for an inline script without allowing data to terminate the script element. */
const serializeForInlineScript = (value: JsonValue | ReportData): string =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

/** Injects report data before the deferred dashboard module boots. */
const createReportHtml = (dashboardHtml: string, reportData: JsonValue | ReportData): string => {
  if (!dashboardHtml.includes(MODULE_SCRIPT_MARKER)) {
    throw new Error('The embedded dashboard does not contain its module script marker.');
  }

  const preload = `<script>window.__ATTEST_REPORT__=${serializeForInlineScript(reportData)};</script>\n    `;

  return dashboardHtml.replace(MODULE_SCRIPT_MARKER, `${preload}${MODULE_SCRIPT_MARKER}`);
};

export { createReportHtml, serializeForInlineScript, type ReportData };
