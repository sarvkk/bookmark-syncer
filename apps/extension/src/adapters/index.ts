import type { BrowserAdapter } from "./types";
import { chromiumAdapter } from "./chromium";
import { firefoxAdapter } from "./firefox";

export function getBrowserAdapter(): BrowserAdapter {
  const ua = navigator.userAgent;
  if (ua.includes("Firefox") && !ua.includes("Seamonkey")) {
    return firefoxAdapter;
  }
  return chromiumAdapter;
}

export type { BrowserAdapter };
