// Запись подхода: сырое видео с камеры + покадровые данные (JSON).
// Видео — тренеру и для разбора; данные — для разбора (скелет по ним восстанавливается).
// Ограничения по длительности нет. Всё копится в памяти телефона.
// 720p — 5 Мбит/с (~37 МБ/мин), 1080p — 10 Мбит/с (~75 МБ/мин). Звук — по настройке.
import { video, facing, quality, drawSkeleton, frame, drawFrame } from "./pose.js";
import * as pose from "./pose.js";

const BITRATE = { "720": 5_000_000, "1080": 10_000_000 };
let rec = null;
let last = null;

function pickMime() {
  const opts = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return opts.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

export const isRecording = () => !!rec;
export const lastRecording = () => last;

/** Микрофон берём только на время записи — после стопа AirPods возвращаются в обычный режим */
async function getMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false });
    return s.getAudioTracks()[0] || null;
  } catch (e) { console.warn("mic", e); return null; }
}

let starting = false;
export async function startRecording(meta, { audio = false, skeleton = false } = {}) {
  if (rec || starting || !window.MediaRecorder || !video.srcObject) return false;
  starting = true;
  const mime = pickMime();
  const mic = audio ? await getMic() : null;
  starting = false;
  // Скелет на видео: пишем не камеру, а холст, на котором рисуем кадр + скелет
  // при зуме 0.6–0.8× тоже пишем с холста — с обрезанным кадром
  let c = null, g = null, videoTracks = video.srcObject.getVideoTracks();
  const cropped = frame.crop < 0.999;
  if (skeleton || cropped) {
    const vw = frame.w, vh = frame.h, k = Math.min(1, (quality === "1080" ? 1920 : 1280) / Math.max(vw, vh));
    c = document.createElement("canvas"); c.width = Math.round(vw * k); c.height = Math.round(vh * k);
    g = c.getContext("2d");
    drawFrame(g, c.width, c.height);
    videoTracks = c.captureStream(30).getVideoTracks();
  }
  const tracks = [...videoTracks, ...(mic ? [mic] : [])];
  const src = new MediaStream(tracks);
  const opts = { videoBitsPerSecond: BITRATE[quality] || BITRATE["720"], ...(mic ? { audioBitsPerSecond: 128_000 } : {}) };
  if (mime) opts.mimeType = mime;
  const mr = new MediaRecorder(src, opts);
  const chunks = [];
  let bytes = 0;
  mr.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); bytes += e.data.size; if (rec) rec.bytes = bytes; } };
  rec = { mr, chunks, bytes: 0, mime: mr.mimeType || mime, t0: performance.now(), frames: [], meta, mic, audioWanted: audio, c, g, skeleton };
  rec.stopped = new Promise(res => { mr.onstop = res; });
  mr.start(1000);
  return true;
}

/** Прошло времени и сколько записано — для кнопки */
export function recordingStatus() {
  if (!rec) return null;
  return { sec: (performance.now() - rec.t0) / 1000, mb: rec.bytes / 1e6 };
}

const r4 = v => Math.round(v * 10000) / 10000;

/** Вызывается на каждый кадр: сохраняет точки скелета и состояние режима */
export function recordFrame(lm, ts, state) {
  if (!rec) return;
  if (rec.c) {
    const { c, g } = rec;
    g.save();
    if (facing === "user") { g.translate(c.width, 0); g.scale(-1, 1); }
    drawFrame(g, c.width, c.height);
    if (lm && rec.skeleton) drawSkeleton(lm, { target: g, w: c.width, h: c.height, highlight: [...Array(33).keys()] });
    g.restore();
  }
  if (rec.c && rec.skeleton) {
    const { c, g } = rec;
    // время от начала записи и фаза — по ним видео сверяется с данными
    const label = `${((ts - rec.t0) / 1000).toFixed(1)} с${state?.state ? " · " + state.state : ""}`;
    const fs = Math.round(c.height / 32);
    g.font = `600 ${fs}px -apple-system,sans-serif`;
    const tw = g.measureText(label).width;
    g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(fs * .5, fs * .5, tw + fs, fs * 1.6);
    g.fillStyle = "#fff"; g.fillText(label, fs, fs * 1.6);
  }
  rec.frames.push({
    t: Math.round(ts - rec.t0) / 1000,
    lm: lm ? lm.map(p => [r4(p.x), r4(p.y), r4(p.z), Math.round((p.visibility ?? 0) * 100) / 100]) : null,
    s: state || null,
  });
}

export async function stopRecording(extra = {}) {
  if (!rec) return null;
  const r = rec; rec = null;
  if (r.mr.state !== "inactive") r.mr.stop();
  await r.stopped;
  r.mic?.stop();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = r.mime.includes("mp4") ? "mp4" : "webm";
  const base = `liftcoach-${r.meta.mode}-${stamp}`;
  const videoFile = new File(r.chunks, `${base}.${ext}`, { type: r.mime || "video/mp4" });
  const data = {
    app: "liftcoach", version: 2, ...r.meta, recordedAt: new Date().toISOString(),
    video: { file: videoFile.name, width: r.c ? r.c.width : video.videoWidth, height: r.c ? r.c.height : video.videoHeight, facing, quality, audio: !!r.mic, skeleton: !!r.skeleton, zoom: pose.lens === "ultra" ? pose.zoom : 1 },
    note: "t — секунды от начала видео; lm — 33 точки MediaPipe [x, y, z, visibility] в долях кадра",
    ...extra,
    frames: r.frames,
  };
  const dataFile = new File([JSON.stringify(data)], `${base}.json`, { type: "application/json" });
  last = { videoFile, dataFile, audio: !!r.mic, audioWanted: r.audioWanted, skeleton: !!r.skeleton };
  return last;
}

/**
 * Меню «Поделиться»: AirDrop, Файлы, мессенджеры. Вызывать из нажатия кнопки.
 * what: "coach" — только видео, "analysis" — видео + данные
 */
export async function shareLast(what = "analysis") {
  if (!last) return "нет записи";
  const files = what === "coach" ? [last.videoFile] : [last.videoFile, last.dataFile];
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: "LiftCoach" }); return "ok"; }
    catch (e) { if (e.name === "AbortError") return "отменено"; }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return "скачано";
}
