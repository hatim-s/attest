import type { ProjectRecord } from '@attest/core/records';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ProjectSwitcher } from '../components/projects/project-switcher.js';

const demo: ProjectRecord = { key: 'demo', name: 'Demo' };

const other: ProjectRecord = { key: 'other', name: 'Other' };

const render = (projects: ProjectRecord[]) =>
  renderToStaticMarkup(
    <ProjectSwitcher projects={projects} projectKey="demo" onSelect={() => undefined} />,
  );

it('hides the switcher when the catalog has one project and lists every project otherwise', () => {
  expect(render([demo])).toBe('');

  const markup = render([demo, other]);

  expect(markup).toContain('<select');
  expect(markup.match(/<option/g)).toHaveLength(3);
  expect(markup).toContain('All projects');
});
