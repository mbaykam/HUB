export const zh = {
  trigger: "关于 HUB",
  iconAlt: "HUB 应用图标",
  tagline: "为 {harness} 打造的原生桌面工作空间",
  metadata: "版本 {version} · {platform} · {arch}",
  community:
    "HUB 是基于 Minke 的独立开源分支，并非 DeepSeek 官方产品。",
  checkUpdate: "检查更新",
  checkingUpdate: "正在检查…",
  updateStatusUpToDate: "当前已是最新版本。",
  updateStatusAvailable: "发现新版本，已打开更新流程。",
  updateStatusBusy: "更新检查或下载正在进行中。",
  updateStatusUnavailable: "当前构建不支持应用更新。",
  updateStatusFailed: "检查更新失败，请稍后重试。",
  project: "HUB on GitHub",
  harness: "DeepSeek Harness",
  close: "关闭",
} as const;

export type AboutLocaleKey = keyof typeof zh;
export type AboutTranslate = (
  key: AboutLocaleKey,
  params?: Record<string, unknown>,
) => string;

export const en: Record<AboutLocaleKey, string> = {
  trigger: "About HUB",
  iconAlt: "HUB app icon",
  tagline: "A native desktop workspace for {harness}",
  metadata: "Version {version} · {platform} · {arch}",
  community:
    "HUB is an independent open-source fork of Minke, not an official DeepSeek product.",
  checkUpdate: "Check for updates",
  checkingUpdate: "Checking…",
  updateStatusUpToDate: "HUB is up to date.",
  updateStatusAvailable:
    "A new version was found and the update flow is open.",
  updateStatusBusy:
    "An update check or download is already in progress.",
  updateStatusUnavailable:
    "Application updates are unavailable in this build.",
  updateStatusFailed:
    "The update check failed. Please try again later.",
  project: "HUB on GitHub",
  harness: "DeepSeek Harness",
  close: "Close",
};
