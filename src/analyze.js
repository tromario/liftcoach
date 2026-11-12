// Разбор ранее снятого видео (или JSON записи приложения) тем же анализом, что и вживую.
// Видео прогоняется кадр за кадром через MediaPipe; подсказки не звучат, а собираются с отметкой времени.
// JSON с точками скелета (записи LiftCoach) разбирается мгновенно — без повторного распознавания.
import { detectFile, setFileFrame, pauseLoop, resetFrame, unlockTarget, setAutoLock, isLying, isStanding, BONES } from "./pose.js";
import { setSink } from "./voice.js";
import { muteBeep } from "./audio.js";
import { squatStart, squatFrame, squatEndSet, squatDebug, squatHistory } from "./squat.js";
import { benchStart, benchFrame, benchEndSet, benchDebug, benchHistory } from "./bench.js";
import { deadliftStart, deadliftFrame, deadliftEndSet, deadliftDebug, deadliftHistory } from "./deadlift.js";

const $ = id => document.getElementById(id);
const MODES = {
  squat:    { name: "Присед", start: squatStart, frame: squatFrame, end: squatEndSet, dbg: squatDebug, hist: squatHistory, panel: "sqPanel", pose: isStanding },
  bench:    { name: "Жим", start: benchStart, frame: benchFrame, end: benchEndSet, dbg: benchDebug, hist: benchHistory, panel: "bpPanel", pose: isLying },
  deadlift: { name: "Тяга", start: deadliftStart, frame: deadliftFrame, end: deadliftEndSet, dbg: deadliftDebug, hist: deadliftHistory, panel: "dlPanel", pose: isStanding },
};
const SAMPLES_PER_SEC = 18;     // столько кадров на секунду видео хотим разобрать (как вживую)

let videoFile = null, jsonFile = null, running = false, stopReq = false;
let result = null;              // { mode, style, frames, cues, history, w, h }
let ctx = null;                 // { st, ensureModel }

const r4 = v => Math.round(v * 1e4) / 1e4, r2 = v => Math.round((v ?? 0) * 100) / 100;
const packLm = lm => lm ? lm.map(p => [r4(p.x), r4(p.y), r4(p.z ?? 0), r2(p.visibility)]) : null;
const unpackLm = a => a ? a.map(p => ({ x: p[0], y: p[1], z: p[2], visibility: p[3] })) : null;
const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const prog = t => { $("anProg").textContent = t; };

export function analyzeInit(st, ensureModel) {
  ctx = { st, ensureModel };
  $("anFile").onchange = e => pickFiles([...e.target.files]);
  $("anRun").onclick = run;
  $("anStop").onclick = () => { stopReq = true; };
  $("anSave").onclick = saveJson;
  $("anMode").value = st.dlStyle === "sumo" ? "sumo" : "conv";
}

export function analyzeOpen() {
  $("anMode").value ||= "conv";
  updateButtons();
}

/** Выход из экрана разбора: вернуть живой цикл в обычное состояние */
export function analyzeClose() {
  stopReq = true;
  const v = $("anVideo"); v.pause();
}

function pickFiles(list) {
  videoFile = list.find(f => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(f.name)) || null;
  jsonFile = list.find(f => f.type === "application/json" || /\.json$/i.test(f.name)) || null;
  const names = [videoFile && "видео: " + videoFile.name, jsonFile && "данные: " + jsonFile.name].filter(Boolean);
  $("anFiles").textContent = names.join(" · ") || "Нет подходящих файлов";
  result = null; $("anCues").innerHTML = ""; $("anPanel").innerHTML = ""; $("anSave").hidden = true;
  if (jsonFile) peekJson(jsonFile);
  if (videoFile) showVideo(videoFile); else $("anWrap").hidden = true;
  prog(jsonFile ? "Есть данные записи — разбор будет быстрым, без распознавания." : videoFile ? "Видео будет разобрано кадр за кадром — примерно со скоростью воспроизведения." : "");
  updateButtons();
}

async function peekJson(f) {
  try {
    const J = JSON.parse(await f.text());
    if (J.mode === "squat" || J.mode === "bench") $("anMode").value = J.mode;
    else if (J.mode === "deadlift") $("anMode").value = J.settings?.dlStyle === "sumo" ? "sumo" : "conv";
  } catch { prog("Не получилось прочитать JSON"); jsonFile = null; updateButtons(); }
}

function updateButtons() {
  $("anRun").disabled = running || !(videoFile || jsonFile);
  $("anRun").hidden = running; $("anStop").hidden = !running;
}

function modeOf(sel) { return sel === "conv" || sel === "sumo" ? { key: "deadlift", style: sel } : { key: sel, style: null }; }

// ---------- видео на экране + скелет поверх ----------
function showVideo(f) {
  const v = $("anVideo"), wrap = $("anWrap");
  if (v.dataset.url) URL.revokeObjectURL(v.dataset.url);
  v.dataset.url = URL.createObjectURL(f);
  v.src = v.dataset.url; v.muted = true; v.playsInline = true; v.controls = false;
  wrap.hidden = false;
  v.onloadedmetadata = () => {
    wrap.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
    const c = $("anOver"); c.width = v.videoWidth; c.height = v.videoHeight;
    try { v.currentTime = 0.01; } catch {}
  };
  startOverlay();
}

let overlayOn = false;
function startOverlay() {
  if (overlayOn) return; overlayOn = true;
  const v = $("anVideo"), c = $("anOver"), g = c.getContext("2d");
  const tick = () => {
    requestAnimationFrame(tick);
    if (running || !result?.frames?.length || $("anWrap").hidden) return;
    g.clearRect(0, 0, c.width, c.height);
    const fr = nearest(result.frames, v.currentTime);
    if (fr?.lm) drawLm(g, fr.lm, c.width, c.height);
  };
  requestAnimationFrame(tick);
}
function nearest(frames, t) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frames[mid].t <= t) lo = mid; else hi = mid - 1; }
  const f = frames[lo];
  return f && Math.abs(f.t - t) < 0.25 ? f : null;
}
function drawLm(g, lm, w, h) {
  g.lineWidth = Math.max(3, w / 250); g.lineCap = "round"; g.strokeStyle = "rgba(255,90,54,.9)";
  for (const [a, b] of BONES) {
    if (lm[a][3] < .3 || lm[b][3] < .3) continue;
    g.beginPath(); g.moveTo(lm[a][0] * w, lm[a][1] * h); g.lineTo(lm[b][0] * w, lm[b][1] * h); g.stroke();
  }
  g.fillStyle = "#3ddc84";
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (lm[i][3] < .3) continue;
    g.beginPath(); g.arc(lm[i][0] * w, lm[i][1] * h, Math.max(4, w / 180), 0, 7); g.fill();
  }
}

// ---------- разбор ----------
async function run() {
  if (running || !(videoFile || jsonFile)) return;
  const { key, style } = modeOf($("anMode").value);
  let M = MODES[key];
  running = true; stopReq = false; updateButtons();
  const cues = [];
  let clockMs = 0, reps = 0;
  // отметка «Повтор N» в списке — чтобы прыгать к каждому повтору
  const repMark = t => {
    const h = M.hist(); const n = (h?.sets || []).reduce((a, x) => a + x.length, 0);
    if (n > reps) { reps = n; cues.push({ t, text: `Повтор ${n}`, rep: true }); }
  };
  setSink((text, force) => cues.push({ t: clockMs / 1000, text, force }), () => clockMs);
  muteBeep(true); pauseLoop(true);
  unlockTarget(); setAutoLock(true, M.pose);
  let wake = null; try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  try {
    const settings = { ...ctx.st, liveCues: true, judge: "off", ...(style ? { dlStyle: style } : {}) };
    let frames, w, h, modeKey = key;
    if (jsonFile) {
      const J = JSON.parse(await jsonFile.text());
      if (MODES[J.mode]) { modeKey = J.mode; M = MODES[modeKey]; }
      if (modeKey === "deadlift") settings.dlStyle = J.mode === "deadlift" && J.settings?.dlStyle ? J.settings.dlStyle : (style || "conv");
      w = J.video?.width || 720; h = J.video?.height || 1280;
      setFileFrame(w, h);
      M.start(settings);
      frames = [];
      for (const fr of J.frames || []) {
        clockMs = fr.t * 1000;
        M.frame({}, unpackLm(fr.lm), clockMs); repMark(fr.t);
        frames.push({ t: fr.t, lm: fr.lm, s: M.dbg() });
      }
      prog(`Разобрано по данным записи: ${mmss(frames.at(-1)?.t || 0)}.`);
    } else {
      await ctx.ensureModel();
      M.start(settings);
      ({ frames, w, h } = await runVideo(M, ms => { clockMs = ms; }, repMark));
    }
    clockMs += 1;
    M.end();
    result = { mode: modeKey, style: modeKey === "deadlift" ? settings.dlStyle : null, frames, cues, history: M.hist(), w, h, settings };
    showResult(M, cues);
  } catch (e) {
    prog("Ошибка разбора: " + (e.message || e)); console.error(e);
  } finally {
    setSink(null); muteBeep(false); setAutoLock(false); unlockTarget(); resetFrame(); pauseLoop(false);
    try { await wake?.release(); } catch {}
    running = false; updateButtons();
  }
}

function runVideo(M, setClock, onFrame) {
  const v = $("anVideo");
  return new Promise(async (resolve, reject) => {
    if (!v.videoWidth) await new Promise(r => v.addEventListener("loadedmetadata", r, { once: true }));
    const w = v.videoWidth, h = v.videoHeight, dur = v.duration || 0;
    const frames = [];
    const oc = $("anOver"), og = oc.getContext("2d");
    if (oc.width !== w || oc.height !== h) { oc.width = w; oc.height = h; }
    let lastT = -1, n = 0, t0 = performance.now(), done = false;
    const finish = () => {
      if (done) return; done = true;
      v.pause(); v.playbackRate = 1; v.controls = true;
      prog(`Разобрано: ${mmss(lastT)} видео, ${frames.length} кадров.` + (stopReq ? " Остановлено вручную." : ""));
      resolve({ frames, w, h });
    };
    const step = (_now, meta) => {
      if (done) return;
      if (stopReq) return finish();
      const t = meta?.mediaTime ?? v.currentTime;
      if (t > lastT + 0.001) {
        lastT = t; setClock(t * 1000);
        const { res, lm } = detectFile(v, w, h, t * 1000);
        M.frame(res, lm, t * 1000); onFrame(t);
        const pk = packLm(lm);
        frames.push({ t: +t.toFixed(3), lm: pk, s: M.dbg() });
        og.clearRect(0, 0, oc.width, oc.height); if (pk) drawLm(og, pk, oc.width, oc.height);
        n++;
        // скорость воспроизведения под производительность телефона: ~18 разобранных кадров на секунду видео
        if (n % 15 === 0) {
          const procFps = n / ((performance.now() - t0) / 1000);
          v.playbackRate = Math.max(0.25, Math.min(1, procFps / SAMPLES_PER_SEC));
          prog(`Разбор: ${mmss(t)} / ${mmss(dur)} · ${Math.round(procFps)} к/с · скорость ×${v.playbackRate.toFixed(2)}`);
        }
      }
      if (v.ended || (dur && t >= dur - 0.04)) return finish();
      schedule();
    };
    const schedule = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(() => step(0, null)));
    v.addEventListener("ended", finish, { once: true });
    try {
      v.controls = false; v.currentTime = 0;
      await v.play();
    } catch (e) { reject(new Error("видео не воспроизводится: " + (e.message || e))); return; }
    schedule();
  });
}

function showResult(M, cues) {
  $("anPanel").innerHTML = $(M.panel).innerHTML || "<span class='mut'>Повторов не найдено</span>";
  const short = cues.filter(c => c.text.length <= 80);
  const list = $("anCues");
  list.innerHTML = short.some(c => !c.rep) ? "" : `<div class="mut small">Подсказок по ходу не было — итог ниже</div>`;
  for (const c of short) {
    const b = document.createElement("button");
    b.className = "an-cue" + (c.rep ? " rep" : c.force ? " f" : "");
    b.innerHTML = `<b>${mmss(c.t)}</b> ${c.text.replace(/</g, "&lt;")}`;
    b.onclick = () => { const v = $("anVideo"); if (!v.src) return; v.currentTime = Math.max(0, c.t - 2); v.play().catch(() => {}); };
    list.appendChild(b);
  }
  $("anSave").hidden = false;
}

async function saveJson() {
  if (!result) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const name = `liftcoach-${result.mode}-razbor-${stamp}.json`;
  const data = {
    app: "liftcoach", version: 2, mode: result.mode, source: "file",
    settings: result.settings, recordedAt: new Date().toISOString(),
    video: { file: videoFile?.name || jsonFile?.name || null, width: result.w, height: result.h },
    note: "Разбор файла. t — секунды от начала видео; lm — 33 точки MediaPipe [x, y, z, visibility] в долях кадра",
    history: result.history, cues: result.cues, frames: result.frames,
  };
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
