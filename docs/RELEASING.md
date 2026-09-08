# Alpha releases

The first candidate is `0.1.0-alpha.0`. Alpha packages use the npm `alpha` tag. The
release includes `@attest/contracts`, `@attest/core`, `@attest/web`, `@attest/cli`,
and `@attest/schemas`. Their versions move together. The web package contains the
prebuilt dashboard and does not install a frontend toolchain for CLI users.

## Prepare a candidate

Use Bun 1.4 or newer to develop and build. Published packages require Node.js
22.15 or newer. The CLI uses Node via its executable shebang; Bun is not required
to use the published CLI. Alpha CI checks macOS with the latest Node 22 and Linux with Node 22.15.0. Windows is not yet a
validated target.

The Node floor covers read-only report access. A packed installation on Node
22.13.0 completed its native-agent evaluation but failed to open the report database.
A direct `node:sqlite` check reproduced `ERR_SQLITE_ERROR: unable to open database
file` when opening a `file:` URI with `?immutable=1`. The complete installed
evaluation and report journey passes on Node 22.15.0.

From the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run test:fuzz
bun run release:check
```

`release:check` builds the packages, regenerates JSON Schemas, and creates five
archives and their `SHA256SUMS` file in `dist/release/`. It installs those archives into a temporary npm
project outside the workspace, then checks the installed executable, project
initialization, a native-agent evaluation, its persisted HTML report, public imports,
SQLite persistence, JSON Schemas, and the embedded
dashboard HTTP response. It removes the temporary project when finished. The
archives remain available for inspection and distribution.

`release:pack` performs only the build, schema generation, and packaging. Packaging
copies the root Apache-2.0 license and NOTICE into each archive, excludes source and tests,
removes development scripts and dependencies, and replaces workspace dependency
references with exact candidate versions. Publish these archives, not the raw
workspace directories. A `prepublishOnly` guard rejects direct workspace publication.

CI runs the isolated install check on macOS and Linux and uploads the archives as
`alpha-packages-macos-latest` and `alpha-packages-ubuntu-latest` artifacts.

## Test without publishing

Copy all five archives and `SHA256SUMS` to a tester's machine. From their directory,
verify the files with `shasum -a 256 -c SHA256SUMS` on macOS or
`sha256sum -c SHA256SUMS` on Linux. In a separate project directory:

```sh
npm init -y
npm install -D /absolute/path/to/release/*.tgz
npx attest --version
npx attest --help
```

Install all five archives together because their exact alpha versions may not yet
exist on npm. The CLI archive alone cannot satisfy unpublished sibling packages.

## Publish to npm

Publishing requires an npm account with permission to publish every `@attest`
package. A missing package on npm does not establish ownership of its scope.
Confirm the final package scope before the first publication. If it changes,
update package names, imports, documentation, and packaging together.

As of the local release preparation, `npm whoami` returned `E401` and
`npm view @attest/cli` returned `E404`. No package has been published by this work.
Authenticate and confirm scope permissions before proceeding.

Run npm account and publication commands outside the repository because the root
manifest intentionally requires Bun as its development package manager. After the
candidate checks pass, publish the reviewed archives in dependency order:

```sh
RELEASE_DIR=/absolute/path/to/attest/dist/release
PUBLISH_WORKDIR="$(mktemp -d)"
cd "$PUBLISH_WORKDIR"
npm whoami
npm publish "$RELEASE_DIR/attest-contracts-0.1.0-alpha.0.tgz" --access public --tag alpha
npm publish "$RELEASE_DIR/attest-core-0.1.0-alpha.0.tgz" --access public --tag alpha
npm publish "$RELEASE_DIR/attest-web-0.1.0-alpha.0.tgz" --access public --tag alpha
npm publish "$RELEASE_DIR/attest-cli-0.1.0-alpha.0.tgz" --access public --tag alpha
npm publish "$RELEASE_DIR/attest-schemas-0.1.0-alpha.0.tgz" --access public --tag alpha
```

Wait for each package to appear on the registry before publishing its dependents.
If publication stops partway through, inspect the registry and resume with the
remaining archives. Published version numbers cannot be reused.

Then verify from a new directory using only the registry:

```sh
npm init -y
npm install -D @attest/cli@alpha
npx attest --version
npx attest project init demo --name Demo --output json
```

Tag the reviewed commit and write release notes only after the registry check
passes. Future candidates increment every public package version together, for
example `0.1.0-alpha.1`, followed by `bun install` to update the lockfile.

## Before a stable release

A successful alpha package check covers local installation and basic operation.
A stable release also needs:

- A confirmed public name and npm ownership, plus registry installation evidence.
- Passing macOS and Linux CI on the exact release commit.
- End-to-end evaluations from external testers, including agent failures,
  cancellation, metric errors, persisted results, and dashboard review.
- A documented policy for schema and database changes after users have real runs.
- A declared platform support policy and Windows validation if Windows is offered.
- Release notes with known limitations, upgrade instructions, and an issue-reporting
  path.

The current packaging command deliberately accepts alpha versions only. Stable
publication needs an explicit update to that guard and the package publish tag.
