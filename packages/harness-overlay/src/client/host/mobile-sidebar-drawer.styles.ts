import {
  defineOverlayStyle,
} from "../shared/style-runtime.ts";
import MOBILE_SIDEBAR_DRAWER_STYLES from "./mobile-sidebar-drawer.css";

export { MOBILE_SIDEBAR_DRAWER_STYLES };

export const installMobileSidebarDrawerStyles =
  defineOverlayStyle(
    "mobile-sidebar-drawer",
    MOBILE_SIDEBAR_DRAWER_STYLES,
  );
