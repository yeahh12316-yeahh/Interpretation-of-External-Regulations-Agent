import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const projectRequire = createRequire(import.meta.url);
const tesseractRequire = createRequire(
  projectRequire.resolve("tesseract.js/package.json"),
);

const ocrAssets = new Map<string, { source: string; contentType: string }>();

const registerAsset = (target: string, source: string, contentType: string) =>
  ocrAssets.set(`/ocr/${target}`, { source, contentType });

registerAsset(
  "tesseract/worker.min.js",
  projectRequire.resolve("tesseract.js/dist/worker.min.js"),
  "text/javascript; charset=utf-8",
);
for (const name of [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
]) {
  registerAsset(
    `tesseract-core/${name}`,
    tesseractRequire.resolve(`tesseract.js-core/${name}`),
    name.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "application/wasm",
  );
}
for (const language of ["chi_sim", "eng"] as const) {
  registerAsset(
    `lang/${language}.traineddata.gz`,
    projectRequire.resolve(
      `@tesseract.js-data/${language}/4.0.0/${language}.traineddata.gz`,
    ),
    "application/gzip",
  );
}

const localOcrAssets = (): Plugin => ({
  name: "local-ocr-assets",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const asset = ocrAssets.get(pathname);
      if (!asset) return next();
      response.statusCode = 200;
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader(
        "Cache-Control",
        "public, max-age=31536000, immutable",
      );
      createReadStream(asset.source).pipe(response);
    });
  },
  generateBundle() {
    for (const [target, asset] of ocrAssets) {
      this.emitFile({
        type: "asset",
        fileName: target.slice(1),
        source: readFileSync(asset.source),
      });
    }
  },
});

export default defineConfig({
  plugins: [react(), localOcrAssets()],
});
