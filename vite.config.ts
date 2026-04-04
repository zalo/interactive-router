import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

const autorouterRoot = path.resolve(__dirname, "../tscircuit-autorouter")

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "polyanya", replacement: path.resolve(__dirname, "../polyanya-ts/lib/index.ts") },
      { find: "@tscircuit/capacity-autorouter", replacement: path.resolve(autorouterRoot, "lib/index.ts") },
      // The autorouter uses bare "lib/" imports resolved via tsconfig paths
      { find: /^lib\/(.*)/, replacement: path.resolve(autorouterRoot, "lib/$1") },
    ],
  },
  build: {
    target: "esnext",
  },
})
