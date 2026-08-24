import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Optional explicit browser binaries (snap/flatpak shims cannot be driven
  // by the dev runner). Example:
  //   WXT_FIREFOX_BIN=$HOME/apps/firefox/firefox bun run dev:firefox
  binaries: {
    chrome: process.env.WXT_CHROME_BIN,
    firefox: process.env.WXT_FIREFOX_BIN,
  },
  srcDir: "src",
  manifest: ({ browser }) => ({
    name: "Bookmark Sync",
    description: "Cross-browser bookmark synchronization.",
    permissions: ["bookmarks", "storage", "alarms"],
    host_permissions: ["http://localhost:8787/*", "https://*/*"],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "bookmark-sync@syncer.local",
              strict_min_version: "128.0",
              // Declares "this extension collects no data" for Mozilla's
              // built-in consent policy (mandatory for AMO since 2025-11).
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : {}),
  }),
});
