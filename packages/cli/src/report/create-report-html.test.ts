import { describe, expect, it } from 'vitest';

import { createReportHtml, serializeForInlineScript } from './create-report-html.js';

describe('createReportHtml', () => {
  it('injects data before the deferred dashboard module', () => {
    const html = '<html><head><script type="module">boot()</script></head></html>';
    const report = createReportHtml(html, { answer: 42 });

    expect(report.indexOf('__ATTEST_REPORT__')).toBeLessThan(report.indexOf('boot()'));
    expect(report).toContain('{"answer":42}');
  });

  it('cannot terminate the preload script through report data', () => {
    expect(serializeForInlineScript({ output: '</script><script>bad()</script>' })).not.toContain(
      '</script>',
    );
  });
});
