import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build, transform } from "esbuild";
import { installInstalledUINetwork } from "./installed-ui-network.mjs";
import { transformInstalledUIShell } from "./installed-ui-shell.mjs";
import { collectInstalledUINotices } from "./installed-ui-notices.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");
const script = source => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;

/** Read only build files whose resolved paths stay under the specified staged root. */
export async function readBuildFile(root, file) {
  const base = await realpath(root), path = await realpath(resolve(base, file));
  const rel = relative(base, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Build file escapes staging: ${file}`);
  if (!(await stat(path)).isFile()) throw new Error(`Not a build file: ${file}`);
  return readFile(path);
}

/** Apply the maintained build-only API patch to an isolated module, never the running host. */
export async function loadStaticBuildApi(runtimeRoot) {
  const packagePath = "node_modules/@deepseek-ai/dsh-client-modules/lib/index.js";
  const source = (await readBuildFile(runtimeRoot, packagePath)).toString("utf8");
  const temporary = await mkdtemp(join(tmpdir(), "hub-static-graph-"));
  try {
    const target = join(temporary, packagePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    if (!source.includes("function buildStaticClientGraph(")) {
      const env = Object.fromEntries(["PATH", "SystemRoot", "SystemDrive", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      const applied = spawnSync("git", ["apply", "--no-index", "--whitespace=error-all", join(projectRoot, "patches/deepseek-harness/static-client-export.patch")], { cwd: temporary, env, encoding: "utf8", windowsHide: true });
      if (applied.status !== 0) throw new Error(`Static graph patch failed: ${applied.stderr}`);
    }
    // This imports only Cordis's class definitions, not any product plugin.
    const require = createRequire(pathToFileURL(join(runtimeRoot, packagePath)));
    const cordis = pathToFileURL(require.resolve("@deepseek-ai/cordis")).href;
    const patched = (await readFile(target, "utf8")).replace('from "@deepseek-ai/cordis"', `from ${JSON.stringify(cordis)}`);
    const entry = join(temporary, "build-api.mjs");
    await writeFile(entry, patched);
    return await import(pathToFileURL(entry).href);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Export the fixed installed-client profile without importing or activating host plugins. */
export async function exportInstalledUI({ runtimeRoot = join(projectRoot, "runtime/host"), output = join(projectRoot, "mobile/build/installed-ui") } = {}) {
  runtimeRoot = await realpath(runtimeRoot);
  const profile = JSON.parse(await readFile(join(projectRoot, "mobile/installed-ui-profile.json"), "utf8"));
  const api = await loadStaticBuildApi(runtimeRoot);
  const inputs = [];
  for (const name of profile.packages) {
    const base = `node_modules/${name}`;
    const manifest = JSON.parse((await readBuildFile(runtimeRoot, `${base}/package.json`)).toString("utf8"));
    if (manifest.name !== name) throw new Error(`Wrong staged package: ${name}`);
    const entry = manifest.exports?.["./client"];
    const file = typeof entry === "string" ? entry : entry?.default;
    if (typeof file !== "string" || !file.startsWith("./")) throw new Error(`Invalid client export: ${name}`);
    inputs.push({ manifest, bundle: await readBuildFile(runtimeRoot, `${base}/${file}`) });
  }
  const { graph, injections, assets } = api.buildStaticClientGraph(inputs, profile.staticModules);
  const frontend = join(runtimeRoot, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
  const index = (await readBuildFile(frontend, "index.html")).toString("utf8");
  const shellPath = /<script\b[^>]*type="module"[^>]*src="([^"]+)"/u.exec(index)?.[1];
  if (!shellPath || !shellPath.startsWith("./assets/")) throw new Error("Missing built Vite shell");
  await readBuildFile(frontend, shellPath);
  const loaders = { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".png": "dataurl", ".svg": "dataurl" };
  const fence = { name: "staged-static-files-only", setup(builder) { builder.onLoad({ filter: /.*/, namespace: "file" }, async args => { await readBuildFile(frontend, args.path); return undefined; }); } };
  const shell = await build({ entryPoints: [resolve(frontend, shellPath)], bundle: true, write: false, format: "iife", platform: "browser", target: "safari17", minify: true, legalComments: "inline", loader: loaders, plugins: [fence], logLevel: "silent" });
  const cssPaths = [...index.matchAll(/<link\b(?=[^>]*rel="stylesheet")[^>]*href="([^"]+)"/gu)].map(match => match[1]);
  for (const file of cssPaths) await readBuildFile(frontend, file);
  const css = await build({ stdin: { contents: cssPaths.map(file => `@import ${JSON.stringify(resolve(frontend, file).replaceAll("\\", "/"))};`).join("\n"), loader: "css", resolveDir: frontend }, bundle: true, write: false, minify: true, loader: loaders, plugins: [fence], logLevel: "silent" });
  const host = JSON.parse((await readBuildFile(runtimeRoot, "node_modules/@lencx/minke-harness-overlay/lib/ui-host.json")).toString("utf8"));
  if (host.schema !== 1 || !/^[a-f0-9]{64}$/u.test(host.compatibility)) throw new Error("Missing host compatibility");
  const lazy = {};
  const resources = [];
  for (const file of ["memory-graph-browser.js", "voice-browser.js"]) {
    const bytes = await readBuildFile(runtimeRoot, `node_modules/@lencx/minke-harness-overlay/lib/${file}`);
    lazy[file] = bytes.toString("base64");
    resources.push({ file, sha256: hash(bytes), bytes: bytes.length, embedded: true });
  }
  const notices = await Promise.all(["memory-graph-browser.js.LEGAL.txt", "memory-graph-third-party-licenses.txt"].map(async file => `${file}\n${(await readBuildFile(runtimeRoot, `node_modules/@lencx/minke-harness-overlay/lib/${file}`)).toString("utf8")}`));
  const bootstrap = injections.filter(row => row.kind === "script").map(row => script(row.text)).join("\n");
  if (injections.some(row => !["script", "script-preload", "script-src", "global"].includes(row.kind))) throw new Error("Unsupported bootstrap injection");
  const batches = await Promise.all(assets.map(async asset => script((await transform(asset.body.toString("utf8"), { minify: true, target: "safari17", legalComments: "inline" })).code)));
  const setup = `(${installInstalledUINetwork.toString()})(${json(host.compatibility)});window.__HUB_INSTALLED_UI__={schema:1,compatibility:${json(host.compatibility)}};window.__HUB_UI_RELEASE__={id:'installed',label:'Installed',compatibility:${json(host.compatibility)}};(()=>{const payload=${json(lazy)},urls={};window.__HUB_INSTALLED_UI_ASSET__=name=>{if(!Object.prototype.hasOwnProperty.call(payload,name))return;return urls[name]??(urls[name]=URL.createObjectURL(new Blob([Uint8Array.from(atob(payload[name]),c=>c.charCodeAt(0))],{type:'text/javascript'})));};})();`;
  const shellCode = transformInstalledUIShell(shell.outputFiles.map(file => file.text).join("\n"));
  const dependencyNotices = await collectInstalledUINotices(runtimeRoot);
  notices.push(...dependencyNotices.map(notice => `${notice.file}\nSHA-256: ${notice.sha256}\n${notice.text}`));
  const licenseTemplate = notices.join("\n\n").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const document = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>HUB</title><style>${css.outputFiles.map(file => file.text).join("\n").replace(/<\/style/gi, "<\\/style")}</style>${script(setup)}${bootstrap}${batches.join("\n")}${script(`window.__DSH_BOOT__=${json(graph)};`)}</head><body><div id="root"></div><template id="hub-installed-ui-licenses">${licenseTemplate}</template>${script(shellCode)}</body></html>\n`);
  const manifest = { schema: 1, profile: profile.id, compatibility: host.compatibility, graphRevision: graph.rev, document: { file: "document.html", sha256: hash(document), bytes: document.length }, resources, packages: graph.entries.map(row => row.id) };
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).some(file => !["manifest.json", "document.html"].includes(file))) throw new Error("Output directory contains unrelated files");
  await writeFile(join(output, "document.html"), document);
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await exportInstalledUI();
    console.log(`Installed UI ${manifest.graphRevision}: ${manifest.packages.length} packages, ${manifest.document.bytes} bytes (${manifest.document.sha256})`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
