// Голос: одна очередь, без перебиваний.
//  - force: важные фразы (сигналы в повторе, итог подхода, «Запись») — говорятся сразу
//  - persist: фраза звучит, только если её «просят» непрерывно столько мс (проблема держится, а не мелькнула)
//  - repeatAfter: одна и та же фраза — не чаще
//  - начатую фразу обычные подсказки не обрывают; между фразами минимум 1.5 с
//  - quiet(ms): помолчать (например, первые секунды после старта режима)
let ruVoice = null;
const pick = () => { ruVoice = speechSynthesis.getVoices().find(v => v.lang.startsWith("ru")) || null; };
speechSynthesis.onvoiceschanged = pick; pick();

const spokenAt = new Map();     // фраза → когда звучала
const pending = new Map();      // фраза → { first, last } для persist
let lastAny = 0, quietUntil = 0;
const MIN_GAP = 1500;

function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ru-RU"; if (ruVoice) u.voice = ruVoice; u.rate = 1.1;
  speechSynthesis.speak(u);
}

export function say(text, { force = false, repeatAfter = 7000, persist = 0 } = {}) {
  if (!text) return;
  const now = performance.now();
  if (force) {
    speechSynthesis.cancel(); speak(text);
    spokenAt.set(text, now); lastAny = now; pending.delete(text);
    return;
  }
  if (now < quietUntil) return;
  if (persist) {
    const p = pending.get(text);
    if (!p || now - p.last > 700) { pending.set(text, { first: now, last: now }); return; }
    p.last = now;
    if (now - p.first < persist) return;
  }
  if (now - (spokenAt.get(text) ?? -1e9) < repeatAfter) return;
  if (speechSynthesis.speaking || speechSynthesis.pending || now - lastAny < MIN_GAP) return;
  speak(text);
  spokenAt.set(text, now); lastAny = now; pending.delete(text);
}

/** Помолчать ms миллисекунд (обычные подсказки не звучат, force — звучит) */
export function quiet(ms) { quietUntil = performance.now() + ms; }

/** iOS разрешает речь только из обработчика нажатия — вызвать при старте (беззвучно) */
export function unlockVoice() {
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0; speechSynthesis.speak(u);
}
