# Compact shell integration

`CompactShell` imports `tokens.css` and `shell.css` explicitly. `Tag`/`Tags` and
`EmptyState` import their own scoped styles. Render these components inside the shell.

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
in an identity. `projects` is required `NavigationData<ShellProject>`, reusing `ProjectRecord.key/name`.
`evals` carries `{ sourceId, projectKey, state: NavigationData<ShellEval> }` for the
expanded project, or `null` on the project index. The owner must come from the query that
produced the data. The shell ignores mismatched owners during project or source changes.
Both data states use `{ status: 'loading' }`, `{ status: 'error', message, retry? }`,
`{ status: 'unavailable', message }` or `{ status: 'ready', items }`.
An empty ready list means no records. Supply an honest capability/error message and only
provide retry when supported. Terminal states stop the loading announcement. On the
project index, pass `null`; collapsed projects need no eval request.

`current` is the committed router location adapted to `ShellTarget`. Object memoization is optional.
`hrefFor(target)` supplies a real destination URL for each target. `onNavigate(target)` handles ordinary primary activation; modified and middle clicks use native anchors.
`onSourceChange(id)` switches the real client and navigates to a valid destination for it.
Replace source, projects, breadcrumbs and current together. There is no combined-source view.
`breadcrumbs` supplies named ancestors and ends with the current page.

`resolveRecent(target)` returns `{ label, context }` from data the integration already owns,
or `undefined` for a deleted, unavailable or unauthorized target. Do not fetch per recent
row. Context belongs in the tooltip/accessibility name, e.g. eval name and run identity.
A recent is scoped by source, project and eval where selected, excludes the open page,
and distinguishes every run/case combination. Storage retains at most twenty identities
across all contexts under `attest-recents`. Context and availability filtering precede the four-row display cap. Names, URLs, timestamps, payloads and auth never
enter this store. Each read bounds the outer payload and isolates malformed entries, preserving valid ones.
Recording merges fresh storage with session history before promoting the current target.
Blocked storage retains session history. This reduces stale-tab overwrites; localStorage
provides no atomic transaction for simultaneous cross-tab writes.

Theme cycles system/light/dark, persists under `attest-theme`, and applies `data-theme`
to `.attest-compact` only. CSS media queries keep system mode live as OS settings change.
The document-level `t` shortcut works with body focus and skips editors/modifiers/composition and repeats.
Mobile navigation uses native `dialog.showModal()` for focus trapping/background isolation,
Escape, close and backdrop dismissal, scroll locking and opener focus restoration.
At widths above 960px, the drawer closes and focus moves to the visible sidebar wordmark. Normal dismissal restores the opener. No external fonts or network requests are used.

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

## Target and loading contracts

Eval targets (`runs`, `cases`, `run`, `case`, `run-case`) always carry a nonempty eval ID.
Project-wide and multi-eval runs use `project-runs`, `project-run` or `project-run-case`.
`project-run-case` requires the real `evalId` plus `runId` and `caseId`: cases are identified
by suite and case, even inside a project-wide run. Its navigation context stays project-wide,
so the All runs branch stays selected and recents can include sibling evals. Eval-scoped
contexts exclude project-wide targets. Never invent an eval ID for a project-wide run.
`hrefFor` must encode all of these identities for project-run-case destinations;
`resolveRecent` must resolve through the real suite/case pair, matching `RunSource.getCase`.
Empty, whitespace-only and over-256-character IDs are rejected.

The shell owns its `main`; route content must not add another main landmark. The header is
sticky and uses the approved 14px base with 13px breadcrumbs. At narrow widths only the
last ancestor and current crumb remain. Font family tokens match the mock, but the host
must supply Inter, Inter Tight and IBM Plex Mono for exact font fidelity. No font fetch is
performed by these components.

Integration owners must remove the legacy root theme owner, scope chart theme observation
to the shell and system media query, and handle document/body/scrollbar theme styling.
They also own real router hrefs and DTO adapters. Keep these responsibilities out of the
foundation components. EmptyState styles only its built-in title, description, command and
action; arbitrary children, including primary and danger Buttons, retain caller styles.
