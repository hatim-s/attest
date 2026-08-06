import type { CaseDefinition, ContractIssue, Result } from '@attest/contracts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CASE_FIELDS = new Set(['id', 'input', 'expected', 'params', 'metrics']);

type UnknownRecord = Record<string, unknown>;

type DatasetCaseRecord = { caseDefinition: CaseDefinition; lineNumber: number };
type DatasetInspection = { records: DatasetCaseRecord[]; issues: ContractIssue[] };

const isRecord = (value: unknown): value is UnknownRecord => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const issue = (lineNumber: number, message: string): ContractIssue => ({
  path: `line ${lineNumber}`,
  message,
});

const validateStringArray = (value: unknown): boolean => {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
};

const validateCase = (candidate: unknown, lineNumber: number): ContractIssue[] => {
  if (!isRecord(candidate)) {
    return [issue(lineNumber, 'case must be a JSON object')];
  }

  const issues: ContractIssue[] = [];
  if (typeof candidate.id !== 'string') {
    issues.push(issue(lineNumber, 'id must be a string'));
  }
  if (!Object.hasOwn(candidate, 'input')) {
    issues.push(issue(lineNumber, 'input is required'));
  }
  if (candidate.params !== undefined && !isRecord(candidate.params)) {
    issues.push(issue(lineNumber, 'params must be an object'));
  }
  if (candidate.metrics !== undefined && !validateStringArray(candidate.metrics)) {
    issues.push(issue(lineNumber, 'metrics must be an array of strings'));
  }

  for (const fieldName of Object.keys(candidate)) {
    if (!CASE_FIELDS.has(fieldName)) {
      issues.push(issue(lineNumber, `unknown case field: ${fieldName}`));
    }
  }
  return issues;
};

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

    const lineIssues = validateCase(candidate, lineNumber);
    issues.push(...lineIssues);
    if (lineIssues.length === 0) {
      const caseDefinition = candidate as CaseDefinition;
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
