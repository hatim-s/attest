import { EvalResolutionError } from './resolution-project.js';

const pythonModules = new Set([
  '__future__',
  'base64',
  'collections',
  'dataclasses',
  'datetime',
  'decimal',
  'enum',
  'functools',
  'hashlib',
  'heapq',
  'io',
  'itertools',
  'json',
  'math',
  'operator',
  'random',
  're',
  'statistics',
  'string',
  'sys',
  'time',
  'typing',
  'unicodedata',
]);

/** Provides a convenience dependency preflight; runtime isolation remains the security boundary. */
const validatePortableMetricSource = (path: string, source: string): void => {
  const reject = (): never => {
    throw new EvalResolutionError(
      'project_invalid',
      `Metric source ${path} must be self-contained and use only supported runtime built-ins.`,
      {
        path,
        hint: 'Inline project helpers. Cloud alpha does not install package dependencies or upload relative imports.',
      },
    );
  };
  if (path.endsWith('.ts')) {
    // Dynamic imports cannot establish a closed dependency list before submission.
    if (/\b(?:import\s*\(|require\s*\(|eval\s*\(|Function\s*\()/u.test(source)) reject();
    const declarations = source.matchAll(
      /\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']/gu,
    );
    for (const match of declarations) {
      if (!/^(?:node:[a-zA-Z0-9_/]+|bun)$/u.test(match[1]!)) reject();
    }
    return;
  }
  if (/\b(?:__import__|exec|eval)\s*\(/u.test(source)) reject();
  for (const match of source.matchAll(
    /(?:^|[;\n])\s*(?:from\s+([^\s]+)\s+import\b|import\s+([^\n;]+))/gu,
  )) {
    const modules =
      match[1] === undefined
        ? match[2]!.split(',').map((entry) => entry.trim().split(/\s/u)[0]!)
        : [match[1]];
    if (modules.some((module) => !pythonModules.has(module.split('.')[0]!))) reject();
  }
};

export { validatePortableMetricSource };
