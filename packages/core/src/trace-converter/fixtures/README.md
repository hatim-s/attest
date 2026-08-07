# OTLP converter fixtures

These sanitized OTLP/HTTP JSON fixtures reproduce the span names and attributes documented by the
frameworks; they contain no user trace data.

- `vercel-ai-sdk.otlp.json` follows the Vercel AI SDK `ai.generateText`, provider, and `ai.toolCall`
  telemetry shapes.
- `langchain-langsmith.otlp.json` follows LangSmith's documented OpenTelemetry mapping for chain,
  LLM, and tool spans.

IDs use the hexadecimal and enum fields required by the OTLP JSON encoding.
