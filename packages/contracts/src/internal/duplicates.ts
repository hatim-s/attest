import type { z } from 'zod';

type DuplicateCheck = {
  values: readonly string[];
  /** Builds the issue path for the value at `index`. */
  pathFor: (index: number) => PropertyKey[];
  label: string;
  context: z.RefinementCtx;
};

/**
 * Reports every repeat of an earlier value. Each repeat gets its own issue so editors can point
 * at the offending entry instead of the list.
 */
const reportDuplicates = ({ values, pathFor, label, context }: DuplicateCheck): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: pathFor(index),
        message: `duplicate ${label}: ${value}`,
      });
    }
    seen.add(value);
  });
};

export { reportDuplicates };
