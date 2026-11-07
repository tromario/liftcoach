// Уровень телефона по акселерометру: наклон вперёд/назад (pitch) и крен (roll).
// Работает в любой ориентации: крен считается до ближайшей оси экрана.
export const level = { available: false, pitch: NaN, roll: NaN };

let g = null;

/** Должна вызываться синхронно в обработчике нажатия (требование iOS) */
export function requestLevel() {
  const attach = () => {
    window.addEventListener("devicemotion", e => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      // сглаживание
      g = g ? { x: g.x * 0.8 + a.x * 0.2, y: g.y * 0.8 + a.y * 0.2, z: g.z * 0.8 + a.z * 0.2 } : { x: a.x, y: a.y, z: a.z };
      const n = Math.hypot(g.x, g.y, g.z) || 1;
      level.pitch = Math.asin(Math.max(-1, Math.min(1, g.z / n))) * 180 / Math.PI;
      const r = Math.atan2(g.x, g.y) * 180 / Math.PI;      // направление гравитации в плоскости экрана
      const d = ((r % 90) + 90) % 90;                        // отклонение от ближайшей оси
      level.roll = d > 45 ? 90 - d : -d;
      level.available = true;
    });
  };
  const DM = window.DeviceMotionEvent;
  if (DM && typeof DM.requestPermission === "function") {
    return DM.requestPermission().then(s => { if (s === "granted") attach(); return s; }).catch(() => "denied");
  }
  attach();
  return Promise.resolve("granted");
}

export const LEVEL_TOL = 4; // градусов

export function levelHint() {
  if (!level.available) return null;
  if (Math.abs(level.pitch) > LEVEL_TOL)
    return level.pitch > 0 ? "Наклони телефон верхом к себе" : "Наклони телефон верхом от себя";
  if (Math.abs(level.roll) > LEVEL_TOL) return "Выровняй телефон по горизонту";
  return null;
}
