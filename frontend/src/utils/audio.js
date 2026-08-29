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
    if (!AudioContextClass) {
      console.warn("[playConnectedBeep] No AudioContext support in this browser.");
      return;
    }

    const ctx = new AudioContextClass();
    console.log("[playConnectedBeep] AudioContext created, state:", ctx.state);
    if (ctx.state === "suspended") {
      ctx.resume().then(
        () => console.log("[playConnectedBeep] context resumed, new state:", ctx.state),
        (err) => console.warn("[playConnectedBeep] resume() rejected:", err)
      );
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
    console.log("[playConnectedBeep] oscillator started.");
  } catch (err) {
    // TEMPORARY — normally never let a beep failure break the actual
    // call-connected flow, but logging this while diagnosing why no
    // sound is heard despite the code confirmed present and running.
    console.error("[playConnectedBeep] threw:", err);
  }
}