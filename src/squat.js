// Режим «Присед»: калибровка, повторы, глубина, наклон, гриф, голос
import { CFG } from "./config.js";
import { px, drawSkeleton, video } from "./pose.js";
import { angle, fromVertical, sideIdx, nearSide, median } from "./geom.js";
import { checkSide } from "./framing.js";
import { say } from "./voice.js";
import { beep } from "./audio.js";
import * as profile from "./profile.js";

const $ = id => document.getElementById(id);
let S = null;

const thighAngle = (hip, kn) => Math.atan2(hip.y - kn.y, Math.abs(hip.x - kn.x)) * 180 / Math.PI;

export function squatStart(settings) {
  S = {
    settings,
    scaleBuf: [], scale: NaN,
    heelBuf: [], heelBase: NaN,
    set: [], sets: [],
    state: "stand", rep: null,
    lastRepEnd: 0, summarized: true, racked: true,
    hist: [], stillSince: 0,
    judgeSaid: false, sampledThisSet: false, readySaid: false,
    ema: null,
    calib: profile.makeCalibrator(s => {
      profile.addSample(s); S.sampledThisSet = true; render();
      if (!S.readySaid) { S.readySaid = true; say("Готов", { repeatAfter: 60000 }); }
    }),
  };
  hint("Встань боком к камере", "bad");
  render();
}

export function squatEndSet() { if (S?.set.length) summary(); }
export function squatReset() { if (S) { S.set = []; S.sets = []; S.state = "stand"; S.rep = null; render(); } }

function hint(text, cls = "") {
  const el = $("sqHint");
  el.textContent = text || ""; el.className = "wz-hint " + cls;
}

function status(t) { $("modeStatus").textContent = t; }

export function squatFrame(res, lm, ts) {
  if (!S) return;
  const fr = checkSide(lm);
  if (!lm) { if (S.state === "stand") { hint(fr.hint, "bad"); say(fr.hint, { persist: 3000, repeatAfter: 20000 }); } return; }

  const side = fr.side ?? nearSide(lm).side;
  const s = sideIdx(side);
  drawSkeleton(lm, { highlight: Object.values(s) });

  const inRep = S.state !== "stand";
  if (!fr.ok && !inRep) {
    hint(fr.hint, "bad"); say(fr.hint, { persist: 3000, repeatAfter: 20000 }); S.calib.reset(); status("Настройка");
    if (S.summarized) S.judgeSaid = false;   // ушёл из кадра после подхода — следующий подход снова с командой
    return;
  }

  const P = i => px(lm, i);
  const sh = P(s.sh), hip = P(s.hip), kn = P(s.kn), an = P(s.an), heel = P(s.heel), toe = P(s.toe);
  const fwd = Math.sign(toe.x - heel.x) || 1;   // куда смотрит носок
  const raw = {
    knee: angle(hip, kn, an), hipA: angle(sh, hip, kn), lean: fromVertical(hip, sh),
    thigh: thighAngle(hip, kn), dy: hip.y - kn.y,
    barX: (sh.x - (heel.x + toe.x) / 2) * fwd, heelY: heel.y,
  };
  S.ema = S.ema ? Object.fromEntries(Object.keys(raw).map(k => [k, S.ema[k] * 0.5 + raw[k] * 0.5])) : raw;
  const m = S.ema;
  const k = S.scale;                     // см на пиксель (NaN до калибровки)
  const cm = v => Number.isFinite(k) ? v * k : NaN;

  // Неподвижность по тазу за последние 0.7 с
  S.hist.push({ t: ts, x: hip.x, y: hip.y });
  while (S.hist.length && ts - S.hist[0].t > 700) S.hist.shift();
  const xs = S.hist.map(h => h.x), ys = S.hist.map(h => h.y), vh = video.videoHeight;
  const still = S.hist.length > 5 && Math.max(...xs) - Math.min(...xs) < 0.012 * vh && Math.max(...ys) - Math.min(...ys) < 0.012 * vh;
  if (!still) S.stillSince = ts;
  const stillFor = ts - S.stillSince;

  // ---------- Стоишь: калибровка, команды, конец подхода ----------
  if (S.state === "stand") {
    const upright = m.knee > 165 && m.hipA > 160 && m.lean < 15;
    if (upright && still && fr.ok) {
      const sc = profile.scaleFromStanding(lm, S.settings.height, side);
      if (Number.isFinite(sc)) { S.scaleBuf.push(sc); S.scaleBuf = S.scaleBuf.slice(-90); S.scale = median(S.scaleBuf); }
      S.heelBuf.push(heel.y); S.heelBuf = S.heelBuf.slice(-90); S.heelBase = median(S.heelBuf);
      if (!S.sampledThisSet && Number.isFinite(S.scale)) S.calib.push(profile.segmentsCm(lm, side, S.scale));
    }

    if (!Number.isFinite(S.scale)) {
      status("Калибровка"); hint("Встань прямо боком и замри", "bad"); say("Встань прямо и замри", { persist: 3000, repeatAfter: 20000 });
    } else if (!S.sampledThisSet && S.calib.progress > 0 && !profile.proportions()) {
      status("Калибровка"); hint(`Замеряю… ${Math.round(S.calib.progress * 100)}%`, "ok");
    } else {
      status(S.set.length ? `Подход: ${S.set.length} повт.` : "Готов");
      hint(S.set.length ? "" : "Можно начинать", "ok");
      if (!S.readySaid) { S.readySaid = true; say("Готов"); }
    }

    // Команды судьи
    if (S.settings.judge !== "off" && upright && fr.ok) {
      const cmd = S.settings.judge === "en" ? { go: "Squat", rack: "Rack" } : { go: "Присед", rack: "Стойка" };
      if (!S.judgeSaid && !S.set.length && stillFor > 1500) { S.judgeSaid = true; say(cmd.go, { force: true }); }
      if (S.set.length && !S.racked && stillFor > 800) { S.racked = true; say(cmd.rack, { force: true }); }
    }

    // Конец подхода: повторы были, стоишь неподвижно
    if (S.set.length && !S.summarized && still && ts - S.lastRepEnd > CFG.setEndStillMs) summary();

    if (m.knee < CFG.startKnee) {
      S.state = "down";
      S.rep = { t0: ts, tBottom: ts, minKnee: m.knee, maxThigh: m.thigh, depthCm: cm(m.dy), leanBottom: m.lean,
        barBottom: cm(m.barX), barMax: cm(m.barX), ascLeanMax: -Infinity, heelLift: 0, beeped: false, gmCued: false };
      status("Повтор " + (S.set.length + 1)); hint("");
    }
    return;
  }

  // ---------- В повторе ----------
  const r = S.rep;
  r.minKnee = Math.min(r.minKnee, m.knee);
  if (Number.isFinite(cm(m.barX))) r.barMax = Math.max(r.barMax, cm(m.barX));
  if (Number.isFinite(S.heelBase)) r.heelLift = Math.max(r.heelLift, cm(S.heelBase - m.heelY) || 0);

  if (S.state === "down") {
    if (m.thigh > r.maxThigh) {
      r.maxThigh = m.thigh; r.depthCm = cm(m.dy); r.leanBottom = m.lean; r.barBottom = cm(m.barX); r.tBottom = ts;
    }
    if (!r.beeped && m.thigh >= CFG.depthOk) { r.beeped = true; if (S.settings.liveCues) beep(1250, 110); }
    if (m.thigh < r.maxThigh - 5 && r.minKnee < CFG.minRepKnee) S.state = "up";
    if (m.knee > CFG.standKnee) { S.state = "stand"; S.rep = null; }   // недоприсед без смены направления — не повтор
    return;
  }

  // up
  if (m.thigh > r.maxThigh - 35) {      // первая треть подъёма — здесь таз «убегает»
    r.ascLeanMax = Math.max(r.ascLeanMax, m.lean);
    if (S.settings.liveCues && !r.gmCued && r.ascLeanMax - r.leanBottom > CFG.goodMorningDeg) {
      r.gmCued = true; say("Грудь!", { force: true });
    }
  }
  if (m.knee > CFG.standKnee) finishRep(ts);
}

function finishRep(ts) {
  const r = S.rep;
  const depth = r.maxThigh;
  const rep = {
    n: S.set.length + 1,
    depth, depthCm: r.depthCm,
    depthStatus: depth >= CFG.depthOk ? "ok" : depth >= CFG.depthBorder ? "border" : "fail",
    lean: r.leanBottom,
    gm: Number.isFinite(r.ascLeanMax) ? r.ascLeanMax - r.leanBottom : 0,
    barBottom: r.barBottom, barMax: r.barMax,
    heelLift: r.heelLift,
    tDown: (r.tBottom - r.t0) / 1000, tUp: (ts - r.tBottom) / 1000,
  };
  const base = profile.baselineLean();
  rep.leanHigh = base != null && rep.lean > base + CFG.leanOverBaseline;
  if (rep.depthStatus === "ok") profile.addLean(rep.lean);

  S.set.push(rep); S.state = "stand"; S.rep = null;
  S.lastRepEnd = ts; S.summarized = false; S.racked = false;
  if (S.settings.liveCues && rep.depthStatus === "fail") say("Не глубоко", { force: true });
  render();
}

const list = ns => ns.length === S.set.length && ns.length > 1 ? "во всех" : (ns.length === 1 ? "в повторе " : "в повторах ") + ns.join(", ");

function summary() {
  const set = S.set, n = set.length;
  const parts = [`${n} ${n === 1 ? "повтор" : n < 5 ? "повтора" : "повторов"}.`];
  const fail = set.filter(r => r.depthStatus === "fail").map(r => r.n);
  const border = set.filter(r => r.depthStatus === "border").map(r => r.n);
  if (!fail.length && !border.length) parts.push("Глубина: все засчитаны.");
  else {
    if (fail.length) parts.push(`Не глубоко ${list(fail)}.`);
    if (border.length) parts.push(`На грани ${list(border)}.`);
  }
  const gm = set.filter(r => r.gm > CFG.goodMorningDeg).map(r => r.n);
  if (gm.length) parts.push(`Таз уходил вверх ${list(gm)}.`);
  const bar = set.filter(r => r.barMax > CFG.barForwardCm).map(r => r.n);
  if (bar.length) parts.push(`Гриф уходил на носки ${list(bar)}.`);
  const heel = set.filter(r => r.heelLift > CFG.heelLiftCm).map(r => r.n);
  if (heel.length) parts.push(`Пятки отрывались ${list(heel)}.`);
  const lean = set.filter(r => r.leanHigh).map(r => r.n);
  if (lean.length) parts.push(`Наклон больше обычного ${list(lean)}.`);
  if (parts.length === 2 && !fail.length && !border.length) parts.push("Техника ровная.");

  say(parts.join(" "), { force: true });
  S.sets.push(set); S.set = []; S.summarized = true;
  S.sampledThisSet = false; S.racked = true;
  render(parts.join(" "));
}

const f0 = v => Number.isFinite(v) ? Math.round(v) : "–";

function render(lastSummary) {
  const p = profile.proportions();
  const base = profile.baselineLean();
  const model = profile.modelLean(p, S.settings.height);
  const set = S.set.length ? S.set : (S.sets.at(-1) || []);

  let html = "";
  html += p
    ? `<div class="mut small">Бедро ${f0(p.thigh)} · голень ${f0(p.shin)} · корпус ${f0(p.torso)} см <span>(${p.n} замер.)</span></div>`
    : `<div class="mut small">Пропорции: ещё нет замеров</div>`;
  if (base != null) html += `<div class="mut small">Твой обычный наклон: ${f0(base)}°</div>`;
  else if (model != null) html += `<div class="mut small">Ориентир наклона (модель): ~${f0(model)}°</div>`;

  if (set.length) {
    html += `<table><tr><th>#</th><th>Глуб.</th><th>Накл.</th><th>Гриф</th><th></th></tr>`;
    for (const r of set) {
      const d = r.depthStatus === "ok" ? "✓" : r.depthStatus === "border" ? "≈" : "✗";
      const flags = [r.gm > CFG.goodMorningDeg ? "таз" : "", r.heelLift > CFG.heelLiftCm ? "пятки" : "", r.leanHigh ? "наклон" : ""].filter(Boolean).join(", ");
      html += `<tr><td>${r.n}</td><td>${d} ${Number.isFinite(r.depthCm) ? (r.depthCm > 0 ? "+" : "") + f0(r.depthCm) + " см" : f0(r.depth) + "°"}</td>`
        + `<td>${f0(r.lean)}°</td><td>${Number.isFinite(r.barMax) ? (r.barMax > 0 ? "+" : "") + f0(r.barMax) : "–"}</td><td class="small">${flags}</td></tr>`;
    }
    html += `</table>`;
  }
  if (lastSummary) html += `<div class="small">${lastSummary}</div>`;
  $("sqPanel").innerHTML = html;
}

export function squatDebug() {
  if (!S || !S.ema) return null;
  const e = S.ema, r = x => Math.round(x * 10) / 10;
  return { state: S.state, knee: r(e.knee), hip: r(e.hipA), lean: r(e.lean), thigh: r(e.thigh), barX: r(e.barX), scale: r(S.scale * 1000) / 1000, reps: S.set.length };
}

export function squatHistory() { return S ? { sets: [...S.sets, S.set].filter(s => s.length), profile: profile.exportProfile() } : null; }
