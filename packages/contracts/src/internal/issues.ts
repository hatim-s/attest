import type { z } from 'zod';

/** Describes one actionable contract violation without exposing Zod publicly. */
type ContractIssue = { path: string; message: string };

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

export { formatContractIssues, type ContractIssue };
