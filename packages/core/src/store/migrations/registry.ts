import { readFileSync } from 'node:fs';

// SQL stays in reviewable migration files; synchronous loading completes before any store opens.
const schemaVersionOneSql = readFileSync(new URL('./0001_schema_v1.sql', import.meta.url), 'utf8');

/** Registers the pre-1.0 schema history consumed by the transactional migration runner. */
const migrations = [{ version: 1, name: 'schema_v1', sql: schemaVersionOneSql }] as const;

export { migrations };
