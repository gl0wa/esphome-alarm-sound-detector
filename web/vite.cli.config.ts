// Bundles the command-line tool (cli/asd.ts) into ONE file, dist/cli/asd.mjs, with the
// detector WebAssembly inlined: agents only need Node.js 20+ to run it.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "cli/asd.ts",
    outDir: "dist/cli",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "asd.mjs",
        inlineDynamicImports: true,
        banner: "#!/usr/bin/env node\n// asd — alarm sound detector preset tool. https://github.com/gl0wa/esphome-alarm-sound-detector (MIT)",
      },
    },
  },
});
