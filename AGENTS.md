# Shared project instructions

## Development Philosophy

### Writing code
- ALWAYS add docstring comments for major functions, classes and methods, and inline comments
explaning non trivial logic and code
- Always use single export statement and use named exports for everything - functions, hooks, components, classes etc.
- Whenever a `package.json` script is added, removed, renamed, or its command changes, update `docs/SCRIPTS.md` in the same change.
- Never write code inside index.js/index.ts - only use these as exports
- Keep the code lean and avoid unnecessary complexity, prefer deep modules and narrow APIs
- Keep a clean file structure, file and variable names should be readable
- Do not shove unwanted tests everywhere, keep tests colocated together and only important functionality should be tested

### Incremental development
Small increments; every commit compiles (typecheck, lint and format) and passes owned
tests. Conventional commits. No massive dumps.

### Commands
Dev commands are present in the `package.json`. Whenever creating new scripts, always
put them in `package.json`.

### Database and Migrations
- Never push to actual database without approval from human - strictly HITL
- Always highlight breaking changes, or changes that might require migration to the human

### Environment
- Whenever adding, removing, or renaming an environment variable, secret, or Cloudflare binding,
update `docs/ENV.md` in the same change.

## Computer and Browser Use
- Use the browser use tool and/or Computer use tool to validate your work, or debug issues when the user requests.
- Always try to reproduce the issue, with your best efforts, and then try to fix it. If it cannot be reproduced because of tool failures, report as such and abort. If the issue could not be reproduced, then do not jump to a fix, report that it could not be reproduced and suggest possible fixes to the user.

## Implementation plan protocol

The build plan is `PLAN.md` (repo root, **gitignored** — local working copy). Canonical copy: planloft store `~/.planloft/docs/attest/attest-implementation-plan.md`; published view: https://hatim-s.github.io/planloft-plans/p/d6omNNpVrp/

If `PLAN.md` is missing locally, restore it: `planloft copy attest-implementation-plan` (or `node /Users/admin/Projects/planloft/dist/cli.js copy attest-implementation-plan`), then move it to repo root as `PLAN.md`.

Follow the **Agent protocol** section at the top of PLAN.md: claim items (⏳), respect dependencies, mark done ([x] + ✅ note), and after every status change rehost + redeploy so all agents and the human stay in sync:

```bash
node /Users/admin/Projects/planloft/dist/cli.js hoist PLAN.md --slug attest-implementation-plan --title "attest — Implementation Plan" --kind plan
node /Users/admin/Projects/planloft/dist/cli.js deploy attest-implementation-plan
```
