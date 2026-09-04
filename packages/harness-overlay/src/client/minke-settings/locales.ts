export const minkeSettingsZh = {
  nav: "HUB",
  title: "HUB 设置",
  empty: "当前环境没有可用的 HUB 设置。",
  pageError: "此设置页暂时无法显示，其他 HUB 设置仍可使用。",
  retry: "重试",
} as const;

export type MinkeSettingsLocaleKey =
  keyof typeof minkeSettingsZh;

export const minkeSettingsEn: Record<
  MinkeSettingsLocaleKey,
  string
> = {
  nav: "HUB",
  title: "HUB Settings",
  empty: "No HUB settings are available in this environment.",
  pageError:
    "This settings page could not be displayed. Other HUB settings remain available.",
  retry: "Retry",
};

export type MinkeSettingsTranslate = (
  key: MinkeSettingsLocaleKey,
) => string;
