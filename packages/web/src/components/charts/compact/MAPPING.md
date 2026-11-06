# Compact chart integration

Use a React `key` containing project, source and eval identity on both chart components. Include any explicit trend query-window/filter identity in that key. Preserve it while polling or appending results. These components cannot infer a source change from identical run/day identities. Axis, timezone offset, daily calendar bounds, controlled selection, identity removal and focus departure expire inspection internally.

Map decoded summary DTOs to the existing bounded models. Keep the 200-slice trend cap and 92-day calendar cap, expose server truncation, and use offset 0 for backend UTC activity buckets. Complete eval slices supply their own rate. Run status and aggregate counts do not determine completion or imply case identities. Timestamps are epoch milliseconds; fixed offsets do not model DST.

Trend readout follows hover or mark focus independently of the chooser and Open run action. Choosing a run stages inspection. Focusing Open run pins that identity through appended polling results until departure or invalidation. Dense marks keep exact coordinates. A native anchor hotspot exists within 24 CSS pixels of a mark and retains browser modified-click behavior. Use the chooser for every colliding identity.

Daily chooser stages inspection; Select day calls `onSelectDay` to commit it. This API selects a day, not a destination route. Empty days and the already selected day disable the persistent action. Sparse marks select directly with Enter, Space or click. Hover and transient sparse focus never retarget the action.

Load the host stylesheet before component styles. The controls supply their own scoped affordances under its reset. Readouts have fixed height and clipped single-line rows; full identities and timestamps remain in accessible text and chooser options, and Open run has a full-identity title. No readout or inspection transition changes plot position. Actual browser geometry remains an integration check.

Host `--fail`, `--fail-soft`, `--fail-text` and color-scheme are honored. Scoped fallbacks use #FF5C00/#FF6A1A for full failure marks and #FFC29C/#9A4619 for shortfall. Existing legacy root theme and future `.attest-compact[data-theme]` support remain scoped here.

Before merge, obtain fresh independent Opus, Sol and DeepSeek reviews and Chrome validation with the real stylesheet/color-scheme: 375px, 500px and desktop; light, dark and system; 28 daily slots and 30 runs; complete/first-complete/rail readouts; chooser-to-action, polling and departure; bounding-box stability and modified navigation. DOM tests do not establish native pointer, computed theme, screen-reader or geometry acceptance.
