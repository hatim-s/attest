import type { KeyboardEvent } from 'react';

/** Arrow and boundary keys move among real marks without changing selection. */
function moveChartFocus(event: KeyboardEvent<Element>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

  if (!keys.includes(event.key)) return;

  const marks = Array.from(
    event.currentTarget.closest('svg')?.querySelectorAll<SVGElement>('[data-chart-mark]') ?? [],
  );

  const index = marks.findIndex((mark) => mark === event.currentTarget);

  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? marks.length - 1
        : Math.max(0, Math.min(marks.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));

  event.preventDefault();
  marks[next]?.focus();
}

export { moveChartFocus };
