// Готовит public/: копирует wasm MediaPipe из node_modules и скачивает модели позы.
// Запускается автоматически после npm install.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const wasmSrc = "node_modules/@mediapipe/tasks-vision/wasm";
const wasmDst = "public/mediapipe/wasm";
if (existsSync(wasmSrc)) {
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log("✓ MediaPipe wasm →", wasmDst);
}

const MODELS = ["lite", "full", "heavy"];
mkdirSync("public/models", { recursive: true });
for (const m of MODELS) {
  const dst = `public/models/pose_landmarker_${m}.task`;
  if (existsSync(dst)) { console.log("✓", dst, "(уже есть)"); continue; }
  const url = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
    console.log("✓", dst);
  } catch (e) {
    console.warn(`✗ не скачалась модель ${m}: ${e.message}. Повтори: npm run setup`);
  }
}
