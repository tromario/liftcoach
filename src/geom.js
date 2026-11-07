// Геометрия в пикселях кадра (не в нормализованных координатах — иначе искажаются углы)
export const LM = {
  nose:0, lEye:2, rEye:5, lSh:11, rSh:12, lEl:13, rEl:14, lWr:15, rWr:16,
  lHip:23, rHip:24, lKn:25, rKn:26, lAn:27, rAn:28, lHeel:29, rHeel:30, lToe:31, rToe:32,
};

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) });

/** Угол в точке b (градусы) */
export function angle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

/** Отклонение отрезка bottom→top от вертикали (градусы) */
export const fromVertical = (bottom, top) =>
  Math.abs(Math.atan2(top.x - bottom.x, bottom.y - top.y)) * 180 / Math.PI;

export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export const mean = arr => { const a = arr.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; };

/** Какая сторона тела лучше видна камере */
export function nearSide(lm) {
  const v = i => lm[i].visibility ?? 0;
  const L = [11, 13, 15, 23, 25, 27].reduce((s, i) => s + v(i), 0);
  const R = [12, 14, 16, 24, 26, 28].reduce((s, i) => s + v(i), 0);
  return { side: L >= R ? "L" : "R", quality: Math.max(L, R) / 6 };
}

export function sideIdx(side) {
  return side === "L"
    ? { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, heel: 29, toe: 31 }
    : { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, heel: 30, toe: 32 };
}
