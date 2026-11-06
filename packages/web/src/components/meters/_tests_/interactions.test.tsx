// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CaseStrip, type CaseStripRecord } from '../case-strip.js';
import { ProportionMeter } from '../proportion-meter.js';

/** Flush React work before inspecting focus and updated props. */
async function settle(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

it('keeps one tab stop, moves by arrows and boundaries, and recovers focus after removal', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const records: CaseStripRecord[] = [
    { id: 'a', label: 'A', verdict: 'pass', href: '#a' },
    { id: 'b', label: 'B', verdict: 'fail', href: '#b' },
    { id: 'c', label: 'C', verdict: 'not-run' },
  ];

  try {
    await settle(() => root.render(<CaseStrip records={records} label="Cases" />));
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await settle(() => {
      container.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('href')).toBe('#b');
    await settle(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      ),
    );
    expect(document.activeElement?.getAttribute('aria-label')).toContain('no recorded result');
    expect(document.activeElement?.hasAttribute('href')).toBe(false);
    expect(document.activeElement?.getAttribute('role')).toBe('img');
    await settle(() => root.render(<CaseStrip records={records.slice(0, 2)} label="Cases" />));
    expect(document.activeElement?.getAttribute('href')).toBe('#a');
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  } finally {
    await settle(() => root.unmount());
    container.remove();
  }
});

it('shows the unknown remainder even when every known case passed', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);

  try {
    await settle(() =>
      root.render(
        <ProportionMeter
          label="Unknown"
          counts={{ passed: 100, failed: 0, errored: 0, skipped: 0, notRun: null }}
        />,
      ),
    );
    expect(container.textContent).toContain('remainder unknown');
    expect(container.querySelectorAll('.pass')).toHaveLength(40);
  } finally {
    await settle(() => root.unmount());
  }
});

it('keeps live verdict identity focus without reclaiming focus after explicit departure', async () => {
  const container = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(container, outside);
  const root = createRoot(container);
  const absent: CaseStripRecord = { id: 'a', label: 'A', verdict: 'not-run' };
  const result: CaseStripRecord = { id: 'a', label: 'A', verdict: 'pass', href: '#a' };
  const b: CaseStripRecord = { id: 'b', label: 'B', verdict: 'pass', href: '#b' };

  const render = (records: CaseStripRecord[]) =>
    root.render(<CaseStrip records={records} label="Cases" />);

  try {
    await settle(() => render([absent, b]));
    const original = container.querySelector<HTMLElement>('[tabindex="0"]')!;
    await settle(() => original.focus());
    await settle(() => render([result, b]));
    expect(document.activeElement).toBe(original);
    expect(original.getAttribute('href')).toBe('#a');
    await settle(() => render([b, result]));
    expect(document.activeElement).toBe(original);
    await settle(() => render([b]));
    expect(document.activeElement?.getAttribute('href')).toBe('#b');
    await settle(() => container.querySelector<HTMLElement>('[tabindex="0"]')?.blur());
    expect(document.activeElement).toBe(document.body);
    await settle(() => render([result]));
    expect(document.activeElement).toBe(document.body);
    await settle(() => container.querySelector<HTMLElement>('[tabindex="0"]')?.focus());
    await settle(() => outside.focus());
    await settle(() => render([b]));
    expect(document.activeElement).toBe(outside);
    await settle(() => container.querySelector<HTMLElement>('[tabindex="0"]')?.focus());
    await settle(() => render([absent]));
    expect(document.activeElement?.getAttribute('aria-label')).toContain('no recorded result');
  } finally {
    await settle(() => root.unmount());
    container.remove();
    outside.remove();
  }
});

it('revokes strip ownership on null-target blur before a later polling deletion', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const records: CaseStripRecord[] = [
    { id: 'a', label: 'A', verdict: 'pass', href: '#a' },
    { id: 'b', label: 'B', verdict: 'pass', href: '#b' },
  ];

  try {
    await settle(() => root.render(<CaseStrip records={records} label="Cases" />));
    const mark = container.querySelector<HTMLElement>('[tabindex="0"]')!;
    await settle(() => mark.focus());
    await settle(() => mark.blur());
    expect(document.activeElement).toBe(document.body);
    await settle(() => root.render(<CaseStrip records={records.slice(1)} label="Cases" />));
    expect(document.activeElement).toBe(document.body);
  } finally {
    await settle(() => root.unmount());
    container.remove();
  }
});
