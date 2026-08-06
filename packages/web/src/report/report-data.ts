import type { CaseRecord, CaseSummary, RunRecord } from '../api/types.js';

type ReportCase = {
  record: CaseRecord;
  summary: CaseSummary;
};

type ReportData = {
  api_version: 'attest.report/v1';
  cases: ReportCase[];
  generatedAt: string;
  run: RunRecord;
  truncated: boolean;
};

declare global {
  interface Window {
    __ATTEST_REPORT__?: ReportData;
  }
}

/** Returns preloaded static-report data when the dashboard is not backed by a live server. */
const getReportData = (): ReportData | undefined => window.__ATTEST_REPORT__;

export { getReportData, type ReportCase, type ReportData };
