import { ShellWordsError, splitShellWords } from './shell-words.js';

/** A cURL import failure with machine-readable diagnostic codes for the CLI. */
class CurlImportError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: readonly string[]) {
    super(message);
    this.name = 'CurlImportError';
    this.diagnostics = [...diagnostics];
  }
}

const SHELL_WORDS_MESSAGES = {
  shell_control: 'The cURL input contains shell control syntax.',
  shell_expansion: 'The cURL input contains shell expansion.',
  unclosed_quote: 'The cURL input contains an unclosed quote.',
} as const;

/** Tokenizes a cURL command as inert data and rejects every shell control construct. */
const tokenizeCurl = (source: string): string[] => {
  try {
    return splitShellWords(source, { rejectShellControl: true });
  } catch (error: unknown) {
    if (!(error instanceof ShellWordsError)) throw error;
    throw new CurlImportError(SHELL_WORDS_MESSAGES[error.problem], [error.problem]);
  }
};

/** Reads the value after a flag, rejecting a missing value or another flag in its place. */
const optionValue = (tokens: readonly string[], index: number, flag: string): string => {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CurlImportError(`cURL option ${flag} is missing its value.`, [
      `missing_value:${flag}`,
    ]);
  }
  return value;
};

export { CurlImportError, optionValue, tokenizeCurl };
