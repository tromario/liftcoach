// Короткий сигнал — быстрее голоса, подходит для «глубина есть»
let ac = null, muted = false;
/** Без сигналов (разбор видео) */
export function muteBeep(on) { muted = on; }
export function unlockAudio() {
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch {}
}
export function beep(freq = 1100, ms = 120, vol = 0.35) {
  if (!ac || muted) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = freq; o.type = "sine";
  g.gain.setValueAtTime(vol, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + ms / 1000);
  o.connect(g).connect(ac.destination);
  o.start(); o.stop(ac.currentTime + ms / 1000 + 0.02);
}
