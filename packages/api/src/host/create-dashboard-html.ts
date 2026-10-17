import type { DashboardBootstrap } from '../contract/bootstrap.js';

const MODULE_SCRIPT_MARKER = '<script type="module"';

/** Makes the same bootstrap available before either hosted or offline dashboard code starts. */
const createDashboardHtml = (dashboardHtml: string, bootstrap: DashboardBootstrap): string => {
  if (!dashboardHtml.includes(MODULE_SCRIPT_MARKER)) {
    throw new Error('The embedded dashboard does not contain its module script marker.');
  }

  const serialized = JSON.stringify(bootstrap)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

  const preload = `<script>window.__ATTEST_BOOTSTRAP__=${serialized};</script>\n    `;

  return dashboardHtml.replace(MODULE_SCRIPT_MARKER, () => `${preload}${MODULE_SCRIPT_MARKER}`);
};

export { createDashboardHtml };
