# Photon package

`@photon-hq/hono-openapi` is published to GitHub Packages.

Version `1.3.1-photon.3` uses upstream commit
`ce39f12976028681f752c98cc0e7108db5cc96c0` and pins
`@photon-hq/standard-openapi@0.2.9-photon.2` as a runtime dependency. That published
converter includes request/response direction and preserves recursive schema
references.

The Photon patch resolves response schemas into copies. Upstream mutates shared
route metadata and documentation responses, which can discard components when
generating another document from the same endpoint. The regression tests cover
repeated generation and separate apps sharing route or component responses.

Every push to `main` publishes a staging build, `X.Y.Z-staging.<run>.<attempt>`,
under the `staging` dist-tag and stores its `X.Y.Z` production candidate on a
`hono-openapi-staging-*` prerelease. To release, run **Promote to production**
with that staging version and approve the `production` deployment. It publishes
the stored candidate under `latest` without rebuilding and tags `vX.Y.Z`. See
buildspace's [package stage and promote](https://github.com/photon-hq/buildspace#package-stage-and-promote)
workflows.

Releases are stable `X.Y.Z` versions. `1.3.1-photon.5` was the last `-photon.N`
prerelease, and `1.3.1` is the first stable release of that line. Bump the version
in a pull request before each promotion; a version is released once. Versions
after `1.3.1` are Photon's own and don't follow upstream's numbering, so record
the upstream base commit here when syncing. Promotion requires every
`@photon-hq/*` dependency to be an exact stable version; `1.3.1` pins
`@photon-hq/standard-openapi@0.2.9`, the first stable release of the
`0.2.9-photon.3` converter line.

Keep the upstream MIT license and compare the response-copy patch when syncing
upstream or switching consumers back to the upstream package.

Upstream commits CRLF line endings; this fork stores LF (`.gitattributes`). Merge
upstream with `git merge -X renormalize` so line endings alone never conflict.

## Direction-aware conversion (ENG-2960)

Validator schemas are converted as input. Route responses and reusable
`documentation.components.responses` are converted as output, including when
one resolver/schema is reused in both positions or across applications.
The slot's direction takes precedence over conflicting converter options.
Custom vendors receive `context.io`; forward it to the schema library without
changing the source schema's object policy. Response schemas must describe the
JSON that the handler actually serializes.

Component names follow the converter: a response component keeps its name
(`Name`); a request component keeps the same name when its request and response
representations are identical and is `NameInput` when they differ. The
converter never invents names, so every recursive or reused schema must be
named with metadata (for example `z.json().meta({ ref: "JsonValue" })`);
otherwise document generation fails with the schema's location. Emitted refs,
snapshots and consumer adoption must be updated together. Named query/parameter
objects retain all fields, and their schema components remain available for recursive
refs. Different schemas with a colliding component name fail explicitly.

This is a change to the emitted OpenAPI contract, not a change to request
validation or handler execution. Existing consumers must regenerate schema
snapshots and clients, update hard-coded component references, and check that
response schemas describe the actual serialized response before adopting it.
For a Zod 4 `z.object({ name: z.string().default("Ada") })`, the request still
permits omission of `name`; the response now requires `name` and disallows extra
properties. Services that deliberately expose extensible responses must declare
that policy in their source response schemas rather than widen generated output.
Custom adapters must forward `context.io` to their native converter. There is no
blanket guarantee that changing a converter fixes arbitrary runtime transforms.

Version `1.3.1-photon.3` pins `@photon-hq/standard-openapi@0.2.9-photon.2`,
which names components `input__Name` / `output__Name`. Version
`1.3.1-photon.4` carries the naming above and must pin
`@photon-hq/standard-openapi@0.2.9-photon.3`, the converter release with those
rules. Its tests assert the new names, so they pass only once that converter
is published and pinned. Normal tests use the published converter without
local aliases. Publish this package only after its PR passes CI and is merged,
then adopt it through explicit dependency updates in hono-basic and other
consumers. Version `1.3.1-photon.2` remains pinned to the old converter.
See [standard-openapi's compatibility notes](https://github.com/photon-hq/standard-openapi/blob/main/PHOTON.md)
for the unchanged Zod 3 stripping-object output limitation.
