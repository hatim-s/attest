import type { KeyboardEvent } from 'react';

/** Arrow and boundary keys move among real marks without changing selection. */
function moveChartFocus(event: KeyboardEvent<Element>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

  if (!keys.includes(event.key)) return;

  const marks = Array.from(
    event.currentTarget.closest('svg')?.querySelectorAll<SVGElement>('[data-chart-mark]') ?? [],
  );

  const index = marks.findIndex((mark) => mark === event.currentTarget);

  const next = arrowIndex(event.key, index, marks.length);

  event.preventDefault();
  marks[next]?.focus();
}

/** Shared bounded roving index for plots and identity strips. */
function arrowIndex(key: string, index: number, length: number) {
  return key === 'Home'
    ? 0
    : key === 'End'
      ? length - 1
      : Math.max(0, Math.min(length - 1, index + (key === 'ArrowRight' ? 1 : -1)));
}

export { moveChartFocus, arrowIndex };
