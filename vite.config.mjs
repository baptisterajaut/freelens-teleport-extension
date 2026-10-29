// Builds the extension's two entry points, one per run: the renderer with
// `vite build`, the main entry with `vite build --mode main`. Taken from
// freelens-example-extension, minus the React, decorator and CSS plugins this
// extension has no use for.

import { builtinModules, isBuiltin } from "node:module";
import { defaultServerConditions, defaultServerMainFields, defineConfig } from "vite";
import { hostModules } from "./build/vite-plugin-host-modules.mjs";

const entryPoints = {
  renderer: {
    entry: "src/renderer/index.ts",
    // First of the two runs in `build`, so it clears the output directory.
    // `dev` turns this off: in watch mode Vite empties the directory again on
    // every rebuild, which would delete the main entry.
    emptyOutDir: true,
    // Renderer code gets no guarantee of Node or Electron.
    external: [],
    platform: /** @type {const} */ ("browser"),
  },
  main: {
    entry: "src/main/index.ts",
    emptyOutDir: false,
    external: ["electron", /^electron\//, /^node:/, ...builtinModules],
    platform: /** @type {const} */ ("node"),
  },
};

/**
 * Fails the renderer build on an import of Node or Electron. Vite would replace
 * a builtin with an empty module and only warn.
 *
 * @type {import("vite").Plugin}
 */
const noNodeInRenderer = {
  name: "no-node-in-renderer",
  enforce: "pre",
  resolveId(source, importer) {
    if (isBuiltin(source) || source === "electron" || source.startsWith("electron/")) {
      this.error(`"${source}" is imported by ${importer}, but renderer code gets no Node or Electron`);
    }
    return null;
  },
};

export default defineConfig(({ mode }) => {
  const name = mode === "main" ? "main" : "renderer";
  const entryPoint = entryPoints[name];

  return {
    plugins: [hostModules(name), ...(name === "renderer" ? [noNodeInRenderer] : [])],
    ...(name === "renderer"
      ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } }
      : { resolve: { conditions: [...defaultServerConditions], mainFields: [...defaultServerMainFields] } }),
    build: {
      target: "esnext",
      minify: false,
      sourcemap: true,
      emptyOutDir: entryPoint.emptyOutDir,
      lib: {
        entry: entryPoint.entry,
        formats: ["es"],
        fileName: () => `${name}.js`,
      },
      rolldownOptions: {
        external: entryPoint.external,
        platform: entryPoint.platform,
      },
    },
  };
});
