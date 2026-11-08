// Настройка ракурса в два этапа:
//  1) «У телефона» — уровень и ориентация; показываем, что поправить в штативе (по последней проверке).
//  2) «На месте» — ты в позиции подхода; проверяем ракурс и говорим поправки в сантиметрах.
// Ушёл из кадра — снова этап 1 (видимо, пошёл к штативу). Вернулся — снова проверка.
// Высоту камеры оцениваем через горизонт: при ровном телефоне центр кадра = высота объектива.
import { px, drawSkeleton, video, lockTarget } from "./pose.js";
import { nearSide, sideIdx, dist, angle } from "./geom.js";
import { level } from "./level.js";
import { say } from "./voice.js";
import * as profile from "./profile.js";

const $ = id => document.getElementById(id);
const TOL = 3;                 // градусов для уровня
const HFOV_LONG = 63;          // угол обзора основной камеры iPhone по длинной стороне кадра (приблизительно)
let S = null;

const GUIDE = {
  squat: {
    title: "Ракурс: присед",
    phone: "Штатив сбоку, строго перпендикулярно месту подхода, в 2–3 м. Объектив между коленом и тазом (≈ 60–80 см от пола). Выставь уровень и иди на место.",
    place: "Встань туда, где будешь приседать после отшагивания, боком к камере, руки как на грифе.",
    phoneItems: [["level", "Телефон ровно"]],
    placeItems: [["side", "Строго сбоку"], ["visible", "Всё тело видно, стойки не мешают"], ["dist", "Расстояние"], ["center", "По центру, запас по краям"], ["height", "Высота: между коленом и тазом"]],
  },
  bench: {
    title: "Ракурс: жим",
    phone: "Телефон горизонтально. Штатив сбоку от скамьи в ≈ 2 м, чуть ближе к ногам, чтобы стойки не закрывали руку. Объектив чуть выше скамьи (≈ 50–70 см от пола). Выставь уровень и иди на скамью.",
    place: "Ляг на скамью и подними прямые руки вверх, как на вершине.",
    phoneItems: [["landscape", "Телефон горизонтально"], ["level", "Телефон ровно"]],
    placeItems: [["pose", "Лёжа, руки вверх"], ["side", "Строго сбоку от скамьи"], ["visible", "Рука и таз видны, стойки не мешают"], ["dist", "Расстояние"], ["height", "Высота: чуть выше скамьи"]],
  },
};

// ---------- поправки в сантиметрах ----------
const round10 = v => Math.max(5, Math.round(Math.abs(v) / 5) * 5);

/** Примерное расстояние до камеры, см — по масштабу (см/пикс) и углу обзора */
function camDistance(k) {
  const longPx = Math.max(video.videoWidth, video.videoHeight);
  return (longPx / 2) * k / Math.tan(HFOV_LONG / 2 * Math.PI / 180);
}

function moveText(sizeNow, sizeTarget, k) {
  const d = camDistance(k);
  const delta = d * (sizeNow / sizeTarget - 1);
  return delta > 0 ? `Отодвинь штатив назад на ~${round10(delta)} см` : `Придвинь штатив ближе на ~${round10(delta)} см`;
}

const heightText = cm => cm > 0 ? `Опусти камеру на ~${round10(cm)} см` : `Подними камеру на ~${round10(cm)} см`;
const lateralText = cm => cm > 0 ? `Сдвинь штатив вправо на ~${round10(cm)} см` : `Сдвинь штатив влево на ~${round10(cm)} см`;

function levelCheck() {
  if (!level.available) return { ok: true };   // датчика нет — не блокируем
  if (Math.abs(level.pitch) > TOL) return { ok: false, hint: level.pitch > 0 ? "Наклони телефон верхом к себе" : "Наклони телефон верхом от себя" };
  if (Math.abs(level.roll) > TOL) return { ok: false, hint: "Выровняй телефон по горизонту" };
  return { ok: true };
}

function phoneChecks(mode) {
  const r = { level: levelCheck() };
  if (mode === "bench") r.landscape = video.videoWidth > video.videoHeight ? { ok: true } : { ok: false, hint: "Поверни телефон горизонтально" };
  return r;
}

function squatChecks(lm, height) {
  const r = {};
  const { side } = nearSide(lm); const s = sideIdx(side); const P = i => px(lm, i);
  const vis = i => lm[i].visibility ?? 0;
  const vw = video.videoWidth, vh = video.videoHeight;

  const eyeY = Math.min(lm[2].y, lm[5].y), floorY = Math.max(lm[s.heel].y, lm[s.toe].y);
  const size = floorY - eyeY;
  const k = height * 0.936 / (size * vh);           // см на пиксель

  const shW = dist(P(11), P(12)), torso = dist(P(s.hip), P(s.sh)) || 1;
  const shin = dist(P(s.kn), P(s.an)) || 1;
  const anDx = Math.abs(P(27).x - P(28).x);
  if (shW / torso < 0.35 && anDx / shin < 0.45) r.side = { ok: true };
  else {
    const deg = Math.round(Math.asin(Math.min(1, shW * k / 38)) * 180 / Math.PI / 5) * 5;
    r.side = { ok: false, hint: "Поставь камеру строго сбоку", fix: `Поверни штатив на ~${Math.max(5, deg)}°, чтобы смотреть строго сбоку` };
  }

  const need = [s.sh, s.hip, s.kn, s.an, s.heel, s.toe];
  const inFrame = need.every(i => lm[i].x > 0.01 && lm[i].x < 0.99 && lm[i].y > 0.01 && lm[i].y < 0.99);
  r.visible = inFrame && need.every(i => vis(i) > 0.7) ? { ok: true }
    : { ok: false, hint: !inFrame ? "Не помещаешься в кадр" : "Что-то закрывает ноги или таз",
        fix: !inFrame ? null : "Сдвинь штатив так, чтобы стойки не перекрывали ноги и таз" };

  const target = 0.66;
  r.dist = size > 0.82 || size < 0.5
    ? { ok: false, hint: size > 0.82 ? "Камера слишком близко" : "Камера слишком далеко", fix: moveText(size, target, k) }
    : { ok: true };

  const hipX = lm[s.hip].x;
  r.center = hipX > 0.3 && hipX < 0.7 && eyeY > 0.04 && floorY < 0.96 ? { ok: true }
    : { ok: false, hint: "Ты не по центру кадра",
        fix: hipX <= 0.3 || hipX >= 0.7 ? lateralText((hipX - 0.5) * vw * k) : null };
  if (!r.center.ok && !r.center.fix) r.center.fix = eyeY <= 0.04 ? "Голова у края кадра — отодвинь штатив или подними камеру" : "Стопы у края кадра — отодвинь штатив или опусти камеру";

  if (level.available && levelCheck().ok) {
    const kn = lm[s.kn].y, hip = lm[s.hip].y, targetY = (kn + hip) / 2;
    // y растёт вниз: центр ниже колена — камера низко; центр выше таза — камера высоко
    r.height = 0.5 < kn + 0.03 && 0.5 > hip - 0.05 ? { ok: true }
      : { ok: false, hint: 0.5 >= kn + 0.03 ? "Камера слишком низко" : "Камера слишком высоко", fix: heightText((targetY - 0.5) * vh * k) };
  } else r.height = { ok: !level.available, hint: "Сначала выровняй телефон" };
  return r;
}

function benchChecks(lm, height) {
  const r = {};
  const { side } = nearSide(lm); const s = sideIdx(side); const P = i => px(lm, i);
  const vis = i => lm[i].visibility ?? 0;
  const vw = video.videoWidth, vh = video.videoHeight;
  const sh = P(s.sh), el = P(s.el), wr = P(s.wr), hip = P(s.hip);
  const torso = dist(sh, hip) || 1;
  const humCm = profile.proportions()?.upperArm || 0.186 * height;
  const k = humCm / (dist(sh, el) || 1);

  const lying = Math.abs(Math.atan2(hip.y - sh.y, Math.abs(hip.x - sh.x))) * 180 / Math.PI < 25;
  const armsUp = angle(sh, el, wr) > 150 && wr.y < sh.y - torso * 0.6;
  r.pose = lying && armsUp ? { ok: true } : { ok: false, hint: lying ? "Подними прямые руки вверх" : "Ляг на скамью" };
  if (!r.pose.ok) return r;   // остальное без правильной позы не проверить

  const shDx = Math.abs(P(11).x - P(12).x), hipDx = Math.abs(P(23).x - P(24).x);
  const off = (shDx + hipDx) / 2;
  if (off / torso < 0.2) r.side = { ok: true };
  else {
    const deg = Math.round(Math.asin(Math.min(1, off * k / 38)) * 180 / Math.PI / 5) * 5;
    r.side = { ok: false, hint: "Камера не перпендикулярно скамье", fix: `Поверни штатив на ~${Math.max(5, deg)}°, перпендикулярно скамье` };
  }

  const need = [s.sh, s.el, s.wr, s.hip];
  const inFrame = need.every(i => lm[i].x > 0.02 && lm[i].x < 0.98 && lm[i].y > 0.04 && lm[i].y < 0.98);
  const toFeet = Math.sign(hip.x - sh.x) || 1;
  r.visible = inFrame && need.every(i => vis(i) > 0.7) ? { ok: true }
    : !inFrame
      ? { ok: false, hint: "Руки не помещаются в кадр", fix: wr.y / vh < 0.04 ? heightText(-(0.1 - wr.y / vh) * vh * k) : "Отодвинь штатив, руки у края кадра" }
      : { ok: false, hint: "Стойки закрывают руку", fix: `Сдвинь штатив к ногам на ~20 см (${toFeet > 0 ? "вправо" : "влево"})` };

  const frac = torso / vw, target = 0.28;
  r.dist = frac > 0.42 || frac < 0.18
    ? { ok: false, hint: frac > 0.42 ? "Камера слишком близко" : "Камера слишком далеко", fix: moveText(frac, target, k) }
    : { ok: true };

  if (level.available && levelCheck().ok) {
    const y = sh.y / vh;
    r.height = y >= 0.55 && y <= 0.85 ? { ok: true }
      : { ok: false, hint: y < 0.55 ? "Камера слишком низко" : "Камера слишком высоко", fix: heightText((y - 0.7) * vh * k) };
  } else r.height = { ok: !level.available, hint: "Сначала выровняй телефон" };
  return r;
}

// ---------- UI и логика этапов ----------
function renderList(id, items, r) {
  $(id).innerHTML = items.map(([key, label]) => {
    const c = r?.[key];
    const cls = !c ? "" : c.ok ? "ok" : "bad";
    return `<li class="${cls}"><span class="dot"></span>${label}</li>`;
  }).join("");
}

export function setupStart(mode, onDone, settings) {
  S = { mode, onDone, height: settings?.height || 178, phase: "phone", seenSince: 0, goneSince: 0, okSince: 0,
        fixes: [], lastPlace: null, done: false };
  const g = GUIDE[mode];
  $("suTitle").textContent = g.title;
  $("setup").hidden = false;
  showPhase();
  say("Выстави телефон и иди на место", { force: true });
}

export function setupStop() { $("setup").hidden = true; S = null; }

function showPhase() {
  const g = GUIDE[S.mode];
  $("suPhase").textContent = S.phase === "phone" ? "Этап 1 из 2 · у телефона" : "Этап 2 из 2 · на месте";
  $("suInstr").textContent = S.phase === "phone" ? g.phone : g.place;
  $("suFixBox").hidden = !(S.phase === "phone" && S.fixes.length);
  $("suFix").innerHTML = S.fixes.map(f => `<li>${f}</li>`).join("");
}

function personPresent(lm) {
  if (!lm) return false;
  const s = sideIdx(nearSide(lm).side);
  if (![s.sh, s.hip].every(i => (lm[i].visibility ?? 0) > 0.6)) return false;
  // человек на заднем плане мельче — его не считаем «на месте»
  if (S.mode === "bench") return dist(px(lm, s.sh), px(lm, s.hip)) / video.videoWidth > 0.12;
  const eyeY = Math.min(lm[2].y, lm[5].y), floorY = Math.max(lm[s.heel].y, lm[s.toe].y);
  return floorY - eyeY > 0.35;
}

export function setupFrame(res, lm, ts) {
  if (!S || S.done) return;
  const g = GUIDE[S.mode];
  if (lm) drawSkeleton(lm, { highlight: Object.values(sideIdx(nearSide(lm).side)) });

  const phone = phoneChecks(S.mode);
  const phoneOk = Object.values(phone).every(c => c.ok);
  const present = personPresent(lm);

  // переходы между этапами: в кадре ≥ 1 с — «на месте», нет в кадре ≥ 1.5 с — «у телефона»
  if (present) { S.goneSince = 0; S.seenSince ||= ts; } else { S.seenSince = 0; S.goneSince ||= ts; }
  if (S.phase === "phone" && present && ts - S.seenSince > 1000) { S.phase = "place"; S.okSince = 0; showPhase(); }
  if (S.phase === "place" && !present && ts - S.goneSince > 1500) { S.phase = "phone"; showPhase(); }

  if (S.phase === "phone") {
    renderList("suList", g.phoneItems, phone);
    const first = Object.values(phone).find(c => !c.ok);
    setHint(first ? first.hint : (S.fixes.length ? "Поправь штатив и иди на место" : "Телефон готов, иди на место"), !first);
    return;
  }

  // на месте
  if (!lm) { setHint("Не вижу тебя", false); return; }
  const place = S.mode === "bench" ? benchChecks(lm, S.height) : squatChecks(lm, S.height);
  const all = { ...phone, ...place };
  renderList("suList", [...g.phoneItems, ...g.placeItems], all);
  const failed = [...g.phoneItems, ...g.placeItems].map(([k]) => all[k]).filter(c => c && !c.ok);

  if (!failed.length) {
    setHint("Держи так…", true);
    S.okSince ||= ts;
    if (ts - S.okSince > 1500) {
      S.done = true; S.fixes = [];
      lockTarget();   // запомнили, кто ты — дальше остальных в кадре игнорируем
      say("Камера выставлена", { force: true });
      setTimeout(() => { const cb = S?.onDone; setupStop(); cb?.(); }, 600);
    }
    return;
  }
  S.okSince = 0;
  // поправки штатива запоминаем — покажем крупно, когда подойдёшь к телефону
  const fixes = failed.map(c => c.fix).filter(Boolean);
  S.fixes = [...new Set(fixes)].slice(0, 3);
  const first = failed.find(c => c.fix) || failed[0];   // голосом — сначала конкретную поправку
  const spoken = first.fix || first.hint;
  setHint(spoken, false);
  if (spoken) say(spoken, { repeatAfter: 7000 });
}

function setHint(t, ok) { const el = $("suHint"); el.textContent = t || ""; el.className = "su-hint " + (ok ? "ok" : "bad"); }
