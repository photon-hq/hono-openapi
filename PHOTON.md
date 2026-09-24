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

To publish a new version, update `package.json` and the lockfile, merge to `main`,
then run the **Publish GitHub Package** workflow. Versions are immutable;
increment the `-photon.N` suffix for Photon changes to the same upstream version.
The workflow publishes with its repository's `GITHUB_TOKEN`.

Keep the upstream MIT license and compare the response-copy patch when syncing
upstream or switching consumers back to the upstream package.

## Direction-aware conversion (ENG-2960)

Validator schemas are converted as input. Route responses and reusable
`documentation.components.responses` are converted as output, including when
one resolver/schema is reused in both positions or across applications.
The slot's direction takes precedence over conflicting converter options.
Custom vendors receive `context.io`; forward it to the schema library without
changing the source schema's object policy. Response schemas must describe the
JSON that the handler actually serializes.

The exact converter dependency is the published ENG-2960 release. Generated
schema components use `input__Name` and `output__Name`; emitted refs, snapshots
and consumer adoption must be updated together. Named query/parameter objects
retain all fields, and their schema components remain available for recursive
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

The selected release is `1.3.1-photon.3`. Normal tests use the published converter
without local aliases. Publish this package only after its PR passes CI and is
merged, then adopt it through explicit dependency updates in hono-basic and
other consumers. Version `1.3.1-photon.2` remains pinned to the old converter.
See [standard-openapi's compatibility notes](https://github.com/photon-hq/standard-openapi/blob/main/PHOTON.md)
for the unchanged Zod 3 stripping-object output limitation.
