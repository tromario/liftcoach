// Настройка ракурса перед подходом: чек-лист с живыми проверками и голосовой подсказкой.
// Высоту камеры оцениваем через горизонт: при ровном телефоне центр кадра = высота объектива.
import { px, drawSkeleton, video } from "./pose.js";
import { nearSide, sideIdx, dist, angle } from "./geom.js";
import { level } from "./level.js";
import { say } from "./voice.js";

const $ = id => document.getElementById(id);
const TOL = 3; // градусов для уровня
let S = null;

const GUIDE = {
  squat: {
    title: "Ракурс: присед",
    instr: "Штатив сбоку, строго перпендикулярно. Встань на место, где будешь приседать после отшагивания, боком к камере, руки как на грифе. Стойки не должны закрывать ноги и таз.",
    items: [
      ["level", "Телефон ровно"],
      ["side", "Строго сбоку"],
      ["visible", "Всё тело видно, стойки не мешают"],
      ["dist", "Расстояние"],
      ["center", "Запас места по краям"],
      ["height", "Высота камеры: между коленом и тазом"],
    ],
  },
  bench: {
    title: "Ракурс: жим",
    instr: "Телефон горизонтально, штатив сбоку от скамьи, чуть ближе к ногам, чтобы стойки не закрывали руку. Ляг и подними прямые руки вверх, как на вершине.",
    items: [
      ["landscape", "Телефон горизонтально"],
      ["level", "Телефон ровно"],
      ["pose", "Лёжа, руки вверх"],
      ["side", "Строго сбоку от скамьи"],
      ["visible", "Рука и таз видны, стойки не мешают"],
      ["dist", "Расстояние"],
      ["height", "Высота камеры: чуть выше скамьи"],
    ],
  },
};

function levelCheck() {
  if (!level.available) return { ok: true, hint: null };   // датчик недоступен — не блокируем
  if (Math.abs(level.pitch) > TOL) return { ok: false, hint: level.pitch > 0 ? "Наклони телефон верхом к себе" : "Наклони телефон верхом от себя" };
  if (Math.abs(level.roll) > TOL) return { ok: false, hint: "Выровняй телефон по горизонту" };
  return { ok: true };
}

function squatChecks(lm) {
  const r = {};
  r.level = levelCheck();
  if (!lm) return { ...r, side: { ok: false, hint: "Встань в кадр боком к камере" } };
  const { side } = nearSide(lm); const s = sideIdx(side); const P = i => px(lm, i);
  const vis = i => lm[i].visibility ?? 0;

  const shW = dist(P(11), P(12)), torso = dist(P(s.hip), P(s.sh));
  const shin = dist(P(s.kn), P(s.an)) || 1;
  const anDx = Math.abs(P(27).x - P(28).x);
  r.side = shW / torso < 0.35 && anDx / shin < 0.45
    ? { ok: true } : { ok: false, hint: "Поставь камеру строго сбоку, перпендикулярно" };

  const need = [s.sh, s.hip, s.kn, s.an, s.heel, s.toe];
  const inFrame = need.every(i => lm[i].x > 0.01 && lm[i].x < 0.99 && lm[i].y > 0.01 && lm[i].y < 0.99);
  r.visible = inFrame && need.every(i => vis(i) > 0.7)
    ? { ok: true }
    : { ok: false, hint: !inFrame ? "Не помещаешься, отодвинь камеру" : "Что-то закрывает ноги или таз, сдвинь камеру" };

  const eyeY = Math.min(lm[2].y, lm[5].y), floorY = Math.max(lm[s.heel].y, lm[s.toe].y);
  const size = floorY - eyeY;
  r.dist = size > 0.82 ? { ok: false, hint: "Отодвинь камеру на шаг" }
    : size < 0.5 ? { ok: false, hint: "Придвинь камеру ближе" } : { ok: true };

  // в приседе таз уходит назад, а плечи вперёд — по бокам нужен запас
  const hipX = lm[s.hip].x;
  r.center = hipX > 0.3 && hipX < 0.7 && eyeY > 0.04 && floorY < 0.96
    ? { ok: true } : { ok: false, hint: "Сдвинь камеру, чтобы ты был по центру кадра" };

  // центр кадра (горизонт) должен быть между коленом и тазом
  if (r.level.ok && level.available) {
    const kn = lm[s.kn].y, hip = lm[s.hip].y;
    // y растёт вниз: центр ниже колена — камера низко; центр выше таза — камера высоко
    r.height = 0.5 < kn + 0.03 && 0.5 > hip - 0.05 ? { ok: true }
      : 0.5 >= kn + 0.03 ? { ok: false, hint: "Подними камеру выше, до уровня между коленом и тазом" }
      : { ok: false, hint: "Опусти камеру ниже, до уровня между коленом и тазом" };
  } else r.height = { ok: level.available ? false : true, hint: level.available ? "Сначала выровняй телефон" : null };
  return r;
}

function benchChecks(lm) {
  const r = {};
  r.landscape = video.videoWidth > video.videoHeight ? { ok: true } : { ok: false, hint: "Поверни телефон горизонтально" };
  r.level = levelCheck();
  if (!lm) return { ...r, pose: { ok: false, hint: "Ляг на скамью и подними руки" } };
  const { side } = nearSide(lm); const s = sideIdx(side); const P = i => px(lm, i);
  const vis = i => lm[i].visibility ?? 0;
  const sh = P(s.sh), el = P(s.el), wr = P(s.wr), hip = P(s.hip);
  const torso = dist(sh, hip) || 1;

  const lying = Math.abs(Math.atan2(hip.y - sh.y, Math.abs(hip.x - sh.x))) * 180 / Math.PI < 25;
  const armsUp = angle(sh, el, wr) > 150 && wr.y < sh.y - torso * 0.6;
  r.pose = lying && armsUp ? { ok: true } : { ok: false, hint: lying ? "Подними прямые руки вверх, как на вершине" : "Ляг на скамью" };

  const shDx = Math.abs(P(11).x - P(12).x), hipDx = Math.abs(P(23).x - P(24).x);
  r.side = (shDx + hipDx) / 2 / torso < 0.2 ? { ok: true }
    : { ok: false, hint: "Поставь камеру строго перпендикулярно скамье" };

  const need = [s.sh, s.el, s.wr, s.hip];
  const inFrame = need.every(i => lm[i].x > 0.02 && lm[i].x < 0.98 && lm[i].y > 0.04 && lm[i].y < 0.98);
  r.visible = inFrame && need.every(i => vis(i) > 0.7) ? { ok: true }
    : { ok: false, hint: !inFrame ? "Руки не помещаются, отодвинь или опусти камеру" : "Стойки закрывают руку, сдвинь камеру к ногам" };

  const frac = torso / video.videoWidth;
  r.dist = frac > 0.42 ? { ok: false, hint: "Отодвинь камеру" } : frac < 0.18 ? { ok: false, hint: "Придвинь камеру ближе" } : { ok: true };

  // горизонт чуть выше корпуса: плечо в нижней половине кадра, но не у края
  if (r.level.ok && level.available) {
    const y = lm[s.sh].y;
    r.height = y >= 0.55 && y <= 0.85 ? { ok: true }
      : y < 0.55 ? { ok: false, hint: "Подними камеру чуть выше скамьи" } : { ok: false, hint: "Опусти камеру ниже" };
  } else r.height = { ok: level.available ? false : true, hint: level.available ? "Сначала выровняй телефон" : null };
  return r;
}

export function setupStart(mode, onDone) {
  const g = GUIDE[mode];
  S = { mode, onDone, okSince: 0, done: false };
  $("suTitle").textContent = g.title;
  $("suInstr").textContent = g.instr;
  $("suList").innerHTML = g.items.map(([id, label]) => `<li id="su-${id}"><span class="dot"></span>${label}</li>`).join("");
  $("setup").hidden = false;
  say(mode === "bench" ? "Выставим камеру. Ляг на скамью и подними руки" : "Выставим камеру. Встань боком на место подхода", { force: true });
}

export function setupStop() { $("setup").hidden = true; S = null; }

export function setupFrame(res, lm, ts) {
  if (!S || S.done) return;
  if (lm) drawSkeleton(lm, { highlight: Object.values(sideIdx(nearSide(lm).side)) });
  const r = S.mode === "bench" ? benchChecks(lm) : squatChecks(lm);
  const items = GUIDE[S.mode].items;
  let firstHint = null, allOk = true;
  for (const [id] of items) {
    const c = r[id] ?? { ok: false };
    const li = $("su-" + id);
    if (li) li.className = c.ok ? "ok" : "bad";
    if (!c.ok) { allOk = false; if (!firstHint && c.hint) firstHint = c.hint; }
  }
  $("suHint").textContent = allOk ? "Держи так…" : (firstHint || "");
  $("suHint").className = "su-hint " + (allOk ? "ok" : "bad");

  if (!allOk) { S.okSince = 0; if (firstHint) say(firstHint, { repeatAfter: 5000 }); return; }
  S.okSince ||= ts;
  if (ts - S.okSince > 1500) {
    S.done = true;
    say("Камера выставлена", { force: true });
    setTimeout(() => { const cb = S?.onDone; setupStop(); cb?.(); }, 600);
  }
}
