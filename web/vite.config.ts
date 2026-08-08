import { defineConfig } from "vite";

// GitHub Pages serves project sites from /<repo-name>/, not the domain
// root, so production builds need every asset URL prefixed accordingly.
// The dev server ignores `base` for its own root, so this doesn't affect
// `npm run dev`.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
});
