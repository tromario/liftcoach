import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

// base "./" — чтобы сборка работала и в корне домена, и в подпапке GitHub Pages
export default defineConfig({
  base: "./",
  plugins: [mkcert()],          // доверенный HTTPS-сертификат для локальной сети
  server: { host: true, port: 5173 },   // host: true — доступ с айфона по IP мака
  preview: { host: true, port: 4173 },
});
