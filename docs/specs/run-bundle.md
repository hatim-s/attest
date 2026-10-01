---
title: Run bundle format
---

# Run bundle format

A run bundle is one run and its cases in a single NDJSON file. No CLI command writes or reads
bundles. Use `exportRunBundle` and `readRunBundle` from `@attest/local/store`.

## Format

Each bundle is UTF-8 NDJSON. Every line is canonical, whitespace-free JSON with object keys sorted recursively. The final newline is allowed but is not included in the content hash.

| Position              | `type`          | Required fields              | Meaning                                                              |
| --------------------- | --------------- | ---------------------------- | -------------------------------------------------------------------- |
| First                 | `bundle_header` | `schema`, `run`              | Declares `attest.bundle` and embeds a `RunRecord`-shaped JSON value. |
| Middle (zero or more) | `case`          | `case`                       | Embeds one `CaseRecord`-shaped JSON value, including its `metrics`.  |
| Final                 | `bundle_footer` | `case_count`, `content_hash` | States the number of case lines and the SHA-256 integrity hash.      |

`content_hash` is the lowercase hexadecimal SHA-256 digest of every line before the footer, joined with a single newline byte (`\n`). The footer line and a trailing newline are excluded.

## Validation

The header schema is `attest.bundle`. `readRunBundle` reads the whole bundle and verifies it
before yielding any line. It checks for exactly one header in first position, the header schema,
each case record's shape, a single final footer, `case_count`, and `content_hash`.

It rejects unknown line types, malformed JSON or records, duplicate or misplaced headers and
footers, a missing footer, a mismatched case count, and a mismatched hash. Because the footer
hash covers every earlier line, appending lines to a finished bundle makes it invalid.

## Atomicity

`exportRunBundle` takes a file path or a writable stream. For a path, it writes the whole bundle
to a temporary sibling file and renames it into place. A missing run fails before the temporary
file exists. A stream gets lines as they are written, so a reader can see partial data if the
stream later fails.
