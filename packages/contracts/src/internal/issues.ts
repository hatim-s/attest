import type { z } from 'zod';

import type { ContractIssue } from '../parse.js';

const formatPath = (path: PropertyKey[]): string => {
  if (path.length === 0) {
    return '$';
  }

  return path.map(String).join('.');
};

/** Converts Zod diagnostics into the stable, dependency-free issue shape exposed by parsers. */
const formatContractIssues = (issues: z.core.$ZodIssue[]): ContractIssue[] =>
  issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: formatPath([...issue.path, key]),
        message: issue.message,
      }));
    }

    return { path: formatPath(issue.path), message: issue.message };
  });

export { formatContractIssues };
