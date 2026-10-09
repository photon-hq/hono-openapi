import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Buildspace's package-stage workflow runs this once for the staging build and once
// for its production candidate. Both entry points are loaded from the archive
// as packed, resolving their dependencies from this checkout's node_modules.
const stable = /^\d+\.\d+\.\d+$/u;
const destination = process.env.PACK_DESTINATION;
if (!destination) {
  throw new Error("PACK_DESTINATION is required");
}
const original = await readFile("package.json", "utf8");
const manifest = JSON.parse(original);
if (!stable.test(manifest.version)) {
  throw new Error("package.json must declare a stable X.Y.Z version");
}
const version = `${manifest.version}${process.env.RELEASE_SUFFIX ?? ""}`;
execFileSync("pnpm", ["build"], { stdio: "inherit" });
try {
  await writeFile(
    "package.json",
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  );
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    stdio: "inherit",
  });
} finally {
  await writeFile("package.json", original);
}

const archive = join(
  destination,
  `${manifest.name.slice(1).replace("/", "-")}-${version}.tgz`,
);
await mkdir("node_modules/.cache", { recursive: true });
const unpacked = await mkdtemp(resolve("node_modules/.cache/pack-release-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const root = join(unpacked, "package");
  const { exports } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  await access(join(root, exports.import.types));
  await access(join(root, exports.require.types));
  const esm = await import(
    pathToFileURL(join(root, exports.import.default)).href
  );
  const cjs = createRequire(join(root, "package.json"))(
    join(root, exports.require.default),
  );
  if (
    typeof esm.generateSpecs !== "function" ||
    typeof cjs.generateSpecs !== "function"
  ) {
    throw new Error("The packed entry points do not export generateSpecs");
  }
} finally {
  await rm(unpacked, { force: true, recursive: true });
}
