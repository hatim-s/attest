import { type CliErrorCatalog } from '@attest/contracts';

/** Renders the versioned error registry as concise human repair guidance. */
const renderCliErrorCatalog = (catalog: CliErrorCatalog): string =>
  catalog.errors
    .map(
      (definition) =>
        `${definition.code} (exit ${definition.exit_code})\n` +
        `  ${definition.meaning}\n` +
        `  Repair: ${definition.repairs[0] ?? 'Consult structured help.'}`,
    )
    .join('\n\n');

export { renderCliErrorCatalog };
