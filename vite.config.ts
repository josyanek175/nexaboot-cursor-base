// Configuração Vite para deploy como Node server (Easypanel/VM).
// Alvo Nitro = "node-server": gera .output/server/index.mjs (auto-contido),
// iniciado com `node .output/server/index.mjs` e escutando em PORT.
//
// IMPORTANTE: NÃO usamos mais @lovable.dev/vite-tanstack-config nem
// @cloudflare/vite-plugin — o build deixou de ter como alvo o Cloudflare Workers.
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // Resolve o alias "@/* -> ./src/*" a partir do tsconfig.json.
    tsConfigPaths(),
    tailwindcss(),
    // target define o preset do Nitro. node-server => servidor Node tradicional.
    tanstackStart({ target: "node-server" }),
    // Plugin React deve vir depois do tanstackStart.
    viteReact(),
  ],
});
