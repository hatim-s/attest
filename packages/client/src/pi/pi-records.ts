import type { JsonValue } from '@attest/contracts';
import { z } from 'zod';

/**
 * The Pi RPC stdout records the handler consumes, as documented in Pi 1.3's `docs/json.md` and
 * `docs/rpc.md`. Objects are loose so fields Pi adds later pass through; record types the handler
 * does not read (`message_update`, `queue_update`, compaction and extension UI records, and so on)
 * fail the union and are dropped by `parsePiRecord`.
 */

const usageSchema = z.looseObject({ input: z.number(), output: z.number() });

// Text, thinking and tool call blocks; only text blocks carry `text`.
const contentBlockSchema = z.looseObject({ type: z.string(), text: z.string().optional() });

const assistantMessageSchema = z.looseObject({
  role: z.literal('assistant'),
  content: z.array(contentBlockSchema),
  model: z.string(),
  responseModel: z.string().optional(),
  usage: usageSchema,
  stopReason: z.string(),
  errorMessage: z.string().optional(),
});

// User, tool result and custom messages become `null`: the handler only reads assistant ones.
const messageSchema = z.union([
  assistantMessageSchema,
  z.looseObject({ role: z.string() }).transform(() => null),
]);

const piRecordSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('response'),
    id: z.string().optional(),
    command: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    data: z.looseObject({ disposition: z.string().optional() }).optional(),
  }),
  z.looseObject({ type: z.literal('agent_start') }),
  z.looseObject({ type: z.literal('agent_settled'), aborted: z.boolean() }),
  z.looseObject({ type: z.literal('turn_start') }),
  z.looseObject({ type: z.literal('turn_end') }),
  z.looseObject({ type: z.literal('message_end'), message: messageSchema }),
  z.looseObject({
    type: z.literal('tool_execution_start'),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.json(),
  }),
  z.looseObject({
    type: z.literal('tool_execution_end'),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.json(),
    isError: z.boolean(),
    durationMs: z.number().optional(),
  }),
  z.looseObject({
    type: z.literal('auto_retry_start'),
    attempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorMessage: z.string(),
  }),
  z.looseObject({
    type: z.literal('auto_retry_end'),
    success: z.boolean(),
    attempt: z.number(),
    finalError: z.string().optional(),
  }),
]);

type PiRecord = z.infer<typeof piRecordSchema>;

type PiAssistantMessage = z.infer<typeof assistantMessageSchema>;

/** Parses one stdout line. Non-JSON lines and records the handler does not read return `undefined`. */
const parsePiRecord = (line: string): PiRecord | undefined => {
  try {
    const parsed = piRecordSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

// Pi tools return `{ content: [{ type: 'text', text }], details }`; an error's text is its message.
const toolResultSchema = z.looseObject({ content: z.array(contentBlockSchema) });

/** The first text block of a tool result, or `undefined` when the result has another form. */
const toolResultText = (result: JsonValue): string | undefined => {
  const parsed = toolResultSchema.safeParse(result);

  return parsed.success
    ? parsed.data.content.find((block) => block.text !== undefined)?.text
    : undefined;
};

/** Joins an assistant message's text blocks in order, skipping thinking and tool call blocks. */
const assistantText = (message: PiAssistantMessage): string =>
  message.content
    .flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
    .join('');

export { assistantText, parsePiRecord, toolResultText, type PiAssistantMessage, type PiRecord };
