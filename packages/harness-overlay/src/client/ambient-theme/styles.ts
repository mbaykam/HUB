import {
  defineOverlayStyle,
} from "../shared/style-runtime.ts";
import AMBIENT_THEME_STYLES from "./styles.css";

export const installAmbientThemeStyles = defineOverlayStyle(
  "ambient-theme",
  AMBIENT_THEME_STYLES,
);
