/** Native Bun SQLite methods used by the scoped store handle. */
declare module 'bun:sqlite' {
  class Database {
    constructor(path: string, options: { readonly?: boolean; create: boolean });
    prepare(sql: string): {
      all(...parameters: import('./sqlite-handle.js').SqliteValue[]): unknown[];
      run(...parameters: import('./sqlite-handle.js').SqliteValue[]): { changes: number | bigint };
      finalize(): void;
    };
    exec(sql: string): void;
    close(throwOnError: boolean): void;
  }

  export { Database };
}
