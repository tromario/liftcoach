// Пропорции тела: копятся автоматически, пока ты стоишь боком к камере.
// Хранятся на телефоне, берётся медиана по последним замерам.
import { CFG } from "./config.js";
import { median, mean, sideIdx, dist } from "./geom.js";
import { px } from "./pose.js";

const KEY = "lc.profile.v1";
const FIELDS = ["thigh", "shin", "torso", "upperArm", "forearm"];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { samples: [], leans: [] }; }
  catch { return { samples: [], leans: [] }; }
}
let data = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };

/** Медианные пропорции, см. null — если замеров ещё нет */
export function proportions() {
  if (!data.samples.length) return null;
  const p = { n: data.samples.length };
  for (const f of FIELDS) p[f] = median(data.samples.map(s => s[f]));
  return p;
}

export function addSample(s) {
  data.samples.push({ ...s, date: Date.now() });
  data.samples = data.samples.slice(-30);
  save();
}

/** Наклон корпуса в низу засчитанных повторов — из них «твой обычный» наклон */
export function addLean(deg) { data.leans.push(Math.round(deg * 10) / 10); data.leans = data.leans.slice(-100); save(); }
export function baselineLean() { return data.leans.length >= CFG.baselineMinReps ? median(data.leans) : null; }

export function resetProfile() { data = { samples: [], leans: [] }; save(); }
export function exportProfile() { return JSON.parse(JSON.stringify(data)); }

/** Масштаб см/пикс по стоящему человеку: от глаз до пола = 0.936 роста */
export function scaleFromStanding(lm, height, side) {
  const s = sideIdx(side);
  const eyeY = Math.min(px(lm, 2).y, px(lm, 5).y);
  const floorY = Math.max(px(lm, s.heel).y, px(lm, s.toe).y);
  const h = floorY - eyeY;
  return h > 50 ? height * CFG.eyeHeightRatio / h : NaN;
}

/** Длины сегментов видимой стороны, см */
export function segmentsCm(lm, side, k) {
  const s = sideIdx(side), P = i => px(lm, i);
  return {
    thigh: dist(P(s.hip), P(s.kn)) * k,
    shin: dist(P(s.kn), P(s.an)) * k,
    torso: dist(P(s.hip), P(s.sh)) * k,
    upperArm: dist(P(s.sh), P(s.el)) * k,
    forearm: dist(P(s.el), P(s.wr)) * k,
  };
}

/** Сборщик замера: копит кадры, по 30 кадрам отдаёт медиану */
export function makeCalibrator(onDone) {
  let buf = [];
  return {
    push(seg) {
      buf.push(seg);
      if (buf.length >= 30) {
        const s = {}; for (const f of FIELDS) s[f] = median(buf.map(b => b[f]));
        buf = []; onDone(s);
      }
    },
    reset() { buf = []; },
    get progress() { return buf.length / 30; },
  };
}

/**
 * Ориентир наклона корпуса в приседе с низким грифом на параллели:
 * гриф над серединой стопы, голень ~18° от вертикали, бёдра разведены ~30°.
 * Это модель, а не норматив — после 10 повторов её заменит твой реальный наклон.
 */
export function modelLean(p, height) {
  if (!p) return null;
  const rad = Math.PI / 180;
  const f = p.thigh * Math.cos(30 * rad);   // бедро в проекции сбоку
  const kneeX = p.shin * Math.sin(18 * rad);
  const mid = 0.036 * height;               // середина стопы впереди голеностопа
  const t = p.torso - 4;                    // гриф чуть ниже плечевого сустава
  const sin = (mid - kneeX + f) / t;
  return sin >= 1 ? 80 : Math.asin(sin) / rad;
}

export { FIELDS, mean };
