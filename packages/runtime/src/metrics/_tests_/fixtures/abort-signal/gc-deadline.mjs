import { composeAbortSignal } from '../../../internal/abort-signal.ts';

const caller = process.argv[2] === 'with-caller' ? new AbortController().signal : undefined;

const signal = composeAbortSignal(caller, 200);

const collect = setInterval(() => globalThis.gc(), 10);

const deadline = setTimeout(() => {
  clearInterval(collect);
  process.stderr.write('Metric deadline was lost after garbage collection.');
  process.exitCode = 1;
}, 1_000);

signal.addEventListener(
  'abort',
  () => {
    clearInterval(collect);
    clearTimeout(deadline);
    process.stdout.write(signal.reason.name);
  },
  { once: true },
);
