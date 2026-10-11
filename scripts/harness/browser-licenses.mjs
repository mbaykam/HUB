import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Preserve notices from the actual third-party modules included by esbuild,
 * including transitive Vega/D3 dependencies. The output contains no local paths. */
export function browserLicenses(projectRoot, output) {
  return { name: "bundled-browser-licenses", setup(build) {
    build.onEnd(async result => {
      if (result.errors.length || !result.metafile) return;
      const packages = new Map();
      for (const input of Object.keys(result.metafile.inputs)) {
        if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
        let directory = dirname(resolve(projectRoot, input));
        while (directory !== dirname(directory)) {
          let manifest;
          try { manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); } catch {}
          if (manifest?.name && manifest?.version) { packages.set(directory, manifest); break; }
          directory = dirname(directory);
        }
      }
      const notices = [];
      for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
        const files = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name));
        if (!files.length) throw new Error(`Missing bundled license for ${manifest.name}`);
        notices.push(`${manifest.name}@${manifest.version}\n${(await Promise.all(files.sort().map(name => readFile(join(directory, name), "utf8")))).join("\n\n")}`);
      }
      await writeFile(output, notices.join("\n\n----------------------------------------\n\n") + "\n");
    });
  } };
}
