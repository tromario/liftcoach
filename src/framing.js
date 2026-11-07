// Проверка, что ты правильно в кадре для съёмки сбоку
import { CFG } from "./config.js";
import { nearSide, sideIdx, dist } from "./geom.js";
import { levelHint } from "./level.js";
import { px } from "./pose.js";

export function checkSide(lm) {
  if (!lm) return { ok: false, hint: "Не вижу тебя. Встань в кадр целиком" };
  const lv = levelHint();
  if (lv) return { ok: false, hint: lv };

  const { side } = nearSide(lm);
  const s = sideIdx(side);
  const need = [s.sh, s.hip, s.kn, s.an, s.heel, s.toe];
  const vis = i => lm[i].visibility ?? 0;

  const out = need.some(i => lm[i].y > 0.99 || lm[i].y < 0.01 || lm[i].x < 0.01 || lm[i].x > 0.99);
  if (out || lm[2].y < 0.01) return { ok: false, hint: "Не помещаешься в кадр, отойди дальше", side };
  if (need.some(i => vis(i) < CFG.minVis)) {
    const feet = [s.an, s.heel, s.toe].some(i => vis(i) < CFG.minVis);
    return { ok: false, hint: feet ? "Не вижу стопы целиком" : "Плохо вижу тело, проверь свет и ракурс", side };
  }

  const eyeY = Math.min(lm[2].y, lm[5].y);
  const floorY = Math.max(lm[s.heel].y, lm[s.toe].y);
  const size = floorY - eyeY;
  if (size > CFG.sizeMax) return { ok: false, hint: "Отойди на шаг дальше", side };
  if (size < CFG.sizeMin) return { ok: false, hint: "Подойди ближе к камере", side };

  const shW = dist(px(lm, 11), px(lm, 12));
  const torso = dist(px(lm, s.hip), px(lm, s.sh));
  if (shW / torso > CFG.sideMaxRatio) return { ok: false, hint: "Встань боком к камере", side };

  return { ok: true, hint: null, side };
}
