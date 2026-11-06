# Compact shell integration

`CompactShell` imports `tokens.css` and `shell.css` explicitly. `Tag`/`Tags` and
`EmptyState` import their own scoped styles. Render these components inside the shell.
No entry, router, query client, API, global stylesheet or dependency changes are included.

```tsx
import { CompactShell, type CompactShellProps } from './shell/compact-shell.js';
import { Tags } from './components/tags/tag.js';

/** Receives adapted, source-scoped data from the integration owner's loader. */
const DashboardFrame = (props: CompactShellProps) => (
  <CompactShell {...props}>
    <Tags names={['smoke', 'policy']} />
    {props.children}
  </CompactShell>
);

export { DashboardFrame };
```

`source` is the active host; `sources` contains only real available hosts including it.
For reports use `kind: 'report', capabilities: { control: false }`. Local and cloud
capabilities use the existing `ApiCapabilities` contract. Source IDs must be stable,
non-secret and account/workspace scoped when applicable. Never use a token or credential
in an identity. `projects` is the current source's catalog with eval IDs/names supplied
by the eventual API adapter. It reuses `ProjectRecord.key/name`; no API shapes are assumed.

`current` is the committed router location adapted to `ShellTarget`, memoized by location.
`onNavigate(target)` maps that typed target to the final router contract.
`onSourceChange(id)` switches the real client and navigates to a valid destination for it.
Replace source, projects, breadcrumbs and current together. There is no combined-source view.
`breadcrumbs` supplies named ancestors and ends with the current page.

`resolveRecent(target)` returns `{ label, context }` from data the integration already owns,
or `undefined` for a deleted, unavailable or unauthorized target. Do not fetch per recent
row. Context belongs in the tooltip/accessibility name, e.g. eval name and run identity.
A recent is scoped by source, project and eval where selected, excludes the open page,
and distinguishes every run/case combination. Storage retains at most four identities
across all contexts under `attest-recents`. Names, URLs, timestamps, payloads and auth never
enter this store. Blocked or malformed storage falls back to in-memory state.

Theme cycles system/light/dark, persists under `attest-theme`, and applies `data-theme`
to `.attest-compact` only. CSS media queries keep system mode live as OS settings change.
The `t` shortcut runs within shell focus, skips editors/modifiers/composition and repeats.
Mobile navigation uses native `dialog.showModal()` for focus trapping/background isolation,
Escape, close and backdrop dismissal, scroll locking and opener focus restoration.
Crossing back to desktop also closes it. No external fonts or network requests are used.

## Chart tokens

Read computed styles from a chart container **inside `.attest-compact`**. The existing
`use-chart.ts` reads `document.documentElement` and observes that element's theme attribute;
the chart owner must change that to its shell ancestor/container and observe theme changes
there, including the OS media query in system mode. No root token mutation is included.

Approved tokens include `--bg`, `--text`, `--ink`, `--muted`, `--line`, `--line-2`, `--panel`,
`--fail`, `--fail-text`, `--fail-bg`, `--fail-soft`, `--grid`, `--area`, `--skip`, `--queued`,
`--span`, `--span-run`, `--sans`, `--tight` and `--mono`. Existing-token aliases are
`--surface` = background, `--surface-muted` = panel, `--border` = line,
`--accent`/`--accent-strong`/`--series-1` = ink, `--accent-soft` = selection,
`--danger` = failure text, `--danger-soft` = failure background,
`--warning` = muted, `--warning-soft` = panel. Orange remains reserved for failures/errors.

`EmptyState` takes a title, explanation, optional caller-authored CLI command and optional
supported action. For example, distinguish no runs from no cases before the first run;
only offer New run when host control and authored cases permit it. No endpoint is invented.

## Verification boundary

Package typecheck includes these modules. Package build verifies the existing embedded
app; these modules are intentionally not imported by its entry until route integration.
A separate temporary Vite library build also bundled shell, tags, empty state and their
CSS successfully, without changing the application entry. Browser/visual acceptance and independent Opus/Sol/DeepSeek reviews remain with the parent
before merge. No snapshots or UI glue tests are included. Persistence tests cover bounding,
identity collisions, context filtering, payload exclusion, malformed/blocked storage and themes.
