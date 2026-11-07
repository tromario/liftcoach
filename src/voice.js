// Голос: русская озвучка + защита от «спама» одной и той же фразой
let ruVoice = null;
const pick = () => { ruVoice = speechSynthesis.getVoices().find(v => v.lang.startsWith("ru")) || null; };
speechSynthesis.onvoiceschanged = pick; pick();

let lastText = "", lastAt = 0;

export function say(text, { force = false, repeatAfter = 4000 } = {}) {
  const now = performance.now();
  if (!force && text === lastText && now - lastAt < repeatAfter) return;
  if (!force && speechSynthesis.speaking && now - lastAt < 1200) return; // не обрываем только что начатую фразу
  lastText = text; lastAt = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ru-RU"; if (ruVoice) u.voice = ruVoice; u.rate = 1.1;
  speechSynthesis.speak(u);
}

/** iOS разрешает речь только из обработчика нажатия — вызвать один раз при старте */
export function unlockVoice() { say("Поехали", { force: true }); }
