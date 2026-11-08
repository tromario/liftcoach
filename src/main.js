import "./style.css";
import { initPose, startCamera, setZoom, startLoop, setHandler, flipCamera, clear, unlockTarget, setAutoLock, justLocked, loadedModelName } from "./pose.js";
import * as pose from "./pose.js";
import { unlockVoice, say, quiet } from "./voice.js";
import { unlockAudio } from "./audio.js";
import { requestLevel, level, LEVEL_TOL } from "./level.js";
import { loadSettings, saveSettings } from "./config.js";
import { liveFrame, liveInit } from "./live.js";
import { squatStart, squatFrame, squatEndSet, squatDebug, squatHistory } from "./squat.js";
import { benchStart, benchFrame, benchEndSet, benchDebug, benchHistory } from "./bench.js";
import { startRecording, stopRecording, recordFrame, isRecording, shareLast, recordingStatus } from "./recorder.js";
import { resetProfile } from "./profile.js";
import { setupStart, setupFrame, setupStop, setupDone, setLens } from "./setup.js";

const $ = id => document.getElementById(id);
const log = t => $("log").textContent = t;

// ---------- Настройки ----------
const st = loadSettings();
saveSettings(st);   // сохранить переход на новую версию настроек
const FIELDS = ["height", "model", "liveCues", "judge", "autoRec", "quality", "audio", "skeletonVideo"];
const BOOL = new Set(["liveCues", "autoRec", "audio", "skeletonVideo"]);
for (const f of FIELDS) $(f).value = BOOL.has(f) ? (st[f] ? "1" : "0") : st[f];
function readSettings() {
  for (const f of FIELDS) {
    const v = $(f).value;
    st[f] = BOOL.has(f) ? v === "1" : v;
  }
  const h = parseFloat(st.height); st.height = h >= 140 && h <= 220 ? h : 178;
  saveSettings(st);
  return st;
}

// ---------- Модель: авто — full, при низком FPS переключаемся на lite ----------
const modelFor = m => (m === "auto" ? "full" : m);
let lowFpsSec = 0, switching = false;
async function autoModel(fps) {
  if (st.model !== "auto" || switching || loadedModelName() !== "full" || !mode || mode === "live") return;
  lowFpsSec = fps < 15 ? lowFpsSec + 1 : 0;
  if (lowFpsSec >= 5) {
    switching = true;
    try { const d = await initPose("lite"); $("modelChip").textContent = "авто: lite · " + d; } catch {}
    switching = false;
  }
}

// ---------- Режимы ----------
let booted = false, mode = null, levelAsked = false;

async function boot() {
  if (booted) return;
  log("Загружаю модель…");
  const delegate = await initPose(modelFor(st.model));
  $("modelChip").textContent = (st.model === "auto" ? "авто: " : "") + modelFor(st.model) + " · " + delegate;
  log("Включаю камеру…");
  await startCamera(undefined, st.quality);
  if (st.zoom < 0.99) await setZoom(st.zoom);
  startLoop(fps => { $("fps").textContent = fps; updateLevel(); updateRecButton(); autoModel(fps); });
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
  // Всё, что требует «нажатия», — синхронно до первого await (правило iOS).
  // Датчик уровня спрашиваем один раз за запуск приложения.
  if (!levelAsked) { levelAsked = true; requestLevel(); }
  unlockVoice(); unlockAudio();
  readSettings();
  try {
    await boot();
    if (pose.quality !== st.quality && pose.lens !== "ultra") await startCamera(pose.facing, st.quality);   // качество поменяли в настройках
    if (st.model !== "auto" && loadedModelName() !== st.model) {
      const d = await initPose(st.model); $("modelChip").textContent = st.model + " · " + d;
    }
  } catch (e) { log("Ошибка: " + (e.message || e)); console.error(e); return; }
  mode = m; lowFpsSec = 0;
  $("start").hidden = true; $("stage").hidden = false;
  $("live").hidden = m !== "live"; $("squat").hidden = true; $("bench").hidden = true;
  $("statusChip").hidden = m === "live";
  clear();
  if (m === "live") { setAutoLock(false); setHandler(withRec(liveFrame)); }
  else runSetup();
  try { await navigator.wakeLock?.request("screen"); } catch {}
}

function updateRecButton() {
  const r = recordingStatus(); if (!r) return;
  const m = Math.floor(r.sec / 60), sec = String(Math.floor(r.sec % 60)).padStart(2, "0");
  document.querySelectorAll("[data-rec]").forEach(b => { b.textContent = `■ ${m}:${sec} · ${Math.round(r.mb)} МБ`; });
}

const withRec = (fn, dbg) => (res, lm, ts) => {
  fn(res, lm, ts);
  if (justLocked() && mode !== "live") say("Вижу тебя", { repeatAfter: 15000 });
  if (isRecording()) recordFrame(lm, ts, dbg?.());
};

function startMode() {
  setupStop(); clear();
  quiet(4000);                 // первые секунды — не дёргаем подсказками, пока идёшь к снаряду
  unlockTarget(); setAutoLock(true);   // «свой» — тот, кто ляжет/встанет на место и замрёт
  $("squat").hidden = mode !== "squat"; $("bench").hidden = mode !== "bench";
  if (mode === "squat") { squatStart(st); setHandler(withRec(squatFrame, squatDebug)); }
  if (mode === "bench") { benchStart(st); setHandler(withRec(benchFrame, benchDebug)); }
  if (st.autoRec && !isRecording()) toggleRec();
}

/** Настройка ракурса — у телефона. Запись (если идёт) продолжается. */
function runSetup() {
  setAutoLock(false); unlockTarget();
  $("squat").hidden = true; $("bench").hidden = true; clear();
  setupStart(mode, startMode, st);
  setHandler(withRec(setupFrame, () => ({ state: "setup" })));
}

async function toggleRec() {
  if (!isRecording()) {
    if (!(await startRecording({ mode, settings: { ...st } }, { audio: st.audio, skeleton: st.skeletonVideo }))) { say("Запись не поддерживается", { force: true }); return; }
    document.querySelectorAll("[data-rec]").forEach(b => { b.textContent = "■ Стоп"; b.classList.add("rec-on"); });
    say("Запись", { force: true });
  } else {
    document.querySelectorAll("[data-rec]").forEach(b => { b.textContent = "● Запись"; b.classList.remove("rec-on"); });
    const hist = mode === "squat" ? squatHistory() : mode === "bench" ? benchHistory() : null;
    const r = await stopRecording({ history: hist });
    if (r) {
      $("recInfo").textContent = `видео${r.skeleton ? " со скелетом" : ""} ${(r.videoFile.size / 1e6).toFixed(0)} МБ${r.audio ? " со звуком" : r.audioWanted ? " без звука (нет доступа к микрофону)" : ""} · данные ${(r.dataFile.size / 1e6).toFixed(1)} МБ`;
      $("recDone").hidden = false;
    }
  }
}

async function toMenu() {
  if (isRecording()) await toggleRec();
  setupStop(); unlockTarget(); setAutoLock(false);
  setHandler(null); clear(); mode = null;
  $("stage").hidden = true; $("start").hidden = false;
}

// ---------- Кнопки ----------
$("goLive").onclick = () => enter("live");
$("goSquat").onclick = () => enter("squat");
$("goBench").onclick = () => enter("bench");
$("goSettings").onclick = () => { $("start").hidden = true; $("settings").hidden = false; };
$("settingsBack").onclick = () => { readSettings(); $("settings").hidden = true; $("start").hidden = false; };
$("resetProfile").onclick = () => { if (confirm("Сбросить накопленные замеры пропорций и наклона?")) { resetProfile(); log("Замеры сброшены"); } };
document.querySelectorAll("[data-back]").forEach(b => b.onclick = toMenu);
document.querySelectorAll("[data-flip]").forEach(b => b.onclick = () => flipCamera());
document.querySelectorAll("[data-rec]").forEach(b => b.onclick = toggleRec);
document.querySelectorAll("[data-setup]").forEach(b => b.onclick = runSetup);
document.querySelectorAll("[data-zoom]").forEach(b => b.onclick = async () => { await setLens(+b.dataset.zoom); saveSettings(st); });
// карточки сворачиваются по нажатию — чтобы не закрывали кадр
document.querySelectorAll("[data-collapse]").forEach(el => el.addEventListener("click", e => {
  if (e.target.closest("button")) return;
  el.classList.toggle("mini");
}));
$("suDone").onclick = () => setupDone();
$("suCard").addEventListener("click", e => { if (!e.target.closest("button")) $("suCard").classList.toggle("open"); });
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
