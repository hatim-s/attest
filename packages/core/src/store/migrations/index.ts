import { readFileSync } from 'node:fs';

const schemaVersionOneSql = readFileSync(new URL('./0001_schema_v1.sql', import.meta.url), 'utf8');

/** Lists ordered, immutable SQL migrations for the schema-v1 runner (PLAN 1S.2). */
const migrations = [{ version: 1, name: 'schema_v1', sql: schemaVersionOneSql }] as const;

export { migrations };
