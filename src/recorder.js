// Запись подхода: сырое видео с камеры + покадровые данные (JSON).
// Видео — тренеру и для разбора; данные — для разбора (скелет по ним восстанавливается).
// Ограничения по длительности нет. Всё копится в памяти телефона (~37 МБ/мин при 5 Мбит/с).
import { video, facing } from "./pose.js";

const BITRATE = 5_000_000;
let rec = null;
let last = null;

function pickMime() {
  const opts = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return opts.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

export const isRecording = () => !!rec;
export const lastRecording = () => last;

export function startRecording(meta) {
  if (rec || !window.MediaRecorder || !video.srcObject) return false;
  const mime = pickMime();
  const mr = new MediaRecorder(video.srcObject, mime ? { mimeType: mime, videoBitsPerSecond: BITRATE } : undefined);
  const chunks = [];
  let bytes = 0;
  mr.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); bytes += e.data.size; if (rec) rec.bytes = bytes; } };
  rec = { mr, chunks, bytes: 0, mime: mr.mimeType || mime, t0: performance.now(), frames: [], meta };
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
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = r.mime.includes("mp4") ? "mp4" : "webm";
  const base = `liftcoach-${r.meta.mode}-${stamp}`;
  const videoFile = new File(r.chunks, `${base}.${ext}`, { type: r.mime || "video/mp4" });
  const data = {
    app: "liftcoach", version: 2, ...r.meta, recordedAt: new Date().toISOString(),
    video: { file: videoFile.name, width: video.videoWidth, height: video.videoHeight, facing },
    note: "t — секунды от начала видео; lm — 33 точки MediaPipe [x, y, z, visibility] в долях кадра",
    ...extra,
    frames: r.frames,
  };
  const dataFile = new File([JSON.stringify(data)], `${base}.json`, { type: "application/json" });
  last = { videoFile, dataFile };
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
