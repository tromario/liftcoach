// Запись подхода: сырое видео с камеры (для тренера) + видео со скелетом и покадровые данные (для разбора)
import { video, drawSkeleton, facing } from "./pose.js";

const MAX_MS = 3 * 60 * 1000;   // не больше 3 минут за раз — чтобы файл не раздувался
let rec = null;                 // активная запись
let last = null;                // готовые файлы последней записи

function pickMime() {
  const opts = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return opts.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

export const isRecording = () => !!rec;
export const lastRecording = () => last;

export function startRecording(meta) {
  if (rec || !window.MediaRecorder) return false;
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, 1280 / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * k); c.height = Math.round(vh * k);
  const g = c.getContext("2d");
  const stream = c.captureStream(30);
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
  const chunks = [];
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec = { c, g, mr, chunks, mime: mr.mimeType || mime, t0: performance.now(), frames: [], meta, stopped: null, raw: null };
  rec.stopped = new Promise(res => { mr.onstop = res; });

  // Сырое видео прямо с камеры — в полном качестве, без разметки
  try {
    const rawMr = new MediaRecorder(video.srcObject, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const rawChunks = [];
    rawMr.ondataavailable = e => e.data.size && rawChunks.push(e.data);
    rec.raw = { mr: rawMr, chunks: rawChunks, stopped: new Promise(res => { rawMr.onstop = res; }) };
    rawMr.start(1000);
  } catch (e) { console.warn("raw recorder", e); }

  mr.start(1000);
  return true;
}

const r4 = v => Math.round(v * 10000) / 10000;

/** Вызывается на каждый кадр из основного цикла */
export function recordFrame(lm, ts, state) {
  if (!rec) return;
  const { c, g } = rec;
  g.save();
  if (facing === "user") { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(video, 0, 0, c.width, c.height);
  if (lm) drawSkeleton(lm, { target: g, w: c.width, h: c.height, highlight: [...Array(33).keys()] });
  g.restore();
  // метка времени на видео — по ней сверяем с данными
  const t = (ts - rec.t0) / 1000;
  g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(8, 8, 150, 30);
  g.fillStyle = "#fff"; g.font = "bold 20px -apple-system,sans-serif";
  g.fillText(`${t.toFixed(2)} s ${state?.state ?? ""}`, 16, 30);

  rec.frames.push({
    t: Math.round(t * 1000) / 1000,
    lm: lm ? lm.map(p => [r4(p.x), r4(p.y), r4(p.z), Math.round((p.visibility ?? 0) * 100) / 100]) : null,
    s: state || null,
  });
  if (ts - rec.t0 > MAX_MS) stopRecording();
}

export async function stopRecording(extra = {}) {
  if (!rec) return null;
  const r = rec; rec = null;
  if (r.mr.state !== "inactive") r.mr.stop();
  if (r.raw && r.raw.mr.state !== "inactive") r.raw.mr.stop();
  await Promise.all([r.stopped, r.raw?.stopped]);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = r.mime.includes("mp4") ? "mp4" : "webm";
  const type = r.mime || "video/mp4";
  const videoFile = new File(r.chunks, `liftcoach-${r.meta.mode}-${stamp}-skeleton.${ext}`, { type });
  const rawFile = r.raw?.chunks.length ? new File(r.raw.chunks, `liftcoach-${r.meta.mode}-${stamp}.${ext}`, { type }) : null;
  const data = {
    app: "liftcoach", version: 1, ...r.meta, recordedAt: new Date().toISOString(),
    video: { width: video.videoWidth, height: video.videoHeight, facing },
    ...extra,
    frames: r.frames,
  };
  const dataFile = new File([JSON.stringify(data)], `liftcoach-${r.meta.mode}-${stamp}.json`, { type: "application/json" });
  last = { videoFile, dataFile, rawFile };
  return last;
}

/**
 * Через меню «Поделиться»: AirDrop, Файлы, Telegram и т.д. Вызывать из нажатия кнопки.
 * what: "coach" — только сырое видео, "analysis" — видео со скелетом + данные
 */
export async function shareLast(what = "analysis") {
  if (!last) return "нет записи";
  const files = what === "coach" ? [last.rawFile || last.videoFile] : [last.videoFile, last.dataFile];
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: "LiftCoach" }); return "ok"; }
    catch (e) { if (e.name === "AbortError") return "отменено"; }
  }
  // запасной путь — скачать по одному
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return "скачано";
}
