/*
==================================================
playConnectedBeep
==================================================
Per explicit request — a short, agent-only notification tone the
moment an incoming call actually connects. Synthesized directly via
the Web Audio API (a brief oscillator tone) rather than shipping and
loading an actual audio file — simpler, no extra asset, no network
request, and no risk of a missing/broken file.

Deliberately does NOT touch the call's own audio in any way — this is
a separate, local AudioContext the agent's browser plays privately,
never anything that reaches the customer or gets mixed into the
ConfBridge room at all.
*/
export function playConnectedBeep() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return; // very old browser — fail silently, not worth surfacing an error for a cosmetic tone

    const ctx = new AudioContextClass();
    if (ctx.state === "suspended") {
      // Harmless no-op if already running — only matters if this
      // browser started the context suspended, pending some prior
      // user gesture elsewhere on the page (logging in, going Ready,
      // etc. almost certainly already satisfied this by the time a
      // call connects, but cheap to cover regardless).
      ctx.resume().catch(() => {});
    }

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = 880; // a clear, pleasant A5 tone — noticeable without being jarring
    gain.gain.setValueAtTime(0.15, ctx.currentTime); // kept quiet — this is a notification, not an alarm
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.18);
    oscillator.onended = () => ctx.close();
  } catch {
    // Never let a beep failure break the actual call-connected flow.
  }
}
