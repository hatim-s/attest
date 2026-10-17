import { describe, expect, it } from 'vitest';
import { createDashboardHtml } from '../create-dashboard-html.js';

const html = '<html><head><script type="module">boot()</script></head></html>';

describe('createDashboardHtml', () => {
  it('injects the bootstrap before the deferred dashboard module', () => {
    const result = createDashboardHtml(html, { kind: 'http', baseUrl: '/api' });
    expect(result).toContain('</script>\n    <script type="module">boot()');
    expect(result).toContain('{"kind":"http","baseUrl":"/api"}');
  });
  it('escapes script terminators and JavaScript line separators', () => {
    const result = createDashboardHtml(html, { kind: 'http', baseUrl: '</script>\u2028\u2029' });
    expect(result).toContain(String.raw`\u003c/script>\u2028\u2029`);
    expect(result.match(/<\/script>/g)).toHaveLength(2);
  });
  it('rejects HTML that cannot boot the dashboard', () => {
    expect(() => createDashboardHtml('<html></html>', { kind: 'http', baseUrl: '/api' })).toThrow(
      'The embedded dashboard does not contain its module script marker.',
    );
  });
});
