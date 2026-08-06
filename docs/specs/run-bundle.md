---
title: Run bundle format
---

# Run bundle format

Run bundles are the portable, append-friendly export format for attest runs. They are the stable ingestion boundary for a future cloud service while remaining simple to inspect locally.

## Format

Each bundle is UTF-8 NDJSON. Every line is canonical, whitespace-free JSON with object keys sorted recursively. The final newline is allowed but is not included in the content hash.

| Position              | `type`          | Required fields              | Meaning                                                                       |
| --------------------- | --------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| First                 | `bundle_header` | `bundle_version`, `run`      | Declares `attest.bundle/v1alpha1` and embeds a `RunRecord`-shaped JSON value. |
| Middle (zero or more) | `case`          | `case`                       | Embeds one `CaseRecord`-shaped JSON value, including its `metrics`.           |
| Final                 | `bundle_footer` | `case_count`, `content_hash` | States the number of case lines and the SHA-256 integrity hash.               |

`content_hash` is the lowercase hexadecimal SHA-256 digest of every line before the footer, joined with a single newline byte (`\n`). The footer line and a trailing newline are excluded.

## Versioning and compatibility

The initial version is `attest.bundle/v1alpha1`. Writers emit only this version until a new, explicitly documented version is introduced. Readers MUST spool and verify the entire bundle before exposing any records to callers. They MUST verify the first and only header, its known version, case record shapes, the final footer, `case_count`, and `content_hash`.

Readers skip unknown line types so later producers can add optional records without breaking older readers; skipped lines still participate in `content_hash` verification. Readers reject malformed JSON or recognized records, duplicate or misplaced headers and footers, missing footers, mismatched case counts, and mismatched hashes as corrupt data.

## Atomicity

When exporting to a file path, attest writes the complete bundle to a temporary sibling path and then renames it into place. A missing run fails before the temporary file is created. Stream destinations cannot provide filesystem atomicity and may observe data before a later stream failure.
