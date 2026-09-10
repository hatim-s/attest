# Attest marketing site

`index.html` is the approved `site/variants/sorter-line.html`, copied without changes.
It contains the page, styles, theme controls, scroll branches, and canvas animation.
Google Fonts remains its only external asset dependency.

From the repository root:

```sh
bun run --cwd packages/site dev
bun run --cwd packages/site build
bun run --cwd packages/site preview
```

Dev and preview use `http://127.0.0.1:8735`. Refresh the browser after editing HTML.
The root `bun run build` also builds this workspace through Turborepo.
Deploy `packages/site/dist` to any static host. No server runtime is needed.

The waitlist form retains the supplied HTML's placeholder behavior: it prevents
submission and does not save email addresses. Connecting a mailing service is a
separate change.
