import * as SchemaGetter from 'effect/SchemaGetter';
import { looseStruct } from '@attest/contracts';
import { parseWithSchema } from '@attest/contracts';
import type { JsonValue } from '@attest/contracts';
import * as Schema from 'effect/Schema';

/**
 * The Pi RPC stdout records the handler consumes, as documented in Pi 1.3's `docs/json.md` and
 * `docs/rpc.md`. Objects are loose so fields Pi adds later pass through; record types the handler
 * does not read (`message_update`, `queue_update`, compaction and extension UI records, and so on)
 * fail the union and are dropped by `parsePiRecord`.
 */

const usageSchema = looseStruct({ input: Schema.Finite, output: Schema.Finite });

// Text, thinking and tool call blocks; only text blocks carry `text`.
const contentBlockSchema = looseStruct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

const assistantMessageSchema = looseStruct({
  role: Schema.Literal('assistant'),
  content: Schema.Array(contentBlockSchema),
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  usage: usageSchema,
  stopReason: Schema.String,
  errorMessage: Schema.optional(Schema.String),
});

// User, tool result and custom messages become `null`: the handler only reads assistant ones. An
// assistant message that fails its schema fails the record instead of passing as `null`.
const messageSchema = Schema.Union([
  assistantMessageSchema,
  looseStruct({
    role: Schema.String.check(Schema.makeFilter((role) => role !== 'assistant')),
  }).pipe(
    Schema.decodeTo(Schema.Null, {
      decode: SchemaGetter.transform(() => null),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  ),
]);

const piRecordSchema = Schema.Union([
  looseStruct({
    type: Schema.Literal('response'),
    id: Schema.optional(Schema.String),
    command: Schema.String,
    success: Schema.Boolean,
    error: Schema.optional(Schema.String),
    data: Schema.optional(looseStruct({ disposition: Schema.optional(Schema.String) })),
  }),
  looseStruct({ type: Schema.Literal('agent_start') }),
  looseStruct({ type: Schema.Literal('agent_settled'), aborted: Schema.Boolean }),
  looseStruct({ type: Schema.Literal('turn_start') }),
  looseStruct({ type: Schema.Literal('turn_end') }),
  looseStruct({ type: Schema.Literal('message_end'), message: messageSchema }),
  looseStruct({
    type: Schema.Literal('tool_execution_start'),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Json,
  }),
  looseStruct({
    type: Schema.Literal('tool_execution_end'),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Json,
    isError: Schema.Boolean,
    durationMs: Schema.optional(Schema.Finite),
  }),
  looseStruct({
    type: Schema.Literal('auto_retry_start'),
    attempt: Schema.Finite,
    maxAttempts: Schema.Finite,
    delayMs: Schema.Finite,
    errorMessage: Schema.String,
  }),
  looseStruct({
    type: Schema.Literal('auto_retry_end'),
    success: Schema.Boolean,
    attempt: Schema.Finite,
    finalError: Schema.optional(Schema.String),
  }),
]);

type PiRecord = typeof piRecordSchema.Type;

const HANDLED_TYPES: ReadonlySet<string> = new Set(
  piRecordSchema.members.map((option) => option.schema.fields.type.literal),
);

const recordTypeSchema = looseStruct({ type: Schema.String });

/** `record` is `undefined` for lines the handler does not read; `ok: false` is a broken record. */
type ParsedLine = { ok: true; record: PiRecord | undefined } | { ok: false; message: string };

type PiAssistantMessage = typeof assistantMessageSchema.Type;

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

  const typed = parseWithSchema(recordTypeSchema, json);

  if (!typed.ok || !HANDLED_TYPES.has(typed.value.type)) return { ok: true, record: undefined };
  const parsed = parseWithSchema(piRecordSchema, json);

  if (parsed.ok) return { ok: true, record: parsed.value };
  const issue = parsed.error.issues[0];

  return {
    ok: false,
    message: `Pi sent an unreadable ${typed.value.type} record (${issue?.path.map(String).join('.') ?? ''}: ${issue?.message ?? 'invalid'}).`,
  };
};

// Pi tools return `{ content: [{ type: 'text', text }], details }`; an error's text is its message.
const toolResultSchema = looseStruct({ content: Schema.Array(contentBlockSchema) });

/** The first text block of a tool result, or `undefined` when the result has another form. */
const toolResultText = (result: JsonValue): string | undefined => {
  const parsed = parseWithSchema(toolResultSchema, result);

  return parsed.ok
    ? parsed.value.content.find((block) => block.text !== undefined)?.text
    : undefined;
};

/** Joins an assistant message's text blocks in order, skipping thinking and tool call blocks. */
const assistantText = (message: PiAssistantMessage): string =>
  message.content
    .flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
    .join('');

export { assistantText, parsePiRecord, toolResultText, type PiAssistantMessage, type PiRecord };
