#!/usr/bin/env node

import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLicenses } from "./browser-licenses.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const overlayPackageRoot = join(
  projectRoot,
  "packages",
  "harness-overlay",
);
const modelRuntimePackageRoot = join(
  projectRoot,
  "packages",
  "model-runtime",
);
const imGatewayPackageRoot = join(
  projectRoot,
  "packages",
  "im-gateway",
);
const weixinPackageRoot = join(
  projectRoot,
  "packages",
  "im-weixin",
);
const telegramPackageRoot = join(
  projectRoot,
  "packages",
  "im-telegram",
);
const discordPackageRoot = join(
  projectRoot,
  "packages",
  "im-discord",
);
const overlayOutputRoot = join(overlayPackageRoot, "lib");
const modelRuntimeOutputRoot = join(modelRuntimePackageRoot, "lib");
const imGatewayOutputRoot = join(imGatewayPackageRoot, "lib");
const weixinOutputRoot = join(weixinPackageRoot, "lib");
const telegramOutputRoot = join(telegramPackageRoot, "lib");
const discordOutputRoot = join(discordPackageRoot, "lib");
const tsconfigPath = join(projectRoot, "tsconfig.json");

async function readManifest(packageRoot) {
  return JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
}

const [
  overlayManifest,
  modelRuntimeManifest,
  imGatewayManifest,
  weixinManifest,
  telegramManifest,
  discordManifest,
] = await Promise.all([
  readManifest(overlayPackageRoot),
  readManifest(modelRuntimePackageRoot),
  readManifest(imGatewayPackageRoot),
  readManifest(weixinPackageRoot),
  readManifest(telegramPackageRoot),
  readManifest(discordPackageRoot),
]);
const overlayPackageId = overlayManifest.name;
const modelRuntimePackageId = modelRuntimeManifest.name;
if (overlayPackageId !== "@lencx/minke-harness-overlay") {
  throw new Error(
    "HUB Harness overlay package name must be @lencx/minke-harness-overlay",
  );
}
if (modelRuntimePackageId !== "@lencx/minke-model-runtime") {
  throw new Error(
    "HUB model runtime package name must be @lencx/minke-model-runtime",
  );
}
const imGatewayPackageId = imGatewayManifest.name;
if (imGatewayPackageId !== "@lencx/minke-im-gateway") {
  throw new Error(
    "HUB IM Gateway package name must be @lencx/minke-im-gateway",
  );
}
const weixinPackageId = weixinManifest.name;
if (weixinPackageId !== "@lencx/minke-im-weixin") {
  throw new Error(
    "HUB Weixin package name must be @lencx/minke-im-weixin",
  );
}
const telegramPackageId = telegramManifest.name;
if (telegramPackageId !== "@lencx/minke-im-telegram") {
  throw new Error(
    "HUB Telegram package name must be @lencx/minke-im-telegram",
  );
}
const discordPackageId = discordManifest.name;
if (discordPackageId !== "@lencx/minke-im-discord") {
  throw new Error(
    "HUB Discord package name must be @lencx/minke-im-discord",
  );
}

await Promise.all([
  rm(imGatewayOutputRoot, { force: true, recursive: true }),
  rm(weixinOutputRoot, { force: true, recursive: true }),
  rm(telegramOutputRoot, { force: true, recursive: true }),
  rm(discordOutputRoot, { force: true, recursive: true }),
]);

await Promise.all([
  mkdir(overlayOutputRoot, { recursive: true }),
  mkdir(modelRuntimeOutputRoot, { recursive: true }),
  mkdir(imGatewayOutputRoot, { recursive: true }),
  mkdir(weixinOutputRoot, { recursive: true }),
  mkdir(telegramOutputRoot, { recursive: true }),
  mkdir(discordOutputRoot, { recursive: true }),
  rm(join(overlayOutputRoot, "model-runtime.js"), { force: true }),
  rm(join(overlayOutputRoot, "model-runtime.js.map"), { force: true }),
]);

await Promise.all([
  build({
    entryPoints: [
      join(weixinPackageRoot, "src", "index.ts"),
    ],
    outfile: join(weixinOutputRoot, "index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(telegramPackageRoot, "src", "index.ts"),
    ],
    outfile: join(telegramOutputRoot, "index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(discordPackageRoot, "src", "index.ts"),
    ],
    outfile: join(discordOutputRoot, "index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(modelRuntimePackageRoot, "src", "core.ts"),
    ],
    outfile: join(modelRuntimeOutputRoot, "index.js"),
    bundle: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(modelRuntimePackageRoot, "src", "contract.ts"),
    ],
    outfile: join(modelRuntimeOutputRoot, "contract.js"),
    bundle: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(
        modelRuntimePackageRoot,
        "src",
        "process-environment.ts",
      ),
    ],
    outfile: join(
      modelRuntimeOutputRoot,
      "process-environment.js",
    ),
    bundle: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(modelRuntimePackageRoot, "src", "live.ts"),
    ],
    outfile: join(modelRuntimeOutputRoot, "live.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(modelRuntimePackageRoot, "src", "dsh.ts"),
    ],
    outfile: join(modelRuntimeOutputRoot, "dsh.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
]);

await Promise.all([
  build({
    entryPoints: [
      join(imGatewayPackageRoot, "src", "index.ts"),
    ],
    outfile: join(imGatewayOutputRoot, "index.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(imGatewayPackageRoot, "src", "weixin.ts"),
    ],
    outfile: join(imGatewayOutputRoot, "weixin.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(imGatewayPackageRoot, "src", "sqlite.ts"),
    ],
    outfile: join(imGatewayOutputRoot, "sqlite.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
]);

await Promise.all([
  build({
    entryPoints: [join(overlayPackageRoot, "src", "index.ts")],
    outfile: join(overlayOutputRoot, "index.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "memory.ts")],
    outfile: join(overlayOutputRoot, "memory.js"),
    bundle: true, packages: "external", format: "esm", platform: "node",
    target: "es2022", tsconfig: tsconfigPath, sourcemap: true,
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "voice.ts")],
    outfile: join(overlayOutputRoot, "voice.js"),
    bundle: true, packages: "external", format: "esm", platform: "node",
    target: "es2022", tsconfig: tsconfigPath, sourcemap: true,
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "characters.ts")],
    outfile: join(overlayOutputRoot, "characters.js"),
    bundle: true, packages: "external", format: "esm", platform: "node",
    target: "es2022", tsconfig: tsconfigPath, sourcemap: true,
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "models.ts")],
    outfile: join(overlayOutputRoot, "models.js"),
    bundle: true, packages: "external", format: "esm", platform: "node",
    target: "es2022", tsconfig: tsconfigPath, sourcemap: true,
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "client", "voice", "browser-client.ts")],
    outfile: join(overlayOutputRoot, "voice-browser.js"),
    bundle: true, format: "esm", platform: "browser", target: ["safari17", "chrome120"],
    tsconfig: tsconfigPath, minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "client", "presentation", "renderer.ts")],
    outfile: join(overlayOutputRoot, "presentation-renderer.js"),
    bundle: true, format: "iife", platform: "browser", target: ["safari17", "chrome120"],
    tsconfig: tsconfigPath, minify: true, legalComments: "external", loader: { ".css": "text" },
    metafile: true, plugins: [browserLicenses(projectRoot, join(overlayOutputRoot, "presentation-third-party-licenses.txt"))],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  }),
  build({
    entryPoints: [join(overlayPackageRoot, "src", "client", "memory", "graph-browser.ts")],
    outfile: join(overlayOutputRoot, "memory-graph-browser.js"),
    bundle: true, format: "esm", platform: "browser", target: ["safari17", "chrome120"],
    tsconfig: tsconfigPath, minify: true, legalComments: "external", loader: { ".css": "text" },
    metafile: true, plugins: [browserLicenses(projectRoot, join(overlayOutputRoot, "memory-graph-third-party-licenses.txt"))],
  }),
  build({
    entryPoints: [
      join(
        overlayPackageRoot,
        "src",
        "web-search",
        "index.ts",
      ),
    ],
    outfile: join(overlayOutputRoot, "web-search.js"),
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "es2022",
    tsconfig: tsconfigPath,
    sourcemap: true,
  }),
  build({
    entryPoints: [
      join(overlayPackageRoot, "src", "client", "index.tsx"),
    ],
    outfile: join(overlayOutputRoot, "client.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "chrome120",
    tsconfig: tsconfigPath,
    external: ["react", "react/jsx-runtime"],
    loader: {
      ".css": "text",
      ".png": "dataurl",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "production",
      ),
    },
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(
        overlayPackageId,
      )}, factory: window.__HUB_UI_FACTORY__ ?? ((require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: {
      js: "return module.exports; }) });",
    },
    sourcemap: true,
  }),
]);

const clientBundle = await readFile(
  join(overlayOutputRoot, "client.js"),
  "utf8",
);
if (!clientBundle.startsWith("window.__ModuleLoader__.load(")) {
  throw new Error(
    "HUB overlay client bundle is missing its Harness loader wrapper",
  );
}
if (/require\(["']@deepseek-ai\//u.test(clientBundle)) {
  throw new Error(
    "HUB overlay client bundle leaked a non-platform Harness value import",
  );
}

// A PWA factory can be preloaded before Harness materializes its usual module.
// The native desktop has no HTTP injection and keeps the bundled factory.
const factoryStart = clientBundle.indexOf("((require) =>");
const factoryEnd = clientBundle.lastIndexOf("return module.exports; }) });");
if (factoryStart < 0 || factoryEnd < factoryStart) throw new Error("Invalid UI factory boundary");
await writeFile(join(overlayOutputRoot, "pwa-client.js"), "window.__HUB_UI_FACTORY__ = " + clientBundle.slice(factoryStart, factoryEnd) + "return module.exports; });\n");

// Conservative compatibility: any native host, runtime contract, lockfile,
// configured vendor patch or speech-server change requires a host install.
// UI/CSS-only changes do not change this fingerprint.
const runtimeConfig = JSON.parse(await readFile(join(projectRoot, "config/harness-runtime.json"), "utf8"));
const compatibilityFiles = [
  "config/harness-runtime.json", "pnpm-lock.yaml", ...runtimeConfig.patches,
  "packages/harness-overlay/package.json", "packages/harness-overlay/cordis.patch.yml",
  ...["index.js", "characters.js", "models.js", "memory.js", "voice.js", "web-search.js", "presentation-renderer.js"].map(name => `packages/harness-overlay/lib/${name}`),
    ...["server.py", "runtime_server.py", "voice_pipeline.py", "voice_attention.py", "playback_guard.py", "speech_segments.py", "speech_settings.py", "speech_download.py", "hub_native_llm.py", "bilingual_tts.py", "supertonic_tts.py", "streaming_asr.py", "native_streaming_stt.py", "speech_preview.py", "telegram_calls.py", "telegram_transport.py", "whisper_auto.py", "speech_health.py", "streaming_preview.py", "knowledge_extract.py", "media_inspect.py"].map(name => `packages/harness-overlay/voice/${name}`),
  "packages/model-runtime/lib/index.js", "packages/model-runtime/lib/dsh.js",
];
const compatibility = createHash("sha256");
for (const name of compatibilityFiles.sort()) {
  compatibility.update(name + "\0").update(await readFile(join(projectRoot, name))).update("\0");
}
await writeFile(join(overlayOutputRoot, "ui-host.json"), JSON.stringify({ schema: 1, compatibility: compatibility.digest("hex") }) + "\n");

console.log(
  `Built ${modelRuntimePackageId} in ${modelRuntimeOutputRoot}`,
);
console.log(
  `Built ${imGatewayPackageId} in ${imGatewayOutputRoot}`,
);
console.log(`Built ${weixinPackageId} in ${weixinOutputRoot}`);
console.log(`Built ${telegramPackageId} in ${telegramOutputRoot}`);
console.log(`Built ${discordPackageId} in ${discordOutputRoot}`);
console.log(`Built ${overlayPackageId} in ${overlayOutputRoot}`);
