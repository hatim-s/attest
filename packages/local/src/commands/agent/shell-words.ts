type ShellWordsProblem = 'shell_control' | 'shell_expansion' | 'unclosed_quote';

/** Reports why a command string cannot be split into literal words. */
class ShellWordsError extends Error {
  readonly problem: ShellWordsProblem;

  constructor(problem: ShellWordsProblem) {
    super(`Command text cannot be split into literal words: ${problem}.`);
    this.name = 'ShellWordsError';
    this.problem = problem;
  }
}

type SplitShellWordsOptions = {
  /** Rejects `;`, `|`, `<`, `>`, `&&`, backticks, and `$(`/`${` instead of keeping them literal. */
  rejectShellControl: boolean;
};

const isShellControl = (character: string, next: string | undefined): boolean =>
  character === ';' ||
  character === '|' ||
  character === '<' ||
  character === '>' ||
  (character === '&' && next === '&');

/**
 * Splits command text into argv words the way a POSIX shell quotes them, without expanding or
 * executing anything. Backslash-newline joins lines, as in a pasted multi-line cURL command.
 */
const splitShellWords = (source: string, options: SplitShellWordsOptions): string[] => {
  const words: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: 'double' | 'single' | undefined;
  const endWord = (): void => {
    if (!wordStarted) return;
    words.push(word);
    word = '';
    wordStarted = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    const expansion = character === '`' || (character === '$' && (next === '(' || next === '{'));
    if (options.rejectShellControl && expansion) throw new ShellWordsError('shell_expansion');
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else word += character;
      wordStarted = true;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = undefined;
      else if (character === '\\' && next !== undefined) word += source[++index]!;
      else word += character;
      wordStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? 'single' : 'double';
      wordStarted = true;
      continue;
    }
    if (character === '\\' && (next === '\n' || (next === '\r' && source[index + 2] === '\n'))) {
      index += next === '\r' ? 2 : 1;
      continue;
    }
    if (character === '\\' && next !== undefined) {
      word += source[++index]!;
      wordStarted = true;
      continue;
    }
    if (options.rejectShellControl && isShellControl(character, next)) {
      throw new ShellWordsError('shell_control');
    }
    if (/\s/u.test(character)) {
      endWord();
      continue;
    }
    word += character;
    wordStarted = true;
  }
  if (quote !== undefined) throw new ShellWordsError('unclosed_quote');
  endWord();
  return words;
};

export { ShellWordsError, splitShellWords };
