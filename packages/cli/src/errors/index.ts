export { AttestCliError, type AttestCliErrorOptions } from './attest-cli-error.js';
export {
  CLI_ERROR_DEFINITIONS,
  createCliErrorCatalog,
  getCliErrorDefinition,
  type CliErrorCode,
} from './error-catalog.js';
export { renderCliError, serializeCliError, type SerializedCliFailure } from './serialize-error.js';
export { renderCliErrorCatalog } from './render-error-catalog.js';
