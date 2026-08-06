import { AttestMetricError } from '../errors.js';

type PathSegment = { kind: 'field'; name: string } | { kind: 'index'; index: number };

const pathSegmentPattern = /(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\])/gy;

/** Parses the validated `$`-rooted subset from spec §Paths and fails defensively if upstream validation was bypassed. */
const parsePathSegments = (path: string): PathSegment[] => {
  if (path === '$') {
    return [];
  }

  if (!path.startsWith('$')) {
    throw new AttestMetricError('invalid_path', `invalid evaluation path: ${path}`);
  }

  const segments: PathSegment[] = [];
  pathSegmentPattern.lastIndex = 1;

  while (pathSegmentPattern.lastIndex < path.length) {
    const segmentStart = pathSegmentPattern.lastIndex;
    const match = pathSegmentPattern.exec(path);
    if (match === null || match.index !== segmentStart) {
      throw new AttestMetricError('invalid_path', `invalid evaluation path: ${path}`);
    }

    const fieldName = match[1];
    if (fieldName !== undefined) {
      segments.push({ kind: 'field', name: fieldName });
      continue;
    }

    const indexText = match[2];
    if (indexText === undefined) {
      throw new AttestMetricError('invalid_path', `invalid evaluation path: ${path}`);
    }
    segments.push({ kind: 'index', index: Number(indexText) });
  }

  return segments;
};

export { parsePathSegments };
