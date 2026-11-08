// Камера + MediaPipe Pose + отрисовка скелета. Один цикл на все режимы.
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const BASE = import.meta.env.BASE_URL;
const MODELS = {
  lite:  BASE + "models/pose_landmarker_lite.task",
  full:  BASE + "models/pose_landmarker_full.task",
  heavy: BASE + "models/pose_landmarker_heavy.task",
};

export const video = document.getElementById("video");
export const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let landmarker = null, loadedModel = null, stream = null;
export let facing = "environment";
export let quality = "720";
const RES = { "720": { width: 1280, height: 720 }, "1080": { width: 1920, height: 1080 } };
let handler = null;
let running = false;

export async function initPose(model) {
  if (landmarker && loadedModel === model) return landmarker.__delegate;
  landmarker?.close();
  const fileset = await FilesetResolver.forVisionTasks(BASE + "mediapipe/wasm");
  const opts = delegate => ({
    baseOptions: { modelAssetPath: MODELS[model], delegate },
    runningMode: "VIDEO", numPoses: 1,
    minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5,
  });
  let delegate = "GPU";
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { delegate = "CPU"; landmarker = await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
  landmarker.__delegate = delegate;
  loadedModel = model;
  return delegate;
}

export async function startCamera(f = facing, q = quality) {
  facing = f; quality = q;
  const r = RES[q] || RES["720"];
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: r.width }, height: { ideal: r.height }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play();
  const m = facing === "user";
  video.classList.toggle("mirror", m); canvas.classList.toggle("mirror", m);
}

export const flipCamera = () => startCamera(facing === "environment" ? "user" : "environment");

/** handler(result, lm|null, ts) вызывается на каждый кадр */
export function setHandler(fn) { handler = fn; }

export function startLoop(onFps) {
  if (running) return; running = true;
  let frames = 0, fpsT = performance.now(), lastTs = -1;
  const tick = () => {
    requestAnimationFrame(tick);
    if (video.readyState < 2 || !landmarker) return;
    if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    const ts = performance.now(); if (ts <= lastTs) return; lastTs = ts;
    const res = landmarker.detectForVideo(video, ts);
    frames++;
    if (ts - fpsT > 1000) { onFps?.(Math.round(frames * 1000 / (ts - fpsT))); frames = 0; fpsT = ts; }
    const lm = res.landmarks?.[0] || null;
    if (!lm) clear();
    handler?.(res, lm, ts);
  };
  requestAnimationFrame(tick);
}

/** Точка в пикселях кадра */
export const px = (lm, i) => ({ x: lm[i].x * video.videoWidth, y: lm[i].y * video.videoHeight, v: lm[i].visibility ?? 1 });

export function clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); }

const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];

export function drawSkeleton(lm, { highlight = [], color = "#ff5a36", target = ctx, w = canvas.width, h = canvas.height } = {}) {
  if (target === ctx) ctx.clearRect(0, 0, w, h);
  target.lineWidth = Math.max(3, w / 250); target.lineCap = "round";
  const P = i => ({ x: lm[i].x * w, y: lm[i].y * h, v: lm[i].visibility ?? 1 });
  for (const [a, b] of BONES) {
    const A = P(a), B = P(b);
    if (A.v < .3 || B.v < .3) continue;
    target.strokeStyle = highlight.includes(a) && highlight.includes(b) ? color : "rgba(255,255,255,.6)";
    target.beginPath(); target.moveTo(A.x, A.y); target.lineTo(B.x, B.y); target.stroke();
  }
  for (let i = 0; i < 33; i++) {
    if (i > 0 && i < 11 && i !== 2 && i !== 5) continue; // из головы рисуем нос и глаза
    const p = P(i); if (p.v < .3) continue;
    target.fillStyle = p.v > .7 ? "#3ddc84" : "#ffcc00";
    target.beginPath(); target.arc(p.x, p.y, Math.max(4, w / 180), 0, 7); target.fill();
  }
}

/** Снимок кадра со скелетом → JPEG dataURL (уменьшенный, чтобы влезал в хранилище) */
export function snapshot(lm, maxSide = 1080) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.round(vw * k), h = Math.round(vh * k);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (facing === "user") { g.translate(w, 0); g.scale(-1, 1); }
  g.drawImage(video, 0, 0, w, h);
  if (lm) drawSkeleton(lm, { target: g, w, h, highlight: [...Array(33).keys()] });
  return c.toDataURL("image/jpeg", 0.82);
}
