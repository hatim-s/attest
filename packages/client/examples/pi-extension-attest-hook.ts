/**
 * A Pi extension that posts the attest completion from inside Pi once the run settles. Use it
 * when something other than `@attest/client` starts Pi for an attest callback trigger: pass the
 * trigger's callback and ids through the environment and load the extension explicitly.
 *
 *   ATTEST_CALLBACK_URL=... ATTEST_CALLBACK_TOKEN=... ATTEST_RUN_ID=... ATTEST_CASE_ID=... \
 *     pi --no-session -e ./pi-extension-attest-hook.ts -p "the case prompt"
 *
 * It reports the last assistant message's text, or its error. Artifacts and traces are left to
 * the `@attest/client` runner, which sees the whole RPC stream and the workspace.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function attestCompletionHook(pi: ExtensionAPI): void {
  const url = process.env.ATTEST_CALLBACK_URL;
  const token = process.env.ATTEST_CALLBACK_TOKEN;
  const runId = process.env.ATTEST_RUN_ID;
  const caseId = process.env.ATTEST_CASE_ID;

  if (!url || !token || !runId || !caseId) {
    console.error(
      '[attest-hook] ATTEST_CALLBACK_URL, _TOKEN, ATTEST_RUN_ID and ATTEST_CASE_ID are required.',
    );

    return;
  }

  let text = '';
  let failure: string | undefined;
  let posted = false;

  pi.on('message_end', (event) => {
    const message = event.message;

    if (message.role !== 'assistant') return;
    text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    failure =
      message.stopReason === 'error' || message.stopReason === 'aborted'
        ? (message.errorMessage ?? `stopReason ${message.stopReason}`)
        : undefined;
  });

  // agent_settled, not agent_end: retries and queued follow-ups can still run after agent_end.
  pi.on('agent_settled', async (event) => {
    if (posted) return;
    posted = true;

    const outcome =
      event.aborted || failure !== undefined
        ? { error: { code: 'pi_agent_failed', message: failure ?? 'Pi aborted the run.' } }
        : { output: text };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: 'attest.agent-completion',
          run_id: runId,
          case_id: caseId,
          ...outcome,
        }),
        // Never hold up Pi's shutdown on an unreachable receiver.
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) console.error(`[attest-hook] receiver answered ${response.status}`);
    } catch (error) {
      console.error('[attest-hook] completion not delivered:', error);
    }
  });
}
