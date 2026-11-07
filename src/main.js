import "./style.css";
import { initPose, startCamera, startLoop, setHandler, flipCamera, clear } from "./pose.js";
import { unlockVoice, say } from "./voice.js";
import { unlockAudio } from "./audio.js";
import { requestLevel, level, LEVEL_TOL } from "./level.js";
import { loadSettings, saveSettings } from "./config.js";
import { liveFrame, liveInit } from "./live.js";
import { squatStart, squatFrame, squatEndSet } from "./squat.js";
import { benchStart, benchFrame, benchEndSet } from "./bench.js";
import { resetProfile } from "./profile.js";

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
  startLoop(fps => { $("fps").textContent = fps; updateLevel(); });
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
  if (m === "live") setHandler(liveFrame);
  if (m === "squat") { squatStart(st); setHandler(squatFrame); }
  if (m === "bench") { benchStart(st); setHandler(benchFrame); }
  try { await navigator.wakeLock?.request("screen"); } catch {}
}

function toMenu() {
  setHandler(null); clear(); mode = null;
  $("stage").hidden = true; $("start").hidden = false;
}

$("goLive").onclick = () => enter("live");
$("goSquat").onclick = () => enter("squat");
$("goBench").onclick = () => enter("bench");
$("resetProfile").onclick = () => { if (confirm("Сбросить накопленные замеры пропорций и наклона?")) { resetProfile(); log("Замеры сброшены"); } };
document.querySelectorAll("[data-back]").forEach(b => b.onclick = toMenu);
document.querySelectorAll("[data-flip]").forEach(b => b.onclick = () => flipCamera());
$("sqEnd").onclick = () => squatEndSet();
$("bpEnd").onclick = () => benchEndSet();
liveInit();

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && mode) { try { await navigator.wakeLock?.request("screen"); } catch {} }
});

// В разработке service worker не нужен: он мешал бы видеть свежие правки
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js");

window.__say = say; // для отладки из консоли
