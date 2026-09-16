import type { TranslationKey } from "../../shared/i18n/translations";

export type IconName = "home" | "users" | "key" | "api" | "route" | "chart" | "document" | "alert" | "info" | "settings";

export interface NavItem {
  hash: string;
  label: TranslationKey;
  icon: IconName;
}

export const NAV_ITEMS: NavItem[] = [
  { hash: "", label: "overview", icon: "home" },
  { hash: "#/usage-stats", label: "usageStats", icon: "chart" },
  { hash: "#/logs", label: "logs", icon: "document" },
  { hash: "#/errors", label: "errorsTab", icon: "alert" },
  { hash: "#/info", label: "infoTab", icon: "info" },
  { hash: "#/settings", label: "settings", icon: "settings" },
];
