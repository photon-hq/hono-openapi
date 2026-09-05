# Photon package

`@photon-hq/hono-openapi` is published to GitHub Packages.

Version `1.3.1-photon.1` uses upstream commit
`ce39f12976028681f752c98cc0e7108db5cc96c0` and pins
`@photon-hq/standard-openapi@0.2.9-photon.1` as a runtime dependency. That converter
includes the upstream fix for recursive definitions that otherwise produce
dangling `#/components/schemas/*` references.

The Photon patch resolves response schemas into copies. Upstream mutates shared
route metadata and documentation responses, which can discard components when
generating another document from the same endpoint. The regression tests cover
repeated generation and separate apps sharing route or component responses.

To publish a new version, update `package.json` and the lockfile, merge to `main`,
then run the **Publish GitHub Package** workflow. Versions are immutable;
increment the `-photon.N` suffix for Photon changes to the same upstream version.
The workflow publishes with its repository's `GITHUB_TOKEN`.

Keep the upstream MIT license and compare the response-copy patch when syncing
upstream or switching consumers back to the upstream package.
