import {createRequire,registerHooks} from "node:module";
import {pathToFileURL} from "node:url";
import {readdir,readFile} from "node:fs/promises";

// Resolve the pinned monorepo packages just as the native test runner does.
const entries = new Map();
const packages = new URL("../../vendor/deepseek-harness/packages/", import.meta.url);
for (const group of await readdir(packages, { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of await readdir(new URL(group.name + "/", packages), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = new URL(`${group.name}/${pkg.name}/`, packages);
    let manifest; try { manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const packageEntry = manifest.exports?.["."]?.default ?? manifest.main;
    if (packageEntry?.endsWith(".js")) entries.set(manifest.name, new URL(packageEntry, directory).href);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const target = typeof value === "string" ? value : value?.default;
      if (key.startsWith("./") && target?.endsWith(".js")) entries.set(manifest.name + key.slice(1), new URL(target, directory).href);
    }
  }
}
// app-boot also loads the monorepo's vendored Cordis packages. Resolve those
// through their published manifests, independent of pnpm's hoisting layout.
const vendored = new URL('../../vendor/deepseek-harness/vendor/', import.meta.url);
for (const pkg of await readdir(vendored, {withFileTypes:true})) {
  if (!pkg.isDirectory()) continue;
  const directory=new URL(pkg.name+'/',vendored);
  let manifest;try{manifest=JSON.parse(await readFile(new URL('package.json',directory),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const entry=manifest.exports?.['.']?.default??manifest.main;
  if(entry?.endsWith('.js'))entries.set(manifest.name,new URL(entry,directory).href);
  for(const [key,value]of Object.entries(manifest.exports??{})){
    const target=typeof value==='string'?value:value?.default;
    if(key.startsWith('./')&&target?.endsWith('.js'))entries.set(manifest.name+key.slice(1),new URL(target,directory).href);
  }
}
const bootManifest=new URL('../../vendor/deepseek-harness/packages/boot/app-boot/package.json',import.meta.url);
const virtualRequire=createRequire(new URL('../../vendor/deepseek-harness/node_modules/.pnpm/native-test.cjs',import.meta.url));
const bootDependencies=JSON.parse(await readFile(bootManifest,'utf8')).dependencies??{};
registerHooks({ resolve(specifier, context, next) {
  try{return next(entries.get(specifier) ?? specifier, context);}
  catch(error){
    // The monorepo clean build can omit per-package links; the declared
    // external dependency still lives in pnpm's virtual store.
    if(error.code==='ERR_MODULE_NOT_FOUND'&&context.parentURL?.endsWith('/packages/boot/app-boot/lib/index.js')&&specifier in bootDependencies)return next(pathToFileURL(virtualRequire.resolve(specifier)).href,context);
    throw error;
  }
} });
const requireNative = createRequire(new URL("../../vendor/deepseek-harness/package.json", import.meta.url));
export const native = name => import(entries.get(name) ?? pathToFileURL(requireNative.resolve(name)).href);
