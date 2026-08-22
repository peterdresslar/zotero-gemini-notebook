import { rm } from "node:fs/promises";

import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const updateFilename = pkg.version.includes("-")
  ? "update-beta.json"
  : "update.json";
const unusedUpdateFilename =
  updateFilename === "update.json" ? "update-beta.json" : "update.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: pkg.name,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${updateFilename}`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    hooks: {
      "build:done": async ({ dist }) => {
        // Scaffold always emits update-beta.json. Keep only the manifest that
        // this package actually references so release output is unambiguous.
        await rm(`${dist}/${unusedUpdateFilename}`, { force: true });
      },
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
