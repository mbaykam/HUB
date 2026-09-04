import {
  defineOverlayStyle,
} from "../shared/style-runtime.ts";
import BRAND_CLEANUP_STYLES from "./styles.css";

export const installBrandCleanupStyles = defineOverlayStyle(
  "brand-cleanup",
  BRAND_CLEANUP_STYLES,
);
