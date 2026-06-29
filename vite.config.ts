// Configuração Vite para deploy como Node server (Easypanel/VM).
//
// O plugin nitro() (de "nitro/vite") é o que faz o build gerar
// `.output/server/index.mjs` — um servidor Node real (com listen()),
// iniciado por `node .output/server/index.mjs`.
//
// Sem o nitro(), o tanstackStart faz apenas o build SSR em `dist/`
// (handler { fetch }, sem servidor HTTP permanente).
//
// Preset do Nitro: node-server (padrão em ambiente sem plataforma detectada;
// reforçado por NITRO_PRESET=node-server no build do Dockerfile).
// NÃO usamos Cloudflare Workers nem Rsbuild.
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // Resolve o alias "@/* -> ./src/*" a partir do tsconfig.json.
    tsConfigPaths(),
    tailwindcss(),
    tanstackStart(),
    // Gera a saída Nitro em .output/ (preset node-server).
    nitro(),
    // Plugin React deve vir depois do tanstackStart/nitro.
    viteReact(),
  ],
});
