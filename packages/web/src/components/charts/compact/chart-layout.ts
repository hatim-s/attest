import { useLayoutEffect, useRef, useState } from 'react';

/** Measure the chart's own column so SVG units remain CSS pixels after resizing. */
function useChartWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(375);
  useLayoutEffect(() => {
    const element = ref.current;

    if (!element) return;
    const measure = () => setWidth(Math.max(1, element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/** Resolve each candidate independently, ignoring interaction state from removed records. */
function resolveActive<T>(
  records: readonly T[],
  identity: (record: T) => string,
  candidates: readonly (string | null | undefined)[],
) {
  for (const candidate of candidates) {
    const record = records.find((item) => identity(item) === candidate);

    if (record) return record;
  }

  return undefined;
}

/** Format both charts in the caller's explicit fixed-offset calendar timezone. */
function calendarDate(timestamp: number, utcOffsetMinutes: number) {
  if (
    !Number.isFinite(timestamp) ||
    !Number.isInteger(utcOffsetMinutes) ||
    utcOffsetMinutes < -720 ||
    utcOffsetMinutes > 840
  )
    throw new RangeError('Invalid chart timestamp or UTC offset');

  return new Date(timestamp + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Name the fixed offset used for every calendar label. */
function timezoneLabel(utcOffsetMinutes: number) {
  return `UTC${utcOffsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(utcOffsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(utcOffsetMinutes) % 60).padStart(2, '0')}`;
}

export { useChartWidth, resolveActive, calendarDate, timezoneLabel };
