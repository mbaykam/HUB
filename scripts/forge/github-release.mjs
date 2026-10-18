#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const GITHUB_RELEASE_API_VERSION = "2026-03-10";
export const RELEASE_ASSET_NAMES = Object.freeze([
  "HUB-linux-x64.AppImage",
  "HUB-linux-x64.deb",
  "HUB-linux-x64.rpm",
  "HUB-macos-arm64.dmg",
  "HUB-macos-x64.dmg",
  "HUB-windows-x64.exe",
  "SHA256SUMS",
]);
export const RELEASE_PROFILES = Object.freeze({
  all: RELEASE_ASSET_NAMES,
  "windows-x64": Object.freeze(["HUB-windows-x64.exe", "SHA256SUMS"]),
});

function profileAssets(profile) {
  if (!Object.hasOwn(RELEASE_PROFILES, profile)) {
    throw new Error(`Unknown release profile: ${String(profile)}`);
  }
  return RELEASE_PROFILES[profile];
}

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MAX_GH_OUTPUT_BYTES = 2 * 1024 * 1024;

function errorDetail(result) {
  const detail = result.stderr.trim();
  return detail === "" ? `exit code ${String(result.status)}` : detail;
}

function assertSuccessful(result, operation) {
  if (result.status !== 0) {
    throw new Error(`${operation} failed: ${errorDetail(result)}`);
  }
  return result.stdout;
}

function runGhProcess(args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "gh",
      args,
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: MAX_GH_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (
          error !== null &&
          typeof error.code !== "number"
        ) {
          reject(error);
          return;
        }
        resolvePromise({
          status:
            error === null || typeof error.code !== "number"
              ? 0
              : error.code,
          stdout,
          stderr,
        });
      },
    );
  });
}

function assertReleaseIdentity({
  packageVersion,
  releaseTag,
  repository,
}) {
  if (
    typeof packageVersion !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(
      packageVersion,
    )
  ) {
    throw new TypeError(
      "package version must be a stable semantic version",
    );
  }
  if (releaseTag !== `v${packageVersion}`) {
    throw new Error(
      `tag ${String(releaseTag)} does not match package version v${packageVersion}`,
    );
  }
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
  ) {
    throw new TypeError("GitHub repository has an invalid name");
  }
}

function assertAssetList(assets, profile) {
  if (!Array.isArray(assets)) {
    throw new TypeError("release assets must be an array");
  }
  const names = assets
    .map((path) => path.split(/[\\/]/u).at(-1))
    .sort();
  const expected = profileAssets(profile);
  if (
    names.length !== expected.length ||
    names.some(
      (name, index) => name !== expected[index],
    )
  ) {
    throw new Error(
      "release assets do not match the required installer set",
    );
  }
}

async function restoreDraft(runGh, releaseTag) {
  const result = await runGh([
    "release",
    "edit",
    releaseTag,
    "--draft=true",
  ]);
  assertSuccessful(
    result,
    "restoring the unverified release to draft",
  );
}

export async function discoverReleaseAssets(directory, profile = "all") {
  const root = resolve(directory);
  const expected = profileAssets(profile);
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== expected.length ||
    names.some(
      (name, index) => name !== expected[index],
    )
  ) {
    throw new Error(
      "release asset directory does not contain the exact required set",
    );
  }
  const assets = [];
  for (const name of names) {
    const path = join(root, name);
    const details = await lstat(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size <= 0
    ) {
      throw new Error(`${name} is not a non-empty regular file`);
    }
    assets.push(path);
  }
  return assets;
}

/** Verify uploads while the release is still editable, before immutability. */
export async function verifyDraftReleaseAssets(document, assets, releaseTag) {
  if (document?.draft !== true || document.tag_name !== releaseTag) {
    throw new Error("Expected the requested draft release before publication");
  }
  if (!Array.isArray(document.assets) || document.assets.length !== assets.length) {
    throw new Error("Draft release asset inventory does not match the reviewed files");
  }
  for (const path of assets) {
    const name = path.split(/[\\/]/u).at(-1);
    const remote = document.assets.filter(asset => asset.name === name);
    const details = await stat(path);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (remote.length !== 1 || remote[0].state !== "uploaded" ||
        remote[0].size !== details.size || remote[0].digest !== `sha256:${digest}`) {
      throw new Error(`Draft upload does not match the reviewed bytes: ${name}`);
    }
  }
}

export async function publishGithubRelease({
  assets,
  packageVersion,
  releaseTag,
  repository,
  profile = "all",
  notesFile,
  runGh = runGhProcess,
}) {
  assertReleaseIdentity({
    packageVersion,
    releaseTag,
    repository,
  });
  assertAssetList(assets, profile);
  const run = args => runGh(args[0] === "release" ? [...args, "--repo", repository] : args);

  const existing = await run([
    "release",
    "view",
    releaseTag,
  ]);
  if (existing.status === 0) {
    throw new Error(
      `release ${releaseTag} already exists; refusing to replace release assets`,
    );
  }

  assertSuccessful(
    await run([
      "release",
      "create",
      releaseTag,
      ...assets,
      "--draft",
      "--verify-tag",
      ...(notesFile ? ["--notes-file", notesFile] : ["--generate-notes"]),
      "--title",
      `HUB ${releaseTag}`,
    ]),
    "creating the draft release",
  );
  const draft = JSON.parse(assertSuccessful(await run([
    "api", "-H", `X-GitHub-Api-Version: ${GITHUB_RELEASE_API_VERSION}`,
    `repos/${repository}/releases/tags/${releaseTag}`,
  ]), "reading the uploaded draft"));
  await verifyDraftReleaseAssets(draft, assets, releaseTag);
  assertSuccessful(
    await run([
      "release",
      "edit",
      releaseTag,
      "--draft=false",
    ]),
    "publishing the release",
  );

  let releaseDocument;
  try {
    const source = assertSuccessful(
      await run([
        "api",
        "-H",
        `X-GitHub-Api-Version: ${GITHUB_RELEASE_API_VERSION}`,
        `repos/${repository}/releases/tags/${releaseTag}`,
      ]),
      "reading the published release",
    );
    releaseDocument = JSON.parse(source);
  } catch (error) {
    try {
      await restoreDraft(run, releaseTag);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "unable to verify release immutability or restore the release to draft",
      );
    }
    throw new Error(
      "unable to verify release immutability; release restored to draft",
      { cause: error },
    );
  }

  if (
    typeof releaseDocument !== "object" ||
    releaseDocument === null ||
    releaseDocument.immutable !== true
  ) {
    await restoreDraft(run, releaseTag);
    throw new Error(
      "release immutability must be enabled in repository settings; release restored to draft",
    );
  }
}

async function main() {
  if (process.env.GH_TOKEN === undefined || process.env.GH_TOKEN === "") {
    throw new Error("GH_TOKEN is required");
  }
  const packageDocument = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const directory = resolve(
    projectRoot,
    process.argv[2] ?? "release-assets",
  );
  const profile = process.env.HUB_RELEASE_PROFILE ?? "all";
  const assets = await discoverReleaseAssets(directory, profile);
  const notesFile = resolve(projectRoot, "docs/releases", `${process.env.GITHUB_REF_NAME}.md`);
  const notesInfo = await lstat(notesFile);
  if (!notesInfo.isFile() || notesInfo.isSymbolicLink() || notesInfo.size <= 0) {
    throw new Error("Reviewed release notes are required");
  }
  await publishGithubRelease({
    assets,
    packageVersion: packageDocument.version,
    releaseTag: process.env.GITHUB_REF_NAME,
    repository: process.env.GH_REPO,
    profile,
    notesFile,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
