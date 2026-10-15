import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Served from https://kucukkanat.github.io/whip/ ; routes are hash-based so any static host works.
export default defineConfig({ base: "/whip/", plugins: [react(), tailwindcss()] });
