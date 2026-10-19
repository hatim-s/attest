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

// User, tool result and custom messages become `null`: the handler only reads assistant ones. An
// assistant message that fails its schema fails the record instead of passing as `null`.
const messageSchema = z.union([
  assistantMessageSchema,
  z.looseObject({ role: z.string().refine((role) => role !== 'assistant') }).transform(() => null),
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

const HANDLED_TYPES: ReadonlySet<string> = new Set(
  piRecordSchema.options.map((option) => option.shape.type.value),
);

const recordTypeSchema = z.looseObject({ type: z.string() });

/** `record` is `undefined` for lines the handler does not read; `ok: false` is a broken record. */
type ParsedLine = { ok: true; record: PiRecord | undefined } | { ok: false; message: string };

type PiAssistantMessage = z.infer<typeof assistantMessageSchema>;

/**
 * Parses one stdout line. Non-JSON lines and record types the handler does not read are skipped. A
 * record of a type it reads that fails its schema is an error: skipping it could turn a failed
 * final turn into the previous turn's text reported as success.
 */
const parsePiRecord = (line: string): ParsedLine => {
  let json: unknown;

  try {
    json = JSON.parse(line);
  } catch {
    return { ok: true, record: undefined };
  }

  const typed = recordTypeSchema.safeParse(json);

  if (!typed.success || !HANDLED_TYPES.has(typed.data.type)) return { ok: true, record: undefined };
  const parsed = piRecordSchema.safeParse(json);

  if (parsed.success) return { ok: true, record: parsed.data };
  const issue = parsed.error.issues[0];

  return {
    ok: false,
    message: `Pi sent an unreadable ${typed.data.type} record (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}).`,
  };
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
