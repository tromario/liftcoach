import "./style.css";
import { initPose, startCamera, startLoop, setHandler, flipCamera, clear } from "./pose.js";
import { unlockVoice, say } from "./voice.js";
import { unlockAudio } from "./audio.js";
import { requestLevel, level, LEVEL_TOL } from "./level.js";
import { loadSettings, saveSettings } from "./config.js";
import { liveFrame, liveInit } from "./live.js";
import { squatStart, squatFrame, squatEndSet, squatDebug, squatHistory } from "./squat.js";
import { benchStart, benchFrame, benchEndSet, benchDebug, benchHistory } from "./bench.js";
import { startRecording, stopRecording, recordFrame, isRecording, shareLast, recordingStatus } from "./recorder.js";
import { resetProfile } from "./profile.js";
import { setupStart, setupFrame, setupStop } from "./setup.js";

const $ = id => document.getElementById(id);
const log = t => $("log").textContent = t;

// ---------- Настройки ----------
const st = loadSettings();
$("height").value = st.height;
$("model").value = st.model;
$("liveCues").value = st.liveCues ? "1" : "0";
$("judge").value = st.judge;
function readSettings() {
  const h = parseFloat($("height").value);
  Object.assign(st, {
    height: h >= 140 && h <= 220 ? h : 178,
    model: $("model").value,
    liveCues: $("liveCues").value === "1",
    judge: $("judge").value,
  });
  saveSettings(st);
  return st;
}

// ---------- Режимы ----------
let booted = false, mode = null;

async function boot() {
  if (booted) return;
  log("Загружаю модель…");
  const delegate = await initPose(st.model);
  $("modelChip").textContent = st.model + " · " + delegate;
  log("Включаю камеру…");
  await startCamera();
  startLoop(fps => { $("fps").textContent = fps; updateLevel(); updateRecButton(); });
  booted = true;
  log("");
}

function updateLevel() {
  const chip = $("levelChip");
  if (!level.available) { $("levelVal").textContent = "нет"; chip.className = "chip"; return; }
  const p = Math.round(level.pitch), r = Math.round(level.roll);
  const ok = Math.abs(p) <= LEVEL_TOL && Math.abs(r) <= LEVEL_TOL;
  $("levelVal").textContent = ok ? "ровно" : `${p}° / ${r}°`;
  chip.className = "chip " + (ok ? "ok" : "bad");
}

async function enter(m) {
  // Всё, что требует «нажатия», — синхронно до первого await (правило iOS)
  requestLevel(); unlockVoice(); unlockAudio();
  readSettings();
  try {
    await boot();
  } catch (e) { log("Ошибка: " + (e.message || e)); console.error(e); return; }
  mode = m;
  $("start").hidden = true; $("stage").hidden = false;
  $("live").hidden = m !== "live"; $("squat").hidden = m !== "squat"; $("bench").hidden = m !== "bench";
  $("statusChip").hidden = m === "live";
  clear();
  if (m === "live") setHandler(withRec(liveFrame));
  else runSetup();
  try { await navigator.wakeLock?.request("screen"); } catch {}
}

function updateRecButton() {
  const r = recordingStatus(); if (!r) return;
  const m = Math.floor(r.sec / 60), sec = String(Math.floor(r.sec % 60)).padStart(2, "0");
  document.querySelectorAll("[data-rec]").forEach(b => { b.textContent = `■ ${m}:${sec} · ${Math.round(r.mb)} МБ`; });
}

const withRec = (fn, dbg) => (res, lm, ts) => { fn(res, lm, ts); if (isRecording()) recordFrame(lm, ts, dbg?.()); };

function startMode() {
  setupStop(); clear();
  $("squat").hidden = mode !== "squat"; $("bench").hidden = mode !== "bench";
  if (mode === "squat") { squatStart(st); setHandler(withRec(squatFrame, squatDebug)); }
  if (mode === "bench") { benchStart(st); setHandler(withRec(benchFrame, benchDebug)); }
}

/** Сначала выставляем камеру, потом — режим. Запись (если идёт) продолжается. */
function runSetup() {
  $("squat").hidden = true; $("bench").hidden = true; clear();
  setupStart(mode, startMode, st);
  setHandler(withRec(setupFrame, () => ({ state: "setup" })));
}

async function toggleRec() {
  if (!isRecording()) {
    if (!startRecording({ mode, settings: { ...st } })) { say("Запись не поддерживается", { force: true }); return; }
    document.querySelectorAll("[data-rec]").forEach(b => { b.textContent = "■ Стоп"; b.classList.add("rec-on"); });
    say("Запись", { force: true });
  } else {
    document.querySelectorAll("[data-rec]").forEach(b => { b.textContent = "● Запись"; b.classList.remove("rec-on"); });
    const hist = mode === "squat" ? squatHistory() : mode === "bench" ? benchHistory() : null;
    const r = await stopRecording({ history: hist });
    if (r) {
      $("recInfo").textContent = `видео ${(r.videoFile.size / 1e6).toFixed(0)} МБ · данные ${(r.dataFile.size / 1e6).toFixed(1)} МБ`;
      $("recDone").hidden = false;
    }
  }
}

async function toMenu() {
  if (isRecording()) await toggleRec();
  setupStop();
  setHandler(null); clear(); mode = null;
  $("stage").hidden = true; $("start").hidden = false;
}

$("goLive").onclick = () => enter("live");
$("goSquat").onclick = () => enter("squat");
$("goBench").onclick = () => enter("bench");
$("resetProfile").onclick = () => { if (confirm("Сбросить накопленные замеры пропорций и наклона?")) { resetProfile(); log("Замеры сброшены"); } };
document.querySelectorAll("[data-back]").forEach(b => b.onclick = toMenu);
document.querySelectorAll("[data-flip]").forEach(b => b.onclick = () => flipCamera());
document.querySelectorAll("[data-rec]").forEach(b => b.onclick = toggleRec);
document.querySelectorAll("[data-setup]").forEach(b => b.onclick = runSetup);
$("suSkip").onclick = startMode;
$("recCoach").onclick = async () => { const r = await shareLast("coach"); if (r !== "ok") log(r); };
$("recShare").onclick = async () => { const r = await shareLast("analysis"); if (r !== "ok") log(r); };
$("recClose").onclick = () => { $("recDone").hidden = true; };
$("sqEnd").onclick = () => squatEndSet();
$("bpEnd").onclick = () => benchEndSet();
liveInit();

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && mode) { try { await navigator.wakeLock?.request("screen"); } catch {} }
});

// В разработке service worker не нужен: он мешал бы видеть свежие правки
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js");

window.__say = say; // для отладки из консоли
