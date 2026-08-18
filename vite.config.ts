import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import {
  OCR_ASSET_PUBLIC_PATH,
  OCR_ASSET_NAMESPACE,
  OCR_DEVELOPMENT_CACHE_CONTROL,
  OCR_PRODUCTION_CACHE_CONTROL,
} from "./src/features/parsing/ocr/ocr-assets";

const projectRequire = createRequire(import.meta.url);
const tesseractRequire = createRequire(
  projectRequire.resolve("tesseract.js/package.json"),
);

const ocrAssets = new Map<string, { source: string; contentType: string }>();
const ocrCachePolicy = {
  namespace: OCR_ASSET_NAMESPACE,
  pathPattern: `/${OCR_ASSET_PUBLIC_PATH}/*`,
  cacheControl: OCR_PRODUCTION_CACHE_CONTROL,
  rule: "Only versioned OCR assets may be cached immutably; change the namespace whenever worker, core, or language data versions change.",
};
const serializedOcrCachePolicy = `${JSON.stringify(ocrCachePolicy, null, 2)}\n`;

const registerAsset = (target: string, source: string, contentType: string) =>
  ocrAssets.set(`/${OCR_ASSET_PUBLIC_PATH}/${target}`, {
    source,
    contentType,
  });

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
      if (pathname === "/ocr-cache-policy.json") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", OCR_DEVELOPMENT_CACHE_CONTROL);
        response.end(serializedOcrCachePolicy);
        return;
      }
      const asset = ocrAssets.get(pathname);
      if (!asset) return next();
      response.statusCode = 200;
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader("Cache-Control", OCR_DEVELOPMENT_CACHE_CONTROL);
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
    this.emitFile({
      type: "asset",
      fileName: "ocr-cache-policy.json",
      source: serializedOcrCachePolicy,
    });
  },
});

export default defineConfig({
  base:
    process.env.GITHUB_ACTIONS === "true"
      ? "/Interpretation-of-External-Regulations-Agent/"
      : "/",
  define: {
    "import.meta.env.VITE_MODEL_PROXY_URL": JSON.stringify(
      process.env.VITE_MODEL_PROXY_URL?.trim() ||
        (process.env.VERCEL === "1" ? "/api/model-proxy" : ""),
    ),
  },
  plugins: [react(), localOcrAssets()],
});
