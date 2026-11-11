// Режим «Тяга»: классика и сумо.
// Камера сбоку (лучше 20–30° со стороны лица, чтобы блин не закрывал голени и кисти), ровно, на высоте таза.
// Вертикальные расстояния (высота таза, подъём таза) от такого поворота камеры не искажаются.
//
// Что меряем в каждом повторе:
//  - высоту таза над коленом в момент отрыва грифа — и сравниваем с целевой (модель по пропорциям,
//    потом — твоя рабочая высота из удачных повторов);
//  - подъём таза до отрыва («подскок»): от нижней точки таза за 2 с до отрыва — до момента отрыва;
//  - динамический старт: нырок тазом ≥ 6 см и отрыв ≤ 0.7 с после нижней точки; глубина нырка vs цель;
//  - «таз обгоняет гриф» до колен: насколько спина легла (угол к полу уменьшился) от отрыва до колен;
//  - плечи относительно грифа в момент отрыва;
//  - подводку: сколько секунд стоял в наклоне до отрыва;
//  - локаут: отклонение корпуса назад (слабое место в сумо), дожат ли таз и колени.
import { px, drawSkeleton, canvas } from "./pose.js";
import { angle, sideIdx, nearSide, median, dist } from "./geom.js";
import { say } from "./voice.js";
import { beep } from "./audio.js";
import * as profile from "./profile.js";

const $ = id => document.getElementById(id);
let S = null;

export const D = {
  setupHipA: 125,          // угол в тазу меньше — наклонился к грифу
  liftCm: 2.5,             // гриф поднялся на столько — отрыв
  lockA: 163,              // таз и колени прямее — локаут
  preRiseOk: 2.5, preRiseBad: 4,   // подъём таза до отрыва, см (у тебя хорошо было 2–2.5)
  earlyBackDeg: 6,         // спина «легла» на столько до колен — таз обогнал гриф
  targetTol: 4,            // ± см от твоей рабочей высоты таза
  targetTolModel: 7,       // ± см, пока цель — только модель по пропорциям
  hbTol: 4,                // ± см: таз позади грифа по горизонтали, своя цель
  hbTolModel: 6,           // ± см, по модели
  leanBackOk: 3, leanBackBad: 5,   // отклонение назад в локауте, °
  setupLongS: 5,           // подводка дольше — долго
  dynDipCm: 6, dynMaxMs: 700,      // признаки динамического старта
  maxPullMs: 10000,
  topMaxMs: 3000,          // в локауте дольше — это уже не повтор (встал без грифа, отдыхает)
  segLo: 0.7, segHi: 1.35,
};

const STYLE = {
  conv: { name: "классика", shAhead: 3, shinGap: 3, thighK: 1.0, shinVertical: false },
  sumo: { name: "сумо", shAhead: 3, shinGap: 2, thighK: 0.72, shinVertical: true },   // бёдра разведены — в профиль короче
};

/**
 * Модель стартовой позиции в профиль (см): лодыжка (0,0), гриф над серединой стопы (x=6) на высоте 22.5,
 * голень касается грифа, плечи впереди грифа на shAhead, руки прямые. Возвращает высоту таза над коленом.
 */
export function modelStart(style, p, height) {
  const st = STYLE[style] || STYLE.conv;
  const H = height || 178;
  const shin = p?.shin ?? 0.246 * H, thigh = (p?.thigh ?? 0.245 * H) * st.thighK, torso = p?.torso ?? 0.288 * H;
  const arm = (p?.upperArm ?? 0.186 * H) + (p?.forearm ?? 0.146 * H) + 6;   // + кисть до центра грифа
  const barX = 6, barY = 22.5;
  const shinX = st.shinVertical ? 0 : barX - st.shinGap;      // где голень на высоте грифа
  const a = Math.atan2(shinX, barY);                         // наклон голени вперёд
  const knee = { x: shin * Math.sin(a), y: shin * Math.cos(a) };
  const S = { x: barX + st.shAhead, y: barY + Math.sqrt(Math.max(0, arm * arm - st.shAhead * st.shAhead)) };
  // таз: на расстоянии thigh от колена и torso от плеча, позади колена
  const dx = S.x - knee.x, dy = S.y - knee.y, d = Math.hypot(dx, dy);
  if (d > thigh + torso || d < Math.abs(thigh - torso)) return null;
  const aa = (thigh * thigh - torso * torso + d * d) / (2 * d), h = Math.sqrt(Math.max(0, thigh * thigh - aa * aa));
  const mx = knee.x + dx * aa / d, my = knee.y + dy * aa / d;
  const c1 = { x: mx + dy * h / d, y: my - dx * h / d }, c2 = { x: mx - dy * h / d, y: my + dx * h / d };
  const hip = c1.x < c2.x ? c1 : c2;
  const back = Math.atan2(S.y - hip.y, S.x - hip.x) * 180 / Math.PI;
  return { hipAboveKnee: hip.y - knee.y, hipHeight: hip.y, hipBehind: barX - hip.x, back };
}

// ---------- твоя рабочая высота старта: из повторов с маленьким подскоком ----------
const KEY = "lc.deadlift.v1";
const loadStore = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { conv: [], sumo: [] }; } catch { return { conv: [], sumo: [] }; } };
const saveStore = d => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch {} };
function personalTarget(style) {
  const a = loadStore()[style] || [];
  return a.length >= 3 ? median(a) : null;
}
function addGoodStart(style, v, hb) {
  const d = loadStore(); d[style] = [...(d[style] || []), Math.round(v * 10) / 10].slice(-15);
  if (Number.isFinite(hb)) d[style + "_hb"] = [...(d[style + "_hb"] || []), Math.round(hb * 10) / 10].slice(-15);
  saveStore(d);
}

export function deadliftStart(settings) {
  S = {
    settings, style: settings.dlStyle || "conv",
    scaleBuf: [], scale: NaN, segs: [], thighBuf: [], shinBuf: [],
    state: "idle", side: null, buf: [], rep: null,
    set: [], sets: [], lastRepEnd: 0, summarized: true,
    setupSince: 0, cueSaid: {}, hist: [], stillSince: 0, ema: null, lostSince: 0,
  };
  updateStyleButton();
  hint("Подойди к грифу боком к камере", "");
  render();
}

export function deadliftSetStyle(style) {
  if (!S) return;
  S.style = style; S.settings.dlStyle = style;
  updateStyleButton(); render();
  say(style === "sumo" ? "Сумо" : "Классика", { force: true });
}
function updateStyleButton() { const b = $("dlStyle"); if (b) b.textContent = S.style === "sumo" ? "Сумо ⇄" : "Классика ⇄"; }

export function deadliftEndSet() { if (S?.set.length) summary(); }

function hint(t, cls = "") { const el = $("dlHint"); el.textContent = t || ""; el.className = "wz-hint " + cls; }
const status = t => { $("modeStatus").textContent = t; };

function target() {
  const pers = personalTarget(S.style);
  const m = modelStart(S.style, props(), S.settings.height);
  const hbA = loadStore()[S.style + "_hb"] || [];
  const hb = hbA.length >= 3 ? { hb: median(hbA), hbSrc: "твоя" } : { hb: m?.hipBehind ?? null, hbSrc: "модель" };
  if (pers != null) return { v: pers, src: "твоя", ...hb };
  return m ? { v: m.hipAboveKnee, src: "модель", ...hb } : null;
}
// пропорции: накопленный профиль → замер в этой сессии (стоя боком) → средние по росту
function props() {
  const p = profile.proportions();
  if (p) return p;
  if (S.segs.length < 15) return null;
  const o = {};
  for (const f of ["thigh", "shin", "torso", "upperArm", "forearm"]) {
    const v = S.segs.map(x => x[f]).filter(Number.isFinite);
    if (v.length) o[f] = median(v);
  }
  return o;
}

const inRep = () => S.state === "pull" || S.state === "top" || S.state === "lower";

export function deadliftFrame(res, lm, ts) {
  if (!S) return;
  if (!lm) { if (!inRep()) hint("Не вижу тебя", "bad"); return; }
  const side = S.side ?? nearSide(lm).side;
  const s = sideIdx(side);
  drawSkeleton(lm, { highlight: Object.values(s) });

  const vis = i => (lm[i].visibility ?? 0) > 0.45;
  if (![s.sh, s.hip, s.kn].every(vis)) {
    S.lostSince ||= ts;
    if (S.rep) S.rep.unseen++;
    if (!inRep() && ts - S.lostSince > 2000) { hint("Не вижу корпус и ноги целиком", "bad"); say("Не вижу корпус и ноги", { persist: 3000, repeatAfter: 25000 }); }
    return;
  }
  S.lostSince = 0;

  const P = i => px(lm, i);
  const sh = P(s.sh), hip = P(s.hip), kn = P(s.kn), an = P(s.an), wr = P(s.wr), heel = P(s.heel), toe = P(s.toe);
  const thighPx = dist(hip, kn), shinPx = dist(kn, an);
  const tMed = median(S.thighBuf), sMed = median(S.shinBuf);
  if (Number.isFinite(tMed) && (thighPx / tMed < D.segLo || thighPx / tMed > D.segHi)) { if (S.rep) S.rep.unseen++; return; }

  const fwd = Math.sign(toe.x - heel.x) || Math.sign(wr.x - hip.x) || 1;
  const raw = {
    hipA: angle(sh, hip, kn), knee: angle(hip, kn, an),
    back: Math.atan2(hip.y - sh.y, Math.abs(sh.x - hip.x)) * 180 / Math.PI,      // спина к полу: 0 — горизонтально
    lean: Math.atan2((sh.x - hip.x) * fwd, hip.y - sh.y) * 180 / Math.PI,         // от вертикали: − назад
    hipY: hip.y, hipX: hip.x, knY: kn.y, barY: wr.y, barX: wr.x, shX: sh.x, midX: (heel.x + toe.x) / 2,
  };
  S.ema = S.ema ? Object.fromEntries(Object.keys(raw).map(k => [k, S.ema[k] * 0.5 + raw[k] * 0.5])) : raw;
  const m = S.ema;

  // масштаб: стоя ровно — по росту (если видна голова) или по голени
  S.hist.push({ t: ts, x: hip.x, y: hip.y }); while (S.hist.length && ts - S.hist[0].t > 700) S.hist.shift();
  const tol = 0.15 * (Number.isFinite(tMed) ? tMed : thighPx);
  const xs = S.hist.map(h => h.x), ys = S.hist.map(h => h.y);
  const still = S.hist.length > 5 && Math.max(...xs) - Math.min(...xs) < tol && Math.max(...ys) - Math.min(...ys) < tol;
  if (!still) S.stillSince = ts;
  const upright = m.hipA > 165 && m.knee > 160 && Math.abs(m.lean) < 15;
  if (upright && still && !inRep()) {
    S.thighBuf.push(thighPx); S.shinBuf.push(shinPx); S.thighBuf = S.thighBuf.slice(-90); S.shinBuf = S.shinBuf.slice(-90);
    const eyeOk = (lm[2].visibility ?? 0) > 0.5 && vis(s.heel);
    const sc = eyeOk ? profile.scaleFromStanding(lm, S.settings.height, side) : NaN;
    const p = profile.proportions();
    const scShin = (p?.shin ?? 0.246 * S.settings.height) / median(S.shinBuf);
    S.scaleBuf.push(Number.isFinite(sc) ? sc : scShin); S.scaleBuf = S.scaleBuf.slice(-90); S.scale = median(S.scaleBuf);
    // свои пропорции из стойки — если профиль ещё не накоплен в приседе/жиме
    if (Number.isFinite(S.scale)) { S.segs.push(profile.segmentsCm(lm, side, S.scale)); S.segs = S.segs.slice(-90); }
  }
  const k = Number.isFinite(S.scale) ? S.scale : ((profile.proportions()?.shin ?? 0.246 * S.settings.height) / (Number.isFinite(sMed) ? sMed : shinPx));
  const hipAboveKnee = (m.knY - m.hipY) * k;

  const tg = target();

  // ---------- вне повтора ----------
  if (S.state === "idle") {
    status(S.set.length ? `Подход: ${S.set.length} повт.` : (S.style === "sumo" ? "Сумо" : "Классика"));
    hint(S.set.length ? "" : "Встань к грифу и наклонись", "");
    if (m.hipA < D.setupHipA && m.barY > m.knY - 0.15 * (sMed || shinPx)) {     // наклонился, кисти у колен и ниже
      S.state = "setup"; S.side = side; S.buf = []; S.setupSince = ts; S.barFloor = m.barY; S.cueSaid = {};
    }
    if (S.set.length && !S.summarized && ts - S.lastRepEnd > 4000 && still) summary();
    return;
  }

  if (S.state === "setup") {
    const hipBehind = (m.barX - m.hipX) * fwd * k;      // таз позади грифа по горизонтали, см
    S.buf.push({ t: ts, hak: hipAboveKnee, hb: hipBehind, barY: raw.barY, back: m.back, shX: m.shX, barX: m.barX, midX: m.midX, fwd });
    while (S.buf.length && ts - S.buf[0].t > 3000) S.buf.shift();
    S.barFloor = Math.max(S.barFloor, median(S.buf.slice(-8).map(b => b.barY)));   // нижнее положение грифа (y вниз)
    status("Старт");

    // подсказка по высоте таза: стоишь в старте неподвижно ≥ 0.8 с
    if (tg && still && ts - S.stillSince > 800) {
      const d = hipAboveKnee - tg.v;
      const tol = tg.src === "модель" ? D.targetTolModel : D.targetTol;   // модель — ориентир, своя высота — точнее
      if (d > tol) { hint(`Таз ниже на ${Math.round(d)} см`, "bad"); say("Таз ниже", { persist: 300, repeatAfter: 6000 }); }
      else if (d < -tol) { hint(`Таз выше на ${Math.round(-d)} см`, "bad"); say("Таз выше", { persist: 300, repeatAfter: 6000 }); }
      else {
        // высота в норме — проверяем, как далеко таз позади грифа
        const dh = tg.hb != null ? hipBehind - tg.hb : 0;
        const tolH = tg.hbSrc === "модель" ? D.hbTolModel : D.hbTol;
        if (dh > tolH) { hint(`Таз далеко от грифа на ${Math.round(dh)} см`, "bad"); say("Таз ближе к грифу", { persist: 300, repeatAfter: 6000 }); }
        else if (dh < -tolH) { hint(`Таз слишком близко к грифу на ${Math.round(-dh)} см`, "bad"); say("Таз дальше от грифа", { persist: 300, repeatAfter: 6000 }); }
        else hint("Таз — ок", "ok");
      }
    }
    // отрыв: гриф поднялся над нижним положением
    const lifted = (S.barFloor - raw.barY) * k > D.liftCm;
    S.liftN = lifted ? (S.liftN || 0) + 1 : 0;
    if (S.liftN >= 2) startPull(ts, k, tg);
    else if (m.hipA > 160) S.state = "idle";      // выпрямился без отрыва — отошёл
    if (S.set.length && !S.summarized && ts - S.lastRepEnd > 6000) summary();
    return;
  }

  const r = S.rep;
  if (S.state === "pull" && m.barY > m.knY) r.barDrift = Math.max(r.barDrift, Math.abs(m.barX - m.midX) * k);   // ниже колен гриф должен идти над серединой стопы
  if (ts - r.t0 > D.maxPullMs) { S.state = "idle"; S.rep = null; S.side = null; return; }

  if (S.state === "pull") {
    if (r.backKnee == null && m.barY <= m.knY) r.backKnee = m.back;    // гриф дошёл до колен
    if (m.hipA > D.lockA && m.knee > D.lockA - 5) { S.state = "top"; r.tTop = ts; r.leans = []; }
    return;
  }

  // top: собираем наклон в локауте ~0.8 с
  if (S.state === "top") {
    r.leans.push(m.lean);
    if (m.barY > m.knY) { S.state = "lower"; r.tLower = ts; }   // гриф пошёл вниз ниже колен
    else if (ts - r.tTop > D.topMaxMs) { S.state = "idle"; S.rep = null; S.side = null; }   // стоит дольше — значит, встал без штанги и отдыхает
    return;
  }

  // lower: повтор засчитываем, когда гриф снова у пола (в наклоне). Встал без грифа и не опускал — не повтор.
  if (m.hipA < D.setupHipA + 10 && (S.barFloor - raw.barY) * k < 6) finishRep(ts);
  else if (ts - r.tLower > 4000) { S.state = "idle"; S.rep = null; S.side = null; }
}

function startPull(ts, k, tg) {
  const b = S.buf;
  // момент отрыва — последний кадр, где гриф был у пола (в пределах 1 см)
  let iL = b.length - 1;
  while (iL > 0 && (S.barFloor - b[iL].barY) * k > 1) iL--;
  const L = b[iL];
  const win = b.filter(x => x.t >= L.t - 2000 && x.t <= L.t);
  let low = win[0]; for (const x of win) if (x.hak < low.hak) low = x;     // нижняя точка таза до отрыва
  const before = win.filter(x => x.t <= low.t && x.t >= L.t - 1500);
  const high = before.reduce((a, x) => (x.hak > a ? x.hak : a), low.hak);
  const dip = high - low.hak;
  const dynamic = dip >= D.dynDipCm && L.t - low.t <= D.dynMaxMs;
  S.rep = {
    t0: L.t, style: S.style,
    startHip: L.hak, lowHip: low.hak, preRise: L.hak - low.hak, hipBehind: L.hb, hbTarget: tg?.hb ?? null,
    dynamic, dip, dipToLift: (L.t - low.t) / 1000,
    target: tg?.v ?? null, targetSrc: tg?.src ?? null,
    backStart: L.back, backKnee: null,
    shAhead: (L.shX - L.barX) * k * L.fwd,      // + плечи впереди грифа (в сторону носков)
    setupS: (L.t - S.setupSince) / 1000,
    barDrift: 0, unseen: 0,
  };
  S.state = "pull"; status("Тяга");
  hint("");
}

function finishRep(ts) {
  const r = S.rep;
  const leanBack = Math.max(0, -Math.min(...r.leans));       // насколько отклонился назад, °
  const rep = {
    n: S.set.length + 1, style: r.style,
    startHip: r.startHip, target: r.target, targetSrc: r.targetSrc, hipBehind: r.hipBehind, hbTarget: r.hbTarget,
    preRise: r.preRise, dynamic: r.dynamic, dip: r.dip, dipToLift: r.dipToLift,
    lowVsTarget: r.target != null ? r.lowHip - r.target : null,
    backStart: r.backStart, backDrop: r.backKnee != null ? r.backStart - r.backKnee : null,
    shAhead: r.shAhead, setupS: r.setupS, leanBack, barDrift: r.barDrift,
  };
  if (rep.preRise <= D.preRiseOk) addGoodStart(r.style, r.startHip, r.hipBehind);
  S.set.push(rep); S.rep = null;
  S.state = "setup"; S.buf = []; S.setupSince = ts; S.liftN = 0;     // гриф у пола — следующий повтор или отпустишь и встанешь
  S.lastRepEnd = ts; S.summarized = false;
  beep(1000, 90);
  // короткая подсказка сразу после повтора — по главному для стиля
  if (S.settings.liveCues) {
    if (rep.preRise > D.preRiseBad) say(`Таз подскочил на ${Math.round(rep.preRise)}`, { force: true });
    else if (r.style === "sumo" && leanBack > D.leanBackBad) say("Не отклоняйся назад", { force: true });
  }
  render();
}

const list = ns => ns.length === S.set.length && ns.length > 1 ? "во всех" : (ns.length === 1 ? "в повторе " : "в повторах ") + ns.join(", ");
const cm = v => `${Math.round(v)} см`;

function summary() {
  const set = S.set, n = set.length, style = set[0]?.style || S.style;
  const parts = [`${STYLE[style].name}, ${n} ${n === 1 ? "повтор" : n < 5 ? "повтора" : "повторов"}.`];

  // 1. подскок таза до отрыва — главное слабое место в классике
  const pr = set.map(r => r.preRise);
  const bad = set.filter(r => r.preRise > D.preRiseBad).map(r => r.n);
  const warn = set.filter(r => r.preRise > D.preRiseOk && r.preRise <= D.preRiseBad).map(r => r.n);
  if (!bad.length && !warn.length) parts.push(`Таз до отрыва почти не поднимался, около ${cm(median(pr))}. Хорошо.`);
  else {
    if (bad.length) parts.push(`Таз подскакивал до отрыва ${list(bad)}, до ${cm(Math.max(...set.filter(r => bad.includes(r.n)).map(r => r.preRise)))}.`);
    if (warn.length) parts.push(`Небольшой подскок ${list(warn)}.`);
    if (n >= 3 && set.at(-1).preRise > set[0].preRise + 1.5) parts.push("К концу подхода подскок растёт — на последних повторах не садись ниже.");
  }

  // 2. динамический старт
  const dyn = set.filter(r => r.dynamic);
  if (dyn.length) {
    const deep = dyn.filter(r => r.lowVsTarget != null && r.lowVsTarget < -D.targetTol).map(r => r.n);
    if (deep.length) parts.push(`Нырок уходил ниже нужной высоты ${list(deep)} — опускай таз ровно до стартовой высоты и сразу тяни.`);
    const slow = dyn.filter(r => r.dipToLift > 0.5).map(r => r.n);
    if (slow.length) parts.push(`После нырка была пауза ${list(slow)} — нижняя точка нырка и есть отрыв.`);
    if (style === "conv" && dyn.some(r => r.preRise > D.preRiseOk)) parts.push("В классике динамика пока сбивает старт — попробуй статический.");
  }

  // 3. высота старта
  const withT = set.filter(r => r.target != null);
  if (withT.length) {
    const d = median(withT.map(r => r.startHip - r.target));
    const tolT = withT[0].targetSrc === "модель" ? D.targetTolModel : D.targetTol;
    if (d > tolT) parts.push(`Стартуешь с тазом выше цели примерно на ${cm(d)}.`);
    else if (d < -tolT) parts.push(`Стартуешь с тазом ниже цели примерно на ${cm(-d)}.`);
  }

  // 3а. таз позади грифа по горизонтали
  const withH = set.filter(r => r.hbTarget != null && Number.isFinite(r.hipBehind));
  if (withH.length) {
    const d = median(withH.map(r => r.hipBehind - r.hbTarget));
    const tolH = D.hbTol + 2;
    if (d > tolH) parts.push(`Таз в старте далеко позади грифа, примерно на ${cm(d)} больше нормы — подведи таз ближе, голени к грифу.`);
    else if (d < -tolH) parts.push(`Таз в старте слишком близко к грифу, примерно на ${cm(-d)} — колени выдвигают гриф вперёд.`);
  }

  // 3б. плечи относительно грифа при отрыве (классика: 2–5 см впереди; сумо: над грифом или чуть впереди)
  const sa = median(set.map(r => r.shAhead));
  if (style === "conv" && sa > 7) parts.push(`Плечи сильно впереди грифа, около ${cm(sa)} — таз высоко, спина почти горизонтальна.`);
  if (sa < -2) parts.push(`Плечи за грифом, около ${cm(-sa)} — таз слишком низко, гриф уйдёт вперёд.`);

  // 4. таз обгоняет гриф до колен
  const early = set.filter(r => r.backDrop != null && r.backDrop > D.earlyBackDeg).map(r => r.n);
  if (early.length) parts.push(`До колен таз обгонял гриф ${list(early)} — толкай пол ногами, грудь вверх.`);

  // 5. подводка
  const longSetup = set.filter(r => r.setupS > D.setupLongS).map(r => r.n);
  if (longSetup.length) parts.push(`Долгая подводка ${list(longSetup)}, до ${Math.round(Math.max(...set.map(r => r.setupS)))} секунд. Цель — 2–3.`);

  // 6. локаут — главное слабое место в сумо
  const lb = set.filter(r => r.leanBack > D.leanBackBad);
  if (lb.length) parts.push(`В локауте отклонялся назад ${list(lb.map(r => r.n))}, до ${Math.round(Math.max(...lb.map(r => r.leanBack)))} градусов. Ягодицы сжать, рёбра вниз, встать вертикально.`);
  else if (style === "sumo") parts.push("Локаут вертикальный.");

  // 7. гриф от ног
  const drift = set.filter(r => r.barDrift > 6).map(r => r.n);
  if (drift.length) parts.push(`Гриф отходил от ног ${list(drift)}.`);

  say(parts.join(" "), { force: true });
  S.sets.push(set); S.set = []; S.summarized = true;
  render(parts.join(" "));
}

const f0 = v => (v == null || !Number.isFinite(v)) ? "–" : Math.round(v);
const sg = v => (v == null || !Number.isFinite(v)) ? "–" : (v > 0 ? "+" : "") + Math.round(v);

function render(lastSummary) {
  const set = S.set.length ? S.set : (S.sets.at(-1) || []);
  const tg = target();
  const m = modelStart(S.style, props(), S.settings.height);
  let html = `<div class="mut small">${S.style === "sumo" ? "Сумо" : "Классика"} · цель: таз над коленом ${tg ? f0(tg.v) + " см (" + tg.src + ")" : "–"}, позади грифа ${tg?.hb != null ? f0(tg.hb) + " см (" + tg.hbSrc + ")" : "–"}`
    + (m ? ` · угол спины ≈ ${f0(m.back)}°` : "") + `</div>`;
  if (set.length) {
    html += `<table><tr><th>#</th><th>Старт</th><th>За грифом</th><th>Подскок</th><th>Спина</th><th>Локаут</th><th></th></tr>`;
    for (const r of set) {
      const preCls = r.preRise > D.preRiseBad ? ' class="down"' : r.preRise > D.preRiseOk ? ' class="up"' : "";
      const flags = [r.dynamic ? `нырок ${f0(r.dip)}` : "", r.setupS > D.setupLongS ? `подводка ${f0(r.setupS)} с` : "", r.barDrift > 6 ? "гриф от ног" : ""].filter(Boolean).join(", ");
      html += `<tr><td>${r.n}</td><td>${f0(r.startHip)} см</td><td>${f0(r.hipBehind)} см</td><td${preCls}>${r.preRise.toFixed(1)} см</td>`
        + `<td>${r.backDrop != null ? sg(-r.backDrop) + "°" : "–"}</td><td>${r.leanBack > 0.5 ? "−" + f0(r.leanBack) + "°" : "ровно"}</td><td class="small">${flags}</td></tr>`;
    }
    html += `</table><div class="mut small">Старт — таз над коленом при отрыве. За грифом — таз позади грифа по горизонтали. Подскок — подъём таза до отрыва (хорошо ≤ ${D.preRiseOk} см). Спина — как изменился угол спины до колен (минус — таз обгоняет гриф). Локаут — отклонение назад.</div>`;
  }
  if (lastSummary) html += `<div class="small" style="margin-top:6px">${lastSummary}</div>`;
  $("dlPanel").innerHTML = html;
}

export function deadliftDebug() {
  if (!S || !S.ema) return null;
  const e = S.ema, r = x => Math.round(x * 10) / 10;
  return { state: S.state, style: S.style, hipA: r(e.hipA), knee: r(e.knee), back: r(e.back), lean: r(e.lean), scale: r(S.scale * 1000) / 1000, reps: S.set.length };
}
export function deadliftHistory() { return S ? { sets: [...S.sets, S.set].filter(s => s.length) } : null; }
