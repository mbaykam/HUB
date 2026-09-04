import { join } from "node:path";

export function applicationResourcesRoot(appRoot, platform) {
  return platform === "darwin"
    ? join(appRoot, "Contents", "Resources")
    : join(appRoot, "resources");
}

export function applicationExecutablePath(appRoot, platform) {
  if (platform === "darwin") {
    return join(appRoot, "Contents", "MacOS", "HUB");
  }
  return join(appRoot, platform === "win32" ? "HUB.exe" : "HUB");
}

export function packagedApplicationLayout(
  projectRoot,
  platform = process.platform,
  arch = process.arch,
) {
  const outputRoot = join(
    projectRoot,
    "out",
    `HUB-${platform}-${arch}`,
  );
  const appRoot =
    platform === "darwin" ? join(outputRoot, "HUB.app") : outputRoot;
  return {
    appRoot,
    executablePath: applicationExecutablePath(appRoot, platform),
    outputRoot,
    resourcesRoot: applicationResourcesRoot(appRoot, platform),
  };
}
