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
const view = document.getElementById("view");          // показ обрезанного кадра (зум 0.6–0.8×)
const ctx = canvas.getContext("2d");
const vctx = view.getContext("2d");

// Рабочий кадр: при зуме 0.6–0.8× — центральная часть широкоугольного кадра.
// Все координаты (скелет, px, размеры) — в этом кадре.
export const frame = { w: 0, h: 0, sx: 0, sy: 0, sw: 0, sh: 0, crop: 1 };
export let zoom = 1;                   // 0.5…1 как в «Камере» iPhone
function updateFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const c = lens === "ultra" ? Math.min(1, 0.5 / zoom) : 1;
  frame.crop = c;
  frame.sw = Math.round(vw * c); frame.sh = Math.round(vh * c);
  frame.sx = Math.round((vw - frame.sw) / 2); frame.sy = Math.round((vh - frame.sh) / 2);
  frame.w = frame.sw; frame.h = frame.sh;
}
/** Нарисовать текущий рабочий кадр в контекст g размером w×h */
export function drawFrame(g, w, h) { g.drawImage(video, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, w, h); }

let landmarker = null, loadedModel = null, stream = null;
export let facing = "environment";
export let quality = "720";
const RES = { "720": { width: 1280, height: 720 }, "1080": { width: 1920, height: 1080 } };
let handler = null;
let running = false;

export const loadedModelName = () => loadedModel;

export async function initPose(model) {
  if (landmarker && loadedModel === model) return landmarker.__delegate;
  const fileset = await FilesetResolver.forVisionTasks(BASE + "mediapipe/wasm");
  const opts = delegate => ({
    baseOptions: { modelAssetPath: MODELS[model], delegate },
    runningMode: "VIDEO", numPoses: 2,      // ты + один посторонний; каждый человек — отдельный прогон модели, больше = медленнее
    minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5,
  });
  let delegate = "GPU", next;
  try { next = await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { delegate = "CPU"; next = await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
  next.__delegate = delegate;
  const old = landmarker; landmarker = next; loadedModel = model; old?.close();   // подмена без паузы
  return delegate;
}

export let lens = "wide";            // "wide" — 1×, "ultra" — 0.5×
export let lensNote = "";            // почему 0.5× не включился

async function findUltraWide() {
  const ds = await navigator.mediaDevices.enumerateDevices();
  // iOS отдаёт широкоугольную камеру отдельным устройством (iOS 16.4+); названия зависят от языка системы
  return ds.find(d => d.kind === "videoinput" && /ultra|сверхшир|ультрашир/i.test(d.label)) || null;
}

async function open(constraints) {
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  video.srcObject = stream;
  await video.play();
}

/** Зум 0.5…1: 1 — основная камера; меньше — широкоугольная (+ обрезка до нужного зума) */
export async function setZoom(z) {
  z = Math.max(0.5, Math.min(1, +z || 1));
  const wantLens = z < 0.99 ? "ultra" : "wide";
  zoom = z;
  if (wantLens !== lens || !stream) await startCamera(facing, quality, wantLens);
  if (lens !== "ultra") zoom = 1;       // широкоугольник не дали — остаёмся на 1×
  updateFrame();
  return zoom;
}

export async function startCamera(f = facing, q = quality, l = lens) {
  facing = f; quality = q; lens = l; lensNote = "";
  // при обрезке берём кадр крупнее, чтобы после обрезки не было «мыла»
  const r = l === "ultra" ? RES["1080"] : (RES[q] || RES["720"]);
  const base = { width: { ideal: r.width }, height: { ideal: r.height }, frameRate: { ideal: 30 } };
  if (f === "environment" && l === "ultra") {
    let d = await findUltraWide();
    if (!d && !stream) { await open({ ...base, facingMode: f }); d = await findUltraWide(); }   // названия камер видны только после разрешения
    if (d) await open({ ...base, deviceId: { exact: d.deviceId } });
    else {
      await open({ ...base, facingMode: f });
      // запасной путь: «виртуальная» камера с зумом меньше 1
      const t = stream.getVideoTracks()[0], caps = t.getCapabilities?.() || {};
      if (caps.zoom && caps.zoom.min < 1) { try { await t.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] }); } catch { lens = "wide"; } }
      else { lens = "wide"; lensNote = "Safari не дал широкоугольную камеру 0.5×"; }
    }
  } else {
    await open({ ...base, facingMode: f });
  }
  const m = facing === "user";
  video.classList.toggle("mirror", m); canvas.classList.toggle("mirror", m); view.classList.toggle("mirror", m);
  updateFrame();
  return lens;
}

export const flipCamera = () => startCamera(facing === "environment" ? "user" : "environment");

// ---------- Отслеживание «своего» человека ----------
// До фиксации берём самого крупного в кадре. Фиксация — автоматически, когда крупный человек
// ~1.5 с держится на одном месте (лёг на скамью / встал под гриф), или вручную.
// После фиксации берём того, кто ближе к прошлому положению и похож по размеру.
// Две сильно перекрывающиеся фигуры — это один человек (модель иногда «двоит» ноги и корпус).
let target = null, locked = false, autoLock = false, cand = null;
const TRACK_IDX = [0, 11, 12, 23, 24, 25, 26, 27, 28];   // без рук — их положение сильно меняется

function bodyBox(lm) {
  const pts = TRACK_IDX.map(i => lm[i]).filter(p => (p.visibility ?? 0) > 0.4);
  if (pts.length < 4) return null;
  const W = frame.w, H = frame.h;
  const xs = pts.map(p => p.x * W), ys = pts.map(p => p.y * H);
  const core = [11, 12, 23, 24].map(i => lm[i]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return {
    x: core.reduce((s, p) => s + p.x, 0) / 4 * W,
    y: core.reduce((s, p) => s + p.y, 0) / 4 * H,
    size: Math.hypot(x1 - x0, y1 - y0) || 1,
    x0, x1, y0, y1,
    vis: pts.reduce((s, p) => s + (p.visibility ?? 0), 0) / pts.length,
  };
}

/** Доля перекрытия меньшей рамки большей */
function overlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const area = r => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  return (w * h) / Math.min(area(a), area(b));
}
const score = b => b.size * b.vis;

function pickPerson(list, ts) {
  const boxes = list.map(bodyBox);
  // склейка двойников
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a && b && overlap(a, b) > 0.5) { if (score(a) >= score(b)) boxes[j] = null; else boxes[i] = null; }
  }
  let best = -1;
  if (!locked || !target) {
    let bs = 0;
    boxes.forEach((b, i) => { if (b && score(b) > bs) { bs = score(b); best = i; } });
    // автофиксация: крупный человек держится на месте 1.5 с
    if (autoLock && best >= 0) {
      const b = boxes[best], diag = Math.hypot(frame.w, frame.h);
      if (cand && Math.hypot(b.x - cand.x, b.y - cand.y) < 0.25 * b.size) cand.t1 = ts;
      else cand = { x: b.x, y: b.y, t0: ts, t1: ts };
      if (b.size > 0.22 * diag && cand.t1 - cand.t0 > 1500) { locked = true; lockedNow = true; }
    }
  } else {
    const radius = target.size * (ts - target.t < 500 ? 0.6 : 1.0);   // потеряли — ищем шире
    let bd = Infinity;
    boxes.forEach((b, i) => {
      if (!b) return;
      const ratio = Math.max(b.size / target.size, target.size / b.size);
      const d = Math.hypot(b.x - target.x, b.y - target.y);
      if (ratio < 1.8 && d < radius && d < bd) { bd = d; best = i; }
    });
  }
  if (best >= 0) {
    const b = boxes[best];
    target = target && locked
      ? { x: target.x * 0.5 + b.x * 0.5, y: target.y * 0.5 + b.y * 0.5, size: target.size * 0.8 + b.size * 0.2, t: ts }
      : { ...b, t: ts };
  }
  return best;
}

let lockedNow = false;
/** true один раз — сразу после автофиксации (чтобы сказать «Вижу тебя») */
export function justLocked() { const v = lockedNow; lockedNow = false; return v; }
/** Зафиксировать текущего человека как «своего» */
export function lockTarget() { if (target) locked = true; return locked; }
/** Снять фиксацию — снова берём самого крупного */
export function unlockTarget() { locked = false; target = null; cand = null; }
/** Включить автофиксацию (в режимах присед/жим) */
export function setAutoLock(on) { autoLock = on; }
export const isLocked = () => locked;

/** handler(result, lm|null, ts) вызывается на каждый кадр */
export function setHandler(fn) { handler = fn; }

const inC = document.createElement("canvas"), inG = inC.getContext("2d");

export function startLoop(onFps) {
  if (running) return; running = true;
  let frames = 0, fpsT = performance.now(), lastTs = -1;
  const tick = () => {
    requestAnimationFrame(tick);
    if (video.readyState < 2 || !landmarker) return;
    if (!frame.w || frame.sw + frame.sx * 2 !== video.videoWidth) updateFrame();
    if (canvas.width !== frame.w || canvas.height !== frame.h) { canvas.width = frame.w; canvas.height = frame.h; }
    // показ: обычный зум — сам <video>; обрезка — рисуем кадр на #view
    const cropped = frame.crop < 0.999;
    video.style.visibility = cropped ? "hidden" : "visible"; view.hidden = !cropped;
    if (cropped) {
      if (view.width !== frame.w || view.height !== frame.h) { view.width = frame.w; view.height = frame.h; }
      drawFrame(vctx, frame.w, frame.h);
    }
    const ts = performance.now(); if (ts <= lastTs) return; lastTs = ts;
    // модели хватает 640 px по длинной стороне: меньше данных гоним в GPU — выше FPS
    const k = Math.min(1, 640 / Math.max(frame.w, frame.h));
    const iw = Math.round(frame.w * k), ih = Math.round(frame.h * k);
    if (inC.width !== iw || inC.height !== ih) { inC.width = iw; inC.height = ih; }
    drawFrame(inG, iw, ih);
    const res = landmarker.detectForVideo(inC, ts);
    frames++;
    if (ts - fpsT > 1000) { onFps?.(Math.round(frames * 1000 / (ts - fpsT))); frames = 0; fpsT = ts; }
    const all = res.landmarks || [];
    const idx = all.length ? pickPerson(all, ts) : -1;
    const lm = idx >= 0 ? all[idx] : null;
    if (!lm) clear();
    handler?.(res, lm, ts);
    // остальные люди — тонким серым, чтобы было видно, что их игнорируем
    all.forEach((o, i) => { if (i !== idx) drawOther(o); });
  };
  requestAnimationFrame(tick);
}

/** Точка в пикселях кадра */
export const px = (lm, i) => ({ x: lm[i].x * frame.w, y: lm[i].y * frame.h, v: lm[i].visibility ?? 1 });

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

function drawOther(lm) {
  const w = canvas.width, h = canvas.height;
  ctx.lineWidth = Math.max(1.5, w / 600); ctx.strokeStyle = "rgba(160,160,160,.45)"; ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    if ((lm[a].visibility ?? 0) < .3 || (lm[b].visibility ?? 0) < .3) continue;
    ctx.beginPath(); ctx.moveTo(lm[a].x * w, lm[a].y * h); ctx.lineTo(lm[b].x * w, lm[b].y * h); ctx.stroke();
  }
}

/** Снимок кадра со скелетом → JPEG dataURL (уменьшенный, чтобы влезал в хранилище) */
export function snapshot(lm, maxSide = 1080) {
  const k = Math.min(1, maxSide / Math.max(frame.w, frame.h));
  const w = Math.round(frame.w * k), h = Math.round(frame.h * k);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (facing === "user") { g.translate(w, 0); g.scale(-1, 1); }
  drawFrame(g, w, h);
  if (lm) drawSkeleton(lm, { target: g, w, h, highlight: [...Array(33).keys()] });
  return c.toDataURL("image/jpeg", 0.82);
}
