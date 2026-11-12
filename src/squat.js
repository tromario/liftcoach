// Режим «Присед»: калибровка, повторы, глубина, наклон, гриф, голос
//
// Повтор считается только из стартовой позиции («armed»): стоишь ровно, неподвижно ≥ 1 с,
// стопы не врозь. Подход под гриф, съём и отшагивание (стопы врозь, шаги) — не повторы.
// Рабочая сторона тела фиксируется на подход: дальняя нога в профиль часто «ломается».
// Кадры с невозможной длиной бедра/голени (скелет сломан блином) — пропускаем.
import { CFG } from "./config.js";
import { px, drawSkeleton, lockGen } from "./pose.js";
import { angle, fromVertical, sideIdx, nearSide, median, dist } from "./geom.js";
import { checkSide } from "./framing.js";
import { say } from "./voice.js";
import { beep } from "./audio.js";
import * as profile from "./profile.js";

const $ = id => document.getElementById(id);
let S = null;

const thighAngle = (hip, kn) => Math.atan2(hip.y - kn.y, Math.abs(hip.x - kn.x)) * 180 / Math.PI;

const Q = {
  armStillMs: 700,       // столько стоять неподвижно перед повтором
  splitArm: 0.35,        // разнос стоп (в длинах голени) — больше: стопы врозь, не стартовая позиция
  splitAbort: 0.6,       // в повторе стопы врозь — это шаги
  driftAbort: 0.6,       // стопы сместились (в длинах голени) — ушёл с места
  setDriftCm: 25,        // следующий повтор подхода — на том же месте (± см); иначе это уже возврат на стойки
  maxRepMs: 8000,        // повтор не бывает дольше
  minDepth: -45,         // бедро должно опуститься хотя бы до полуприседа (угол к горизонту)
  segLo: 0.75, segHi: 1.3,   // допустимая длина бедра/голени относительно стойки
  unseenShare: 0.3,      // доля пропущенных кадров в повторе, при которой глубина «не видна»
};

export function squatStart(settings) {
  S = {
    settings,
    scaleBuf: [], scale: NaN,
    heelBuf: [], heelBase: NaN,
    thighBuf: [], shinBuf: [], rejSince: 0, gen: lockGen(),
    set: [], sets: [],
    state: "idle", rep: null, side: null,
    armAnkX: 0, setAnkX: null,
    lastRepEnd: 0, summarized: true, racked: true,
    hist: [], stillSince: 0,
    judgeSaid: false, sampledThisSet: false, readySaid: false,
    ema: null,
    calib: profile.makeCalibrator(s => {
      profile.addSample(s); S.sampledThisSet = true; render();
    }),
  };
  hint("Встань боком к камере", "bad");
  render();
}

export function squatEndSet() { if (S?.set.length) summary(); }
export function squatReset() { if (S) { S.set = []; S.sets = []; S.state = "idle"; S.rep = null; render(); } }

function hint(text, cls = "") {
  const el = $("sqHint");
  el.textContent = text || ""; el.className = "wz-hint " + cls;
}

function status(t) { $("modeStatus").textContent = t; }

const inRep = () => S.state === "down" || S.state === "up";

export function squatFrame(res, lm, ts) {
  if (!S) return;
  const fr = checkSide(lm);
  if (!lm) { if (!inRep()) { hint(fr.hint, "bad"); say(fr.hint, { persist: 3000, repeatAfter: 20000 }); } return; }

  const side = S.side ?? fr.side ?? nearSide(lm).side;
  const s = sideIdx(side);
  drawSkeleton(lm, { highlight: Object.values(s) });

  // Для приседа обязательны только ноги и таз. Голову и плечи часто закрывает блин —
  // остальные замечания к кадру (fr.hint) — только подсказка, повторы они не блокируют.
  const visOk = i => (lm[i].visibility ?? 0) > 0.5 && lm[i].y > 0.005 && lm[i].y < 0.995 && lm[i].x > 0.005 && lm[i].x < 0.995;
  const legsOk = [s.hip, s.kn, s.an].every(visOk) && (visOk(s.heel) || visOk(s.toe));
  if (!legsOk) {
    // короткая потеря (блин, дрожь скелета) — просто пропускаем кадр; долгая — выходим из стартовой позиции
    S.lostSince ||= ts;
    if (S.rep) S.rep.unseen++;
    if (!inRep() && ts - S.lostSince > 2000) {
      const h = "Не вижу ноги целиком";
      hint(h, "bad"); say(h, { persist: 3000, repeatAfter: 20000 }); S.calib.reset(); status("Настройка");
      if (S.state === "armed") { S.state = "idle"; S.side = null; }
      if (S.summarized) S.judgeSaid = false;
    }
    return;
  }
  S.lostSince = 0;

  const P = i => px(lm, i);
  const sh = P(s.sh), hip = P(s.hip), kn = P(s.kn), an = P(s.an), heel = P(s.heel), toe = P(s.toe);
  const thighPx = dist(hip, kn), shinPx = dist(kn, an);

  // ---------- Проверка кадра: не «сломан» ли скелет ----------
  const tMed = median(S.thighBuf), sMed = median(S.shinBuf);
  const vis = i => lm[i].visibility ?? 0;
  const lenOk = !Number.isFinite(tMed) || (thighPx / tMed > Q.segLo && thighPx / tMed < Q.segHi && shinPx / sMed > Q.segLo && shinPx / sMed < Q.segHi);
  const valid = lenOk && vis(s.hip) > 0.5 && vis(s.kn) > 0.5 && vis(s.an) > 0.4;
  // замер стойки был не с тебя (зафиксировались на другом / сменился человек) — кадры «битые» подряд дольше 1.2 с: перемеряем
  if (lockGen() !== S.gen || (!lenOk && valid === false && Number.isFinite(tMed) && (S.rejSince ||= ts) && ts - S.rejSince > 1200 && !S.rep && S.state === "idle")) {
    S.gen = lockGen(); S.thighBuf = []; S.shinBuf = []; S.rejSince = 0; S.ema = null; S.hist = [];
    if (S.state === "armed") { S.state = "idle"; S.side = null; }
    return;
  }
  if (lenOk) S.rejSince = 0;
  if (!valid) { if (S.rep) S.rep.unseen++; return; }

  const fwd = Math.sign(toe.x - heel.x) || 1;
  const raw = {
    knee: angle(hip, kn, an), hipA: angle(sh, hip, kn), lean: fromVertical(hip, sh),
    thigh: thighAngle(hip, kn), dy: hip.y - kn.y,
    barX: (sh.x - (heel.x + toe.x) / 2) * fwd, heelY: heel.y,
  };
  S.ema = S.ema ? Object.fromEntries(Object.keys(raw).map(k => [k, S.ema[k] * 0.5 + raw[k] * 0.5])) : raw;
  const m = S.ema;
  const k = S.scale;
  const cm = v => Number.isFinite(k) ? v * k : NaN;

  // Стойка: разнос стоп и положение (в длинах голени — не зависит от масштаба)
  const shinRef = Number.isFinite(sMed) ? sMed : shinPx;
  const split = Math.abs(P(27).x - P(28).x) / shinRef;
  const ankX = an.x;   // ближняя лодыжка: дальняя в профиль в нижней точке часто «ломается»

  // Неподвижность по тазу за последние 0.7 с
  S.hist.push({ t: ts, x: hip.x, y: hip.y });
  while (S.hist.length && ts - S.hist[0].t > 700) S.hist.shift();
  // порог — от длины бедра: не зависит от зума и расстояния, терпит дыхание и дрожь скелета
  const xs = S.hist.map(h => h.x), ys = S.hist.map(h => h.y);
  const tol = 0.15 * (Number.isFinite(tMed) ? tMed : thighPx);
  const still = S.hist.length > 5 && Math.max(...xs) - Math.min(...xs) < tol && Math.max(...ys) - Math.min(...ys) < tol;
  if (!still) S.stillSince = ts;
  const stillFor = ts - S.stillSince;

  // ---------- Стоишь (вне повтора) ----------
  if (!inRep()) {
    const upright = m.knee > 165 && m.hipA > 155 && m.lean < 20;
    if (upright && still && split < Q.splitArm) {
      S.thighBuf.push(thighPx); S.shinBuf.push(shinPx); S.thighBuf = S.thighBuf.slice(-90); S.shinBuf = S.shinBuf.slice(-90);
    }
    if (upright && still && fr.ok && split < Q.splitArm) {
      const sc = profile.scaleFromStanding(lm, S.settings.height, side);
      if (Number.isFinite(sc)) { S.scaleBuf.push(sc); S.scaleBuf = S.scaleBuf.slice(-90); S.scale = median(S.scaleBuf); }
      S.heelBuf.push(heel.y); S.heelBuf = S.heelBuf.slice(-90); S.heelBase = median(S.heelBuf);
      if (!S.sampledThisSet && Number.isFinite(S.scale)) S.calib.push(profile.segmentsCm(lm, side, S.scale));
    }

    // стартовая позиция
    const sameSpot = S.setAnkX == null || !S.set.length
      || (Number.isFinite(k) ? Math.abs(ankX - S.setAnkX) * k < Q.setDriftCm : Math.abs(ankX - S.setAnkX) / shinRef < 0.5);
    if (S.state === "idle") {
      if (upright && stillFor > Q.armStillMs && split < Q.splitArm && sameSpot) {
        S.state = "armed"; S.side = side; S.armAnkX = ankX;
        if (!S.set.length) S.setAnkX = ankX;
        if (!S.readySaid) { S.readySaid = true; say("Готов", { repeatAfter: 60000 }); }
      }
    } else {
      // пошёл шагать (например, к стойкам): стопы врозь стоя или ближняя стопа сместилась
      S.splitN = (m.knee > 160 && split > Q.splitAbort) ? (S.splitN || 0) + 1 : 0;
      if (S.splitN >= 3 || Math.abs(ankX - S.armAnkX) / shinRef > Q.driftAbort) { S.state = "idle"; S.side = null; S.splitN = 0; }
    }

    if (S.state === "armed") { status(S.set.length ? `Подход: ${S.set.length} повт.` : "Готов"); hint(S.set.length ? "" : "Можно приседать", "ok"); }
    else if (!fr.ok) { status("Жду стартовую позицию"); hint(fr.hint, ""); }
    else if (!Number.isFinite(S.scale)) { status("Калибровка"); hint("Встань прямо боком и замри", "bad"); }
    else { status(S.set.length ? `Подход: ${S.set.length} повт.` : "Жду стартовую позицию"); hint(S.set.length ? "" : "Встань в стойку и замри на секунду", ""); }

    // Команды судьи
    if (S.settings.judge !== "off" && S.state === "armed") {
      const cmd = S.settings.judge === "en" ? { go: "Squat", rack: "Rack" } : { go: "Присед", rack: "Стойка" };
      if (!S.judgeSaid && !S.set.length && stillFor > 1500) { S.judgeSaid = true; say(cmd.go, { force: true }); }
      if (S.set.length && !S.racked && stillFor > 800) { S.racked = true; say(cmd.rack, { force: true }); }
    }

    // Конец подхода: повторы были, стоишь неподвижно или ушёл с места
    if (S.set.length && !S.summarized && ts - S.lastRepEnd > CFG.setEndStillMs && (still || S.state === "idle")) summary();

    // начало повтора: колено согнулось или таз пошёл вниз (бедро отошло от вертикали)
    if (S.state === "armed" && (m.knee < CFG.startKnee || m.thigh > -60)) {
      S.state = "down";
      S.rep = { t0: ts, tBottom: ts, minKnee: m.knee, maxThigh: m.thigh, depthCm: cm(m.dy), leanBottom: m.lean,
        barBottom: cm(m.barX), barMax: cm(m.barX), ascLeanMax: -Infinity, heelLift: 0, beeped: false, gmCued: false,
        seen: 0, unseen: 0, splitN: 0, peaks: [] };
      status("Повтор " + (S.set.length + 1)); hint("");
    }
    return;
  }

  // ---------- В повторе ----------
  const r = S.rep;
  r.seen++;
  // ушёл с места / слишком долго — это не присед
  if (Math.abs(ankX - S.armAnkX) / shinRef > Q.driftAbort || ts - r.t0 > Q.maxRepMs) {
    S.state = "idle"; S.rep = null; S.side = null; return;
  }
  r.minKnee = Math.min(r.minKnee, m.knee);
  if (Number.isFinite(cm(m.barX))) r.barMax = Math.max(r.barMax, cm(m.barX));
  if (Number.isFinite(S.heelBase)) r.heelLift = Math.max(r.heelLift, cm(S.heelBase - m.heelY) || 0);

  // пик глубины — по «сырым» достоверным кадрам (сглаживание занижает пик), второй по величине — без случайного выброса
  r.peaks.push(raw.thigh); r.peaks.sort((a, b) => b - a); r.peaks.length = Math.min(r.peaks.length, 5);
  if (S.state === "down") {
    if (m.thigh > r.maxThigh) {
      r.maxThigh = m.thigh; r.depthCm = cm(m.dy); r.leanBottom = m.lean; r.barBottom = cm(m.barX); r.tBottom = ts;
    }
    if (!r.beeped && m.thigh >= CFG.depthOk) { r.beeped = true; if (S.settings.liveCues) beep(1250, 110); }
    if (m.thigh < r.maxThigh - 5 && r.maxThigh > Q.minDepth && r.minKnee < CFG.minRepKnee) S.state = "up";
    if (m.knee > CFG.standKnee) { S.state = "armed"; S.rep = null; }   // чуть присел и встал — не повтор
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
  const depth = r.peaks.length >= 2 ? Math.max(r.maxThigh, r.peaks[1]) : r.maxThigh;
  const unseen = r.unseen / Math.max(1, r.seen + r.unseen) > Q.unseenShare;
  const status = depth >= CFG.depthOk ? "ok" : unseen ? "unknown" : depth >= CFG.depthBorder ? "border" : "fail";
  const rep = {
    n: S.set.length + 1,
    depth, depthCm: r.depthCm,
    depthStatus: status,
    unseenShare: Math.round(r.unseen / Math.max(1, r.seen + r.unseen) * 100) / 100,
    lean: r.leanBottom,
    gm: Number.isFinite(r.ascLeanMax) ? r.ascLeanMax - r.leanBottom : 0,
    barBottom: r.barBottom, barMax: r.barMax,
    heelLift: r.heelLift,
    tDown: (r.tBottom - r.t0) / 1000, tUp: (ts - r.tBottom) / 1000,
  };
  const base = profile.baselineLean();
  rep.leanHigh = base != null && rep.lean > base + CFG.leanOverBaseline;
  if (rep.depthStatus === "ok") profile.addLean(rep.lean);

  S.set.push(rep); S.state = "armed"; S.rep = null;
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
  const unknown = set.filter(r => r.depthStatus === "unknown").map(r => r.n);
  if (!fail.length && !border.length && !unknown.length) parts.push("Глубина: все засчитаны.");
  else {
    if (fail.length) parts.push(`Не глубоко ${list(fail)}.`);
    if (border.length) parts.push(`На грани ${list(border)}.`);
    if (unknown.length) parts.push(`Глубину не видно ${list(unknown)}: блин закрыл таз.`);
  }
  const gm = set.filter(r => r.gm > CFG.goodMorningDeg).map(r => r.n);
  if (gm.length) parts.push(`Таз уходил вверх ${list(gm)}.`);
  const bar = set.filter(r => r.barMax > CFG.barForwardCm).map(r => r.n);
  if (bar.length) parts.push(`Гриф уходил на носки ${list(bar)}.`);
  const heel = set.filter(r => r.heelLift > CFG.heelLiftCm).map(r => r.n);
  if (heel.length) parts.push(`Пятки отрывались ${list(heel)}.`);
  const lean = set.filter(r => r.leanHigh).map(r => r.n);
  if (lean.length) parts.push(`Наклон больше обычного ${list(lean)}.`);
  if (parts.length === 2 && !fail.length && !border.length && !unknown.length) parts.push("Техника ровная.");

  say(parts.join(" "), { force: true });
  S.sets.push(set); S.set = []; S.summarized = true;
  S.sampledThisSet = false; S.racked = true; S.side = null; S.setAnkX = null;
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
      const d = { ok: "✓", border: "≈", fail: "✗", unknown: "?" }[r.depthStatus];
      const flags = [r.gm > CFG.goodMorningDeg ? "таз" : "", r.heelLift > CFG.heelLiftCm ? "пятки" : "", r.leanHigh ? "наклон" : "", r.depthStatus === "unknown" ? "низ не виден" : ""].filter(Boolean).join(", ");
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
