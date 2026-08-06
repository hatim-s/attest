import {
  caseSchema,
  type CaseDefinition,
  type ContractIssue,
  type Result,
} from '@attest/contracts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type DatasetCaseRecord = { caseDefinition: CaseDefinition; lineNumber: number };
type DatasetInspection = { records: DatasetCaseRecord[]; issues: ContractIssue[] };

const issue = (lineNumber: number, message: string): ContractIssue => ({
  path: `line ${lineNumber}`,
  message,
});

/** Maps canonical case-schema failures to physical JSONL line diagnostics. */
const schemaIssue = (lineNumber: number, path: PropertyKey[], message: string): ContractIssue => ({
  path: `line ${lineNumber}: ${path.length === 0 ? '<root>' : path.map(String).join('.')}`,
  message,
});

const readDataset = async (datasetPath: string): Promise<Result<string, ContractIssue[]>> => {
  try {
    return { ok: true, value: await readFile(datasetPath, 'utf8') };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown file read failure';
    return { ok: false, error: [{ path: datasetPath, message }] };
  }
};

/**
 * Loads and structurally validates every JSONL case using the case-field semantics documented in
 * docs/specs/config-format.md. All line diagnostics are collected before returning so configuration
 * failures remain actionable and no agent can be invoked from a partially valid dataset.
 */
const inspectDatasetCases = async (
  datasetPath: string,
  baseDirectory: string,
): Promise<DatasetInspection> => {
  const resolvedPath = resolve(baseDirectory, datasetPath);
  const document = await readDataset(resolvedPath);
  if (!document.ok) {
    return { records: [], issues: document.error };
  }

  const records: DatasetCaseRecord[] = [];
  const issues: ContractIssue[] = [];
  const seenCaseIds = new Set<string>();
  const lines = document.value.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    const lineNumber = lineIndex + 1;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid JSON';
      issues.push(issue(lineNumber, message));
      continue;
    }

    const parsedCase = caseSchema.safeParse(candidate);
    if (!parsedCase.success) {
      issues.push(
        ...parsedCase.error.issues.map((caseIssue) =>
          schemaIssue(lineNumber, caseIssue.path, caseIssue.message),
        ),
      );
    } else {
      const caseDefinition = parsedCase.data;
      if (seenCaseIds.has(caseDefinition.id)) {
        issues.push(issue(lineNumber, `duplicate case id "${caseDefinition.id}"`));
      } else {
        seenCaseIds.add(caseDefinition.id);
        records.push({ caseDefinition, lineNumber });
      }
    }
  }

  return { records, issues };
};

/** Preserves the public cases-only loader while execution uses line-aware inspection diagnostics. */
const loadDatasetCases = async (
  datasetPath: string,
  baseDirectory: string,
): Promise<Result<CaseDefinition[], ContractIssue[]>> => {
  const inspection = await inspectDatasetCases(datasetPath, baseDirectory);
  return inspection.issues.length === 0
    ? { ok: true, value: inspection.records.map(({ caseDefinition }) => caseDefinition) }
    : { ok: false, error: inspection.issues };
};

export { inspectDatasetCases, loadDatasetCases, type DatasetCaseRecord, type DatasetInspection };
