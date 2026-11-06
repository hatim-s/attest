import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type RefObject,
} from 'react';

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
  return new Date(timestamp + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Name the fixed offset used for every calendar label. */
function timezoneLabel(utcOffsetMinutes: number) {
  return `UTC${utcOffsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(utcOffsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(utcOffsetMinutes) % 60).padStart(2, '0')}`;
}

/** Inspection survives Tab to the associated action, but ends on departure or new controlled data. */
function useInspection(
  selection: string | undefined,
  windowKey: string,
  identities: readonly string[],
) {
  const [inspection, setInspection] = useState<{
    id: string;
    selection: string | undefined;
    windowKey: string;
  }>();

  useLayoutEffect(() => setInspection(undefined), [selection, windowKey]);

  useLayoutEffect(() => {
    if (inspection && !identities.includes(inspection.id)) setInspection(undefined);
  }, [identities, inspection]);

  const id =
    inspection?.selection === selection && inspection?.windowKey === windowKey
      ? inspection?.id
      : undefined;

  const inspect = (id: string) => setInspection({ id, selection, windowKey });

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      setInspection(undefined);
  };

  return { id, inspect, onBlur };
}

/** Keep owned mark focus reachable when resizing replaces sparse tab stops with a chooser. */
function useDenseFocus(dense: boolean, ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const section = ref.current;

    if (dense && section?.querySelector('svg')?.contains(document.activeElement))
      section.querySelector('select')?.focus({ preventScroll: true });
  }, [dense, ref]);
}

/** Partition bounded native hit squares by nearest mark. Equal coordinates belong to the first
 * identity; the chooser keeps every collision reachable without moving any data point. */
function nativeHitRegions(centers: readonly { x: number; y: number }[]) {
  return centers.map((center, index) => {
    let polygon = [
      { x: center.x - 24, y: center.y - 24 },
      { x: center.x + 24, y: center.y - 24 },
      { x: center.x + 24, y: center.y + 24 },
      { x: center.x - 24, y: center.y + 24 },
    ];

    for (const [otherIndex, other] of centers.entries()) {
      if (index === otherIndex) continue;

      const dx = other.x - center.x,
        dy = other.y - center.y;

      if (dx === 0 && dy === 0) {
        if (otherIndex < index) return '';
        continue;
      }

      const boundary = (other.x ** 2 + other.y ** 2 - center.x ** 2 - center.y ** 2) / 2;
      const distance = (point: { x: number; y: number }) => point.x * dx + point.y * dy - boundary;
      const clipped: typeof polygon = [];

      for (const [i, start] of polygon.entries()) {
        const end = polygon[(i + 1) % polygon.length]!;

        const a = distance(start),
          b = distance(end);

        if (a <= 0) clipped.push(start);

        if (a <= 0 !== b <= 0) {
          const t = a / (a - b);
          clipped.push({ x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) });
        }
      }

      polygon = clipped;

      if (!polygon.length) break;
    }

    return polygon.length ? `M${polygon.map(({ x, y }) => `${x},${y}`).join(' L')} Z` : '';
  });
}

/** Convert pointer coordinates into the responsive SVG's unchanged coordinate space. */
function plotPointer(event: MouseEvent<SVGSVGElement>, width: number, height: number) {
  const bounds = event.currentTarget.getBoundingClientRect();

  return {
    x: ((event.clientX - bounds.left) * width) / bounds.width,
    y: ((event.clientY - bounds.top) * height) / bounds.height,
  };
}

/** Bound long identities only on the axis; all actions and readouts retain the full ID. */
function axisIdentity(id: string) {
  return id.length > 12 ? `${id.slice(0, 5)}…${id.slice(-5)}` : id;
}

/** Include milliseconds so adjacent same-day runs remain distinguishable. */
function calendarTime(timestamp: number, utcOffsetMinutes: number) {
  return new Date(timestamp + utcOffsetMinutes * 60_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, -1);
}

export {
  useChartWidth,
  useDenseFocus,
  nativeHitRegions,
  resolveActive,
  calendarDate,
  calendarTime,
  timezoneLabel,
  useInspection,
  plotPointer,
  axisIdentity,
};
