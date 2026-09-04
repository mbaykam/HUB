import {
  defineOverlayStyle,
} from "../shared/style-runtime.ts";
import {
  installSettingsNavigationIcon,
  reconcileSettingsNavigationIcon,
  type SettingsNavigationRoot,
} from "../shared/settings-navigation.ts";
import MINKE_SETTINGS_STYLES from "./styles.css";

const MINKE_SETTINGS_NAV_MARKER =
  "data-minke-settings-navigation-logo";
const MINKE_LOGO_TILE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg"',
  ' viewBox="0 0 1024 1024">',
  '<mask id="minke-logo-cutout">',
  '<rect width="1024" height="1024" rx="224" fill="white"/>',
  '<path fill="black" d="M282 226c-22.1 0-40 17.9-40 40v492',
  "c0 22.1 17.9 40 40 40h80c22.1 0 40-17.9 40-40V590h220v168",
  "c0 22.1 17.9 40 40 40h80c22.1 0 40-17.9 40-40V266",
  "c0-22.1-17.9-40-40-40h-80c-22.1 0-40 17.9-40 40v164H402V266",
  "c0-22.1-17.9-40-40-40h-80Z\"/>",
  "</mask>",
  '<rect width="1024" height="1024" rx="224" fill="black"',
  ' mask="url(#minke-logo-cutout)"/></svg>',
].join("");

export const MINKE_SETTINGS_LOGO_DATA_URL =
  `data:image/svg+xml,${encodeURIComponent(MINKE_LOGO_TILE_SVG)}`;
const MINKE_SETTINGS_LOGO_VARIABLES = {
  "--minke-settings-navigation-logo":
    `url("${MINKE_SETTINGS_LOGO_DATA_URL}")`,
} as const;

export { MINKE_SETTINGS_STYLES };

/** Mark the unified HUB row for its adaptive product logo. */
export function reconcileMinkeSettingsNavigationLogo(
  root: SettingsNavigationRoot,
  label: string,
): void {
  reconcileSettingsNavigationIcon(
    root,
    MINKE_SETTINGS_NAV_MARKER,
    label,
  );
}

/** Keep the HUB logo synchronized across Settings mounts and locales. */
export function installMinkeSettingsNavigationLogo(
  label: () => string,
  root?: SettingsNavigationRoot,
): () => void {
  return installSettingsNavigationIcon(
    MINKE_SETTINGS_NAV_MARKER,
    label,
    root,
    MINKE_SETTINGS_LOGO_VARIABLES,
  );
}

/** Install the unified HUB section and secondary-tab stylesheet. */
export const installMinkeSettingsStyles = defineOverlayStyle(
  "minke-settings",
  MINKE_SETTINGS_STYLES,
);
