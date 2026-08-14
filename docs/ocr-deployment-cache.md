# OCR deployment cache contract

The OCR worker, core/WASM, and language data are published under the versioned
namespace `/ocr/tesseract-7.0.0-data-1.0.0/`. A deployment must apply
`Cache-Control: public, max-age=31536000, immutable` only to that versioned
namespace. `vite build` emits `ocr-cache-policy.json` with the machine-readable
path pattern and header value.

When Tesseract.js, Tesseract core, or either language-data package changes, the
namespace in `ocr-assets.ts` must change in the same release. Development assets
use `Cache-Control: no-store`, so a local upgrade cannot reuse an incompatible
worker/core/data combination.
