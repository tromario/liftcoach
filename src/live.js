// Режим «Живые углы» (этап 1): углы рабочей стороны в реальном времени
import { px, drawSkeleton } from "./pose.js";
import { angle, fromVertical, nearSide, sideIdx } from "./geom.js";
import { say } from "./voice.js";

const $ = id => document.getElementById(id);
let minKnee = Infinity, last = {};

export function liveFrame(res, lm) {
  if (!lm) { $("vis").textContent = "нет"; return; }
  const { side, quality } = nearSide(lm);
  const s = sideIdx(side);
  const q = Math.round(quality * 100);
  $("vis").textContent = q + "%";
  $("side").textContent = side === "L" ? "левая" : "правая";

  const sh = px(lm, s.sh), el = px(lm, s.el), wr = px(lm, s.wr), hip = px(lm, s.hip), kn = px(lm, s.kn), an = px(lm, s.an);
  last = { knee: angle(hip, kn, an), hip: angle(sh, hip, kn), torso: fromVertical(hip, sh), elbow: angle(sh, el, wr) };
  if (q > 60) minKnee = Math.min(minKnee, last.knee);

  $("aKnee").textContent = last.knee.toFixed(0) + "°";
  $("aHip").textContent = last.hip.toFixed(0) + "°";
  $("aTorso").textContent = last.torso.toFixed(0) + "°";
  $("aElbow").textContent = last.elbow.toFixed(0) + "°";
  $("aMin").textContent = isFinite(minKnee) ? minKnee.toFixed(0) + "°" : "–";
  drawSkeleton(lm, { highlight: Object.values(s) });
}

export function liveInit() {
  $("reset").onclick = () => { minKnee = Infinity; say("Сброшено", { force: true }); };
  $("speak").onclick = () => {
    if (!last.knee) return say("Не вижу тебя", { force: true });
    say(`Колено ${Math.round(last.knee)}, таз ${Math.round(last.hip)}, корпус ${Math.round(last.torso)} градусов`, { force: true });
  };
}
