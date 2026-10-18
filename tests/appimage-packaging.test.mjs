import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { RELEASE_PROFILES } from "../scripts/forge/github-release.mjs";
const yaml = createRequire(new URL('../vendor/deepseek-harness/node_modules/.pnpm/native-test.cjs',import.meta.url))('yaml');

const workflowUrl = new URL(
  "../.github/workflows/package.yml",
  import.meta.url,
);
const scriptUrl = new URL("../scripts/forge/appimage.mjs", import.meta.url);

const appImageAssetName = "HUB-linux-x64.AppImage";

test("AppImage script exists and is an executable ESM entry", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /^#!\/usr\/bin\/env node\s*$/mu);
  assert.match(script, /from "node:child_process"/u);
  assert.match(script, /appimagetool/u);
  assert.match(script, /--appimage-extract-and-run/u);
  assert.match(script, /AppRun/u);
});

test("Linux job builds the AppImage after the distributables", async () => {
  const source = await readFile(workflowUrl, "utf8");

  const appImageStep =
    /name:\s*Build AppImage from deb\s*\n\s*if:\s*runner\.os == 'Linux'\s*\n\s*run:\s*node scripts\/forge\/appimage\.mjs/u;
  assert.match(source, appImageStep);

  const makeIndex = source.indexOf("run: pnpm make");
  const appImageIndex = source.indexOf("Build AppImage from deb");
  const uploadIndex = source.indexOf("Upload distributables");
  assert.notEqual(makeIndex, -1);
  assert.ok(appImageIndex > makeIndex, "AppImage step must run after pnpm make");
  assert.ok(uploadIndex > appImageIndex, "AppImage step must run before upload");
});

test("public releases use the Windows profile while full packaging retains AppImage support", async () => {
  const workflow = yaml.parse(await readFile(workflowUrl, "utf8"));
  const publisher = workflow.jobs.release.steps.find(step => step.name === "Publish GitHub Release");
  assert.equal(publisher.env.HUB_RELEASE_PROFILE, "windows-x64");
  assert.deepEqual(RELEASE_PROFILES[publisher.env.HUB_RELEASE_PROFILE], ["HUB-windows-x64.exe", "SHA256SUMS"]);
  assert.ok(RELEASE_PROFILES.all.includes(appImageAssetName));
});
