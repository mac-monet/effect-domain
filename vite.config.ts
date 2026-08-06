import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    ignorePatterns: ["examples/foldkit-app", "examples/foldkit-server-app"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
