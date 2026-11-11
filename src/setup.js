// Настройка ракурса — целиком у телефона, пока ты стоишь за штативом и смотришь на экран:
//  - автоматически: ориентация и уровень телефона;
//  - объектив 1× / 0.5× (широкоугольник, чтобы поместились стойки);
//  - рамка-подсказка поверх кадра: горизонт (высота объектива), безопасная зона, где должна быть скамья/ты;
//  - стойки и скамью проверяешь глазами по рамке — распознавать их автоматически модель не умеет.
// «Готово» — и в режим. Голос здесь почти молчит: ты и так смотришь на экран.
import { canvas, frame, setZoom, lens, lensNote } from "./pose.js";
import * as pose from "./pose.js";
import { level, BENCH_MAX_PITCH } from "./level.js";
import { say } from "./voice.js";

const $ = id => document.getElementById(id);
const TOL = 3;
let S = null;

const GUIDE = {
  squat: {
    title: "Ракурс: присед",
    tips: [
      "Штатив сбоку, строго перпендикулярно месту, где будешь приседать, в 2–3 м.",
      "Объектив между коленом и тазом (≈ 60–80 см от пола) — это синяя линия.",
      "Стойки, ты после отшагивания и запас за тазом — внутри рамки.",
    ],
    zone: { x0: .2, x1: .8, y0: .06, y1: .96, label: "ты целиком, по центру" },
  },
  deadlift: {
    title: "Ракурс: тяга",
    tips: [
      "Сбоку, но повернув штатив на 20–30° к твоему лицу: так блин не закрывает голени и кисти.",
      "Телефон ровно, объектив на высоте таза в старте (≈ 50–70 см) — синяя линия. 2,5–3 м, зум 0.5–0.7.",
      "Внутри рамки: гриф с блинами на полу и ты в локауте с головой.",
    ],
    zone: { x0: .15, x1: .85, y0: .05, y1: .96, label: "ты в локауте целиком, гриф на полу" },
  },
  bench: {
    title: "Ракурс: жим",
    tips: [
      "Телефон горизонтально. Штатив сбоку от скамьи, напротив груди, в 2–3 м — не у стоек и не у изголовья.",
      "Подними камеру над страховками (≈ 1–1,2 м) и наклони вниз на 15–25°: опоры и блин не должны быть между камерой и тобой.",
      "Скамья и гриф на вершине — внутри рамки. Зум 0.5–0.7.",
    ],
    zone: { x0: .08, x1: .92, y0: .25, y1: .8, label: "скамья и стойки" },
  },
};

function checks(mode) {
  const r = [];
  if (mode === "bench") r.push({ label: "Телефон горизонтально", key: "orient", ok: frame.w > frame.h, hint: "Поверни телефон горизонтально" });
  if (!level.available) r.push({ label: "Уровень (датчик недоступен)", ok: true });
  else {
    const maxP = mode === "bench" ? BENCH_MAX_PITCH : TOL;
    const ok = Math.abs(level.pitch) <= maxP && Math.abs(level.roll) <= TOL;
    r.push({ label: mode === "bench" ? `Без крена (наклон вниз до ${BENCH_MAX_PITCH}° можно)` : "Телефон ровно", key: "level", ok,
      hint: Math.abs(level.roll) > TOL ? "Выровняй по горизонту — без крена" : (level.pitch > 0 ? "Слишком сильный наклон — наклони верхом к себе" : "Слишком сильный наклон — наклони верхом от себя") });
  }
  return r;
}

function drawGuide(mode, levelOk) {
  const g = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
  g.save();
  // при зеркальной фронталке canvas отражён стилями — рамка симметрична, это не мешает
  const z = GUIDE[mode].zone, lw = Math.max(2, w / 400);
  // безопасная зона
  g.setLineDash([lw * 6, lw * 4]); g.lineWidth = lw; g.strokeStyle = "rgba(255,255,255,.75)";
  g.strokeRect(z.x0 * w, z.y0 * h, (z.x1 - z.x0) * w, (z.y1 - z.y0) * h);
  // края кадра, где широкоугольник искажает, — затемняем
  if (lens === "ultra" && frame.crop > 0.9) { g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(0, 0, w * .06, h); g.fillRect(w * .94, 0, w * .06, h); }
  // горизонт = высота объектива (только если телефон ровно)
  if (levelOk) {
    g.setLineDash([]); g.strokeStyle = "rgba(111,155,255,.95)"; g.lineWidth = lw * 1.5;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  }
  // подписи
  g.setLineDash([]); g.font = `600 ${Math.round(h / 34)}px -apple-system,sans-serif`;
  g.fillStyle = "rgba(255,255,255,.85)"; g.fillText(z.label, z.x0 * w + lw * 4, z.y1 * h - lw * 4);
  if (levelOk) { g.fillStyle = "rgba(111,155,255,.95)"; g.fillText("высота объектива", z.x1 * w - h / 34 * 8.5, h / 2 - lw * 4); }
  g.restore();
}

export function setupStart(mode, onDone, settings) {
  S = { mode, onDone, settings, saidLevel: false };
  const g = GUIDE[mode];
  $("suTitle").textContent = g.title;
  $("suInstr").innerHTML = g.tips.map(t => `<li>${t}</li>`).join("");
  $("setup").hidden = false;
  $("suCard").classList.remove("open");
  renderLens();
}

export function setupStop() { $("setup").hidden = true; S = null; }

export function setupDone() { if (!S) return; const cb = S.onDone; setupStop(); cb?.(); }

function renderLens() {
  document.querySelectorAll("[data-zoom]").forEach(b => b.classList.toggle("on", Math.abs(+b.dataset.zoom - pose.zoom) < 0.01));
  $("suLensNote").textContent = lensNote;
}

export async function setLens(z) {
  if (!S) return;
  $("suLensNote").textContent = "Переключаю камеру…";
  try { await setZoom(z); } catch (e) { $("suLensNote").textContent = "Не удалось: " + (e.message || e); return; }
  S.settings.zoom = pose.zoom;
  renderLens();
  return pose.zoom;
}

export function setupFrame(res, lm, ts) {
  if (!S) return;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, canvas.width, canvas.height);
  const r = checks(S.mode);
  const levelOk = !level.available || r.find(c => c.key === "level")?.ok;
  // линия «высота объектива» имеет смысл только при ровном телефоне
  drawGuide(S.mode, levelOk && (!level.available || Math.abs(level.pitch) <= TOL));
  $("suList").innerHTML = r.map(c => `<li class="${c.ok ? "ok" : "bad"}"><span class="dot"></span>${c.label}</li>`).join("")
    + `<li class="eye"><span class="dot"></span>Стойки и скамья внутри рамки — проверь глазами</li>`;
  const bad = r.find(c => !c.ok);
  $("suHint").textContent = bad ? bad.hint : "Если всё в рамке — жми «Готово»";
  $("suHint").className = "su-hint " + (bad ? "bad" : "ok");
  if (levelOk && level.available && !S.saidLevel) { S.saidLevel = true; say("Ровно", { repeatAfter: 30000 }); }
  if (!levelOk) S.saidLevel = false;
}
