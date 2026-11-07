// Режим «Жим лёжа»: съёмка сбоку на уровне скамьи.
// Основное — траектория и углы (предплечье в низу, путь грифа, вершина, таз, темп).
// Команды судьи (Старт/Жим/Стойка) — дополнительная опция в меню.
// Гриф ≈ запястье видимой стороны. Высота грифа считается над плечевым суставом.
import { CFG } from "./config.js";
import { px, drawSkeleton, video } from "./pose.js";
import { angle, sideIdx, nearSide, median, dist } from "./geom.js";
import { levelHint } from "./level.js";
import { say } from "./voice.js";
import { beep } from "./audio.js";
import * as profile from "./profile.js";

const $ = id => document.getElementById(id);
let S = null;
const B = CFG.bench;

export function benchStart(settings) {
  S = {
    settings, state: "idle", rep: null, set: [], sets: [],
    humBuf: [], scale: NaN,
    top: null,               // эталон вершины: высота, положение по горизонтали, таз
    hist: [], ema: null,
    lastRepEnd: 0, summarized: true,
    startSaid: false, rackSaid: true, topStillSince: 0,
  };
  hint("Ложись на скамью, камера сбоку", "bad");
  render();
}
export function benchEndSet() { if (S?.set.length) summary(); }

function hint(t, cls = "") { const el = $("bpHint"); el.textContent = t || ""; el.className = "wz-hint " + cls; }
const status = t => { $("modeStatus").textContent = t; };
const cmds = () => S.settings.judge === "en"
  ? { start: "Start", press: "Press", rack: "Rack" }
  : { start: "Старт", press: "Жим", rack: "Стойка" };

function framing(lm) {
  if (!lm) return { ok: false, hint: "Не вижу тебя" };
  const lv = levelHint(); if (lv) return { ok: false, hint: lv };
  const { side } = nearSide(lm); const s = sideIdx(side);
  const need = [s.sh, s.el, s.wr, s.hip];
  if (need.some(i => lm[i].x < 0.01 || lm[i].x > 0.99 || lm[i].y < 0.01 || lm[i].y > 0.99))
    return { ok: false, hint: "Не помещаешься, отодвинь камеру", side };
  if (need.some(i => (lm[i].visibility ?? 0) < CFG.minVis))
    return { ok: false, hint: "Плохо вижу руку и таз, сдвинь камеру к ногам", side };
  const sh = px(lm, s.sh), hip = px(lm, s.hip);
  const tilt = Math.abs(Math.atan2(hip.y - sh.y, Math.abs(hip.x - sh.x))) * 180 / Math.PI;
  if (tilt > 35) return { ok: false, hint: "Камера должна смотреть сбоку на скамью", side };
  const torsoFrac = dist(sh, hip) / video.videoWidth;
  if (torsoFrac < B.torsoMin) return { ok: false, hint: "Поставь камеру ближе", side };
  if (torsoFrac > B.torsoMax) return { ok: false, hint: "Отодвинь камеру", side };
  return { ok: true, side };
}

export function benchFrame(res, lm, ts) {
  if (!S) return;
  const fr = framing(lm);
  if (!lm) { if (S.state === "idle" || S.state === "top") { hint(fr.hint, "bad"); say(fr.hint); } return; }
  const s = sideIdx(fr.side ?? nearSide(lm).side);
  drawSkeleton(lm, { highlight: [s.sh, s.el, s.wr, s.hip] });

  const inRep = S.state === "down" || S.state === "pause" || S.state === "up";
  if (!fr.ok && !inRep) { hint(fr.hint, "bad"); say(fr.hint); status("Настройка"); return; }

  const P = i => px(lm, i);
  const sh = P(s.sh), el = P(s.el), wr = P(s.wr), hip = P(s.hip);
  const toFeet = Math.sign(hip.x - sh.x) || 1;
  const elbow = angle(sh, el, wr);

  // Масштаб по плечевой кости: длина из калибровки в приседе или 18.6% роста
  const p = profile.proportions();
  const humCm = p?.upperArm || 0.186 * S.settings.height;
  S.humBuf.push(dist(sh, el)); S.humBuf = S.humBuf.slice(-120);
  S.scale = humCm / median(S.humBuf);
  const k = S.scale;

  // Предплечье от вертикали: + запястье ближе к ногам, чем локоть (локоть «отстал» к голове), − наоборот
  const forearm = Math.atan2((wr.x - el.x) * toFeet, el.y - wr.y) * 180 / Math.PI;
  const raw = { h: (sh.y - wr.y) * k, x: (wr.x - sh.x) * toFeet * k, hipY: hip.y * k, elbow, forearm };
  S.ema = S.ema ? Object.fromEntries(Object.keys(raw).map(q => [q, S.ema[q] * 0.5 + raw[q] * 0.5])) : raw;
  const m = S.ema;

  // Скорость грифа, см/с, за последние ~150 мс
  S.hist.push({ t: ts, h: m.h }); while (S.hist.length && ts - S.hist[0].t > 150) S.hist.shift();
  const h0 = S.hist[0];
  const v = S.hist.length > 2 ? (m.h - h0.h) / ((ts - h0.t) / 1000) : 0;
  const still = Math.abs(v) < B.stillSpeed;

  const locked = m.elbow > B.lockElbow && m.h > 25;
  const J = S.settings.judge !== "off";

  // ---------- Вершина ----------
  if (S.state === "idle" || S.state === "top") {
    if (locked) S.unlockedSince = 0;
    else if (S.summarized && !S.unlockedSince) S.unlockedSince = ts;
    if (S.unlockedSince && ts - S.unlockedSince > 1500) { S.startSaid = false; S.top = null; S.state = "idle"; S.unlockedSince = 0; }

    if (locked) {
      if (S.state === "idle") { S.state = "top"; S.topStillSince = ts; }
      if (!still) S.topStillSince = ts;
      const stillFor = ts - S.topStillSince;
      if (stillFor > 300) S.top = { h: m.h, x: m.x, hipY: m.hipY };

      status(S.set.length ? `Подход: ${S.set.length} повт.` : "Готов"); hint(S.set.length ? "" : "Можно начинать", "ok");
      if (J && !S.startSaid && !S.set.length && stillFor > B.startAfterMs) { S.startSaid = true; say(cmds().start, { force: true }); }
      if (J && S.set.length && !S.rackSaid && stillFor > B.rackAfterMs) { S.rackSaid = true; say(cmds().rack, { force: true }); }
      if (S.set.length && !S.summarized && stillFor > 2500) summary();
    } else if (S.state === "idle") {
      status("Жду вершину"); hint("Сними штангу и зафиксируй на прямых руках", "bad");
    }

    if (S.state === "top" && S.top && m.h < S.top.h - B.startDropCm) {
      S.state = "down";
      S.rep = { t0: ts, bottomH: m.h, bottomX: m.x, tBottom: ts, pauseStart: 0, pauseMs: 0,
        forearm: m.forearm, elbowBottom: m.elbow, maxFwd: 0, pathCued: false, faCued: false,
        pressSaid: 0, early: false, hipLift: 0, prof: [], top: { ...S.top } };
      status("Повтор " + (S.set.length + 1)); hint("");
    }
    if (!locked && S.state === "top" && !S.top) S.state = "idle";
    return;
  }

  // ---------- В повторе ----------
  const r = S.rep;
  // Гриф уехал к голове или завис внизу надолго — это постановка на стойки, а не повтор
  if ((S.state === "down" || S.state === "pause") && (m.x < B.rackXcm || (S.state === "pause" && ts - r.pauseStart > 8000))) {
    S.state = "idle"; S.rep = null; S.top = null;
    if (S.summarized || !S.set.length) S.startSaid = false;
    return;
  }
  r.hipLift = Math.max(r.hipLift, r.top.hipY - m.hipY);  // таз поднялся = y уменьшился
  if (S.settings.liveCues && !r.hipCued && r.hipLift > B.hipLiftCm) { r.hipCued = true; say("Таз!", { force: true }); }

  if (S.state === "down") {
    if (m.h < r.bottomH) { r.bottomH = m.h; r.bottomX = m.x; r.tBottom = ts; r.forearm = m.forearm; r.elbowBottom = m.elbow; }
    if (still && m.h < r.top.h * 0.5) { S.state = "pause"; r.pauseStart = ts; }
    else if (m.h > r.bottomH + B.upStartCm && r.top.h - r.bottomH > B.minRomCm) { S.state = "up"; r.pauseMs = 0; if (J) r.early = true; bottomCue(r); }
    if (locked && r.top.h - r.bottomH < B.minRomCm) { S.state = "top"; S.rep = null; }   // дрогнул на вершине — не повтор
    return;
  }

  if (S.state === "pause") {
    if (m.h < r.bottomH) { r.bottomH = m.h; r.bottomX = m.x; r.forearm = m.forearm; r.elbowBottom = m.elbow; }
    r.pauseMs = ts - r.pauseStart;
    if (J && !r.pressSaid && r.pauseMs > B.pressAfterMs) { r.pressSaid = ts; say(cmds().press, { force: true }); }
    if (m.h > r.bottomH + B.upStartCm) {
      if (J && !r.pressSaid) r.early = true;
      S.state = "up"; r.tUp = ts; bottomCue(r);
    }
    return;
  }

  // up
  r.tUp ??= ts;
  const rom = r.top.h - r.bottomH;
  r.maxFwd = Math.max(r.maxFwd, m.x - r.bottomX);
  if (S.settings.liveCues && !r.pathCued && m.x - r.bottomX > B.pathFwdCm && m.h - r.bottomH < rom * 0.6) {
    r.pathCued = true; say("Назад к плечам", { force: true });
  }
  r.prof.push({ h: (m.h + h0.h) / 2, v, t: ts });   // высота в середине окна скорости — без запаздывания
  if (locked && m.h > r.top.h - B.lockTolCm && still) finishRep(ts, m);
}

// Подсказка в нижней точке — пока ещё есть время поправить на следующем повторе
function bottomCue(r) {
  if (!S.settings.liveCues || r.faCued) return;
  if (r.forearm > B.forearmTol) { r.faCued = true; say("Локти под гриф", { force: true }); }
  else if (r.forearm < -B.forearmTol) { r.faCued = true; say("Касание выше", { force: true }); }
}

function stickingPoint(r) {
  // минимальная скорость на подъёме между 15% и 90% амплитуды (после стартового разгона)
  const rom = r.top.h - r.bottomH; if (rom < 10 || r.prof.length < 6) return null;
  let best = null;
  let maxV = 0;
  for (const p of r.prof) {
    const f = (p.h - r.bottomH) / rom;
    maxV = Math.max(maxV, p.v);
    if (f < 0.15 || f > 0.9 || maxV < 5) continue;
    if (!best || p.v < best.v) best = { v: p.v, cm: p.h - r.bottomH };
  }
  return best && best.v < maxV * 0.6 ? best : null;
}

function finishRep(ts, m) {
  const r = S.rep;
  const sp = stickingPoint(r);
  const rep = {
    n: S.set.length + 1,
    pause: r.pauseMs / 1000,
    early: r.early,
    touch: r.bottomX,                  // см от плеча к ногам — где гриф касается груди
    lockX: m.x,                        // где гриф на вершине относительно плеча
    path: m.x - r.bottomX,             // >0 — гриф уехал к ногам, <0 — к голове (нормальная J-траектория)
    hipLift: r.hipLift,
    sticking: sp?.cm ?? null,
    tDown: (r.tBottom - r.t0) / 1000,
    tUp: (ts - r.tUp) / 1000,
    rom: r.top.h - r.bottomH,
    forearm: r.forearm,          // наклон предплечья в низу, °
    elbowBottom: r.elbowBottom,  // угол в локте в низу, °
    pathFwd: r.maxFwd,           // насколько гриф уходил к ногам на подъёме, см
    lockElbow: m.elbow,
  };
  S.set.push(rep); S.state = "top"; S.rep = null; S.topStillSince = ts;
  S.lastRepEnd = ts; S.summarized = false; S.rackSaid = false;
  if (S.settings.liveCues) beep(900, 90);
  render();
}

const list = ns => ns.length > 1 && ns.length === S.set.length ? "во всех" : (ns.length === 1 ? "в повторе " : "в повторах ") + ns.join(", ");
const r1 = v => (Math.round(v * 10) / 10).toString().replace(".", ",");

function summary() {
  const set = S.set, n = set.length;
  const parts = [`${n} ${n === 1 ? "повтор" : n < 5 ? "повтора" : "повторов"}.`];
  const ok0 = parts.length;
  const faOut = set.filter(r => r.forearm > B.forearmTol).map(r => r.n);
  const faIn = set.filter(r => r.forearm < -B.forearmTol).map(r => r.n);
  if (faOut.length) parts.push(`Локти отставали от грифа ${list(faOut)}, предплечье около ${Math.round(median(set.filter(r => r.forearm > B.forearmTol).map(r => r.forearm)))} градусов от вертикали. Подводи локти под гриф.`);
  if (faIn.length) parts.push(`Локти уходили вперёд грифа ${list(faIn)}. Касайся чуть выше.`);
  const fwd = set.filter(r => r.pathFwd > B.pathFwdCm).map(r => r.n);
  if (fwd.length) parts.push(`На подъёме гриф уходил к ногам ${list(fwd)}. Жми назад, к плечам.`);
  const fast = set.filter(r => r.tDown < B.descentMinS).map(r => r.n);
  if (fast.length) parts.push(`Слишком быстро опускаешь ${list(fast)}.`);
  const soft = set.filter(r => r.lockElbow < B.fullLockElbow).map(r => r.n);
  if (soft.length) parts.push(`Не дожимаешь до прямых рук ${list(soft)}.`);
  if (S.settings.judge !== "off") {
    parts.push(`Пауза на груди ${r1(median(set.map(r => r.pause)))} секунды.`);
    const noPause = set.filter(r => r.pause < B.minPauseS).map(r => r.n);
    if (noPause.length) parts.push(`Без паузы ${list(noPause)}.`);
    const early = set.filter(r => r.early).map(r => r.n);
    if (early.length) parts.push(`Ранний жим ${list(early)}.`);
  }
  const hip = set.filter(r => r.hipLift > B.hipLiftCm).map(r => r.n);
  if (hip.length) parts.push(`Таз отрывался ${list(hip)}.`);
  const lockFwd = set.filter(r => r.lockX > B.lockForwardCm).map(r => r.n);
  if (lockFwd.length) parts.push(`На вершине гриф над грудью, а не над плечами ${list(lockFwd)}.`);
  const sps = set.map(r => r.sticking).filter(v => v != null);
  if (sps.length >= Math.max(1, n / 2)) parts.push(`Мёртвая точка около ${Math.round(median(sps))} сантиметров от груди.`);
  const touches = set.map(r => r.touch);
  if (Math.max(...touches) - Math.min(...touches) > B.touchSpreadCm) parts.push("Касание груди в разных местах.");
  if (parts.length === ok0 || (parts.length === ok0 + 1 && sps.length)) parts.splice(ok0, 0, "Траектория и углы ровные.");

  say(parts.join(" "), { force: true });
  S.sets.push(set); S.set = []; S.summarized = true; S.rackSaid = true;
  render(parts.join(" "));
}

const f0 = v => Number.isFinite(v) ? Math.round(v) : "–";
const sg = v => Number.isFinite(v) ? (v > 0 ? "+" : "") + Math.round(v) : "–";

function render(lastSummary) {
  const set = S.set.length ? S.set : (S.sets.at(-1) || []);
  const p = profile.proportions();
  let html = `<div class="mut small">Масштаб: ${p ? "плечо " + f0(p.upperArm) + " см из калибровки" : "по росту (сделай присед — будет точнее)"}</div>`;
  if (set.length) {
    const J = S.settings.judge !== "off";
    html += `<table><tr><th>#</th><th>Предпл.</th><th>Локоть</th><th>Касание</th><th>Вершина</th><th>МТ</th>${J ? "<th>Пауза</th>" : ""}<th></th></tr>`;
    for (const r of set) {
      const faCls = Math.abs(r.forearm) > B.forearmTol ? ' class="down"' : "";
      const flags = [r.pathFwd > B.pathFwdCm ? "к ногам" : "", r.hipLift > B.hipLiftCm ? "таз" : "", J && r.early ? "ранний" : ""].filter(Boolean).join(", ");
      html += `<tr><td>${r.n}</td><td${faCls}>${sg(r.forearm)}°</td><td>${f0(r.elbowBottom)}°</td><td>${sg(r.touch)}</td><td>${sg(r.lockX)}</td>`
        + `<td>${r.sticking != null ? f0(r.sticking) : "–"}</td>${J ? `<td>${r1(r.pause)} с</td>` : ""}<td class="small">${flags}</td></tr>`;
    }
    html += `</table><div class="mut small">Предплечье в низу: 0° — вертикально (оптимум), ± до ${B.forearmTol}° — норма; «+» локоть отстаёт к голове. `
      + `Касание и вершина — см от плечевого сустава к ногам; вершина около 0 — гриф над плечами. МТ — мёртвая точка, см от груди.</div>`;
  }
  if (lastSummary) html += `<div class="small" style="margin-top:6px">${lastSummary}</div>`;
  $("bpPanel").innerHTML = html;
}
