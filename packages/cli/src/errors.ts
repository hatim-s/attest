export { AttestCliError, type AttestCliErrorOptions } from './errors/attest-cli-error.js';
export {
  CLI_ERROR_DEFINITIONS,
  createCliErrorCatalog,
  getCliErrorDefinition,
  type CliErrorCode,
} from './errors/error-catalog.js';
export {
  renderCliError,
  serializeCliError,
  type SerializedCliFailure,
} from './errors/serialize-error.js';
export { renderCliErrorCatalog } from './errors/render-error-catalog.js';
