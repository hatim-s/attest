import { foreignMessage } from '@attest/contracts';
import * as Data from 'effect/Data';

/** Reasons whose message is fixed text. */
type FixedReason =
  | 'environment_disposed'
  | 'environment_poisoned'
  | 'environment_finalizing'
  | 'phase_changed'
  | 'sandbox_prepare_failed'
  | 'sandbox_stop_unconfirmed'
  | 'command_output_too_large'
  | 'file_too_large';

/** Reasons whose message names the rejected `path`. */
type PathReason =
  | 'file_missing'
  | 'host_path_escape'
  | 'host_path_symlink'
  | 'upload_not_regular_file'
  | 'artifact_root_escape'
  | 'artifact_parent_escape';

/** Reasons that wrap a foreign rejection or abort reason and pass its Error message through. */
type PassthroughReason =
  | 'case_acquisition_aborted'
  | 'case_operation_aborted'
  | 'sandbox_acquisition_aborted'
  | 'seed_files_invalid'
  | 'sandbox_seed_failed'
  | 'sandbox_credentials_failed'
  | 'artifact_destination_invalid'
  | 'foreign_operation_failed';

type EnvironmentErrorReason = FixedReason | PathReason | PassthroughReason;

/** The facts each reason group carries: path reasons add `path`, passthrough reasons `cause`. */
type FactsByReason = Record<FixedReason, { readonly reason: FixedReason }> &
  Record<PathReason, { readonly reason: PathReason; readonly path: string }> &
  Record<PassthroughReason, { readonly reason: PassthroughReason; readonly cause: unknown }>;

/** Constructor input: path reasons require `path`, passthrough reasons require `cause`. */
type EnvironmentErrorInput<R extends EnvironmentErrorReason = EnvironmentErrorReason> = {
  [K in R]: FactsByReason[K] & { readonly reason: K };
}[R];

/** Renders each reason's message from exactly the facts that reason requires. */
type MessageTable = { readonly [R in EnvironmentErrorReason]: (facts: FactsByReason[R]) => string };

/**
 * One message per reason. Path reasons name the rejected path; passthrough reasons use the cause's
 * own Error message and fall back to fixed text for non-Error rejections and abort reasons.
 */
const MESSAGES: MessageTable = {
  environment_disposed: () => 'Case environment has been disposed.',
  environment_poisoned: () => 'Case environment has been poisoned.',
  environment_finalizing: () => 'Case environment finalization is starting.',
  phase_changed: () => 'Case phase changed.',
  sandbox_prepare_failed: () => 'Could not prepare case sandbox.',
  sandbox_stop_unconfirmed: () => 'Sandbox stop was not confirmed before cleanup timed out.',
  command_output_too_large: () => 'Sandbox command output exceeds outputBytes.',
  file_too_large: () => 'Sandbox file exceeds outputBytes.',
  file_missing: ({ path }) => `Sandbox file does not exist: ${path}`,
  host_path_escape: ({ path }) => `Host path escapes its root: ${path}`,
  host_path_symlink: ({ path }) => `Host path contains a symbolic link: ${path}`,
  upload_not_regular_file: ({ path }) => `Sandbox upload is not a regular file: ${path}`,
  artifact_root_escape: ({ path }) => `Artifact root escapes the project root: ${path}`,
  artifact_parent_escape: ({ path }) => `Artifact parent escapes the project root: ${path}`,
  case_acquisition_aborted: ({ cause }) => foreignMessage(cause, 'Case acquisition aborted.'),
  case_operation_aborted: ({ cause }) => foreignMessage(cause, 'Case operation aborted.'),
  sandbox_acquisition_aborted: ({ cause }) => foreignMessage(cause, 'Sandbox acquisition aborted.'),
  seed_files_invalid: ({ cause }) => foreignMessage(cause, 'Invalid seed files.'),
  sandbox_seed_failed: ({ cause }) => foreignMessage(cause, 'Sandbox seed failed.'),
  sandbox_credentials_failed: ({ cause }) => foreignMessage(cause, 'Sandbox credentials failed.'),
  artifact_destination_invalid: ({ cause }) =>
    foreignMessage(cause, 'Invalid artifact destination.'),
  foreign_operation_failed: ({ cause }) => foreignMessage(cause, 'Foreign operation failed.'),
};

/** Renders the message for one input; the generic keeps reason and facts correlated. */
const render = <R extends EnvironmentErrorReason>(input: EnvironmentErrorInput<R>): string =>
  MESSAGES[input.reason](input);

/**
 * A case environment or sandbox step failed: a foreign SDK or filesystem call rejected, the caller
 * aborted, a path was rejected, or the environment refused admission. `cause` keeps the original
 * value, so cleanup flags and errno codes stay readable through the cause chain.
 */
class EnvironmentOperationError extends Data.TaggedError('EnvironmentOperationError')<{
  readonly reason: EnvironmentErrorReason;
  readonly path?: string;
  readonly cause?: unknown;
}> {
  override readonly message: string;

  constructor(input: EnvironmentErrorInput) {
    super(input);
    this.message = render(input);
  }

  /** Wraps a foreign rejection or abort reason as `cause` under one of the passthrough reasons. */
  static from(cause: unknown, reason: PassthroughReason): EnvironmentOperationError {
    return new EnvironmentOperationError({ reason, cause });
  }
}

export { EnvironmentOperationError };
