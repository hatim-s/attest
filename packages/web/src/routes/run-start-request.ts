import type { RunStartRequest } from '@attest/core/records';

type RunSelection = RunStartRequest['selection'];

/** The new-run form as typed, before it becomes a request. Number fields are raw input text. */
type RunStartForm = {
  selection: RunSelection;
  tags: string;
  concurrency: string;
  timeoutSeconds: string;
};

/**
 * Turns the checklist into a selection. With nothing unchecked the run selects every test, so a
 * test added after the form opened still runs. Otherwise it names the checked tests in list order.
 * Returns `undefined` when nothing is checked, which is not a run.
 */
const selectTests = (
  testIds: readonly string[],
  unchecked: ReadonlySet<string>,
): RunSelection | undefined => {
  const [first, ...rest] = testIds.filter((id) => !unchecked.has(id));

  if (first === undefined) return undefined;

  if (rest.length + 1 === testIds.length) return { all: true };

  return { testIds: [first, ...rest] };
};

/** A blank field means the project default, so it stays out of the request. */
const optionalNumber = (value: string): number | undefined =>
  value.trim() === '' ? undefined : Number(value);

/**
 * Maps the form to the start request. Tags split on commas and blank ones drop out; blank number
 * fields are omitted. The form asks for seconds and the request carries milliseconds.
 */
const toRunStartRequest = (form: RunStartForm): RunStartRequest => {
  const [firstTag, ...otherTags] = form.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');

  const concurrency = optionalNumber(form.concurrency);
  const timeoutSeconds = optionalNumber(form.timeoutSeconds);
  const request: RunStartRequest = { selection: form.selection };

  if (firstTag !== undefined) request.tags = [firstTag, ...otherTags];

  if (concurrency !== undefined) request.concurrency = concurrency;

  if (timeoutSeconds !== undefined) request.timeoutMs = timeoutSeconds * 1000;

  return request;
};

export { selectTests, toRunStartRequest, type RunStartForm };
