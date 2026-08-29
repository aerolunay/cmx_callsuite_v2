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
a separate, local audio path the agent's browser plays privately,
never anything that reaches the customer or gets mixed into the
ConfBridge room at all.

REAL BUG FIX, confirmed live via a real headset test: a plain
AudioContext routed to ctx.destination let the browser pick its own
"default" output device — which, with a headset plugged in,
disagreed with whichever device the actual call audio (a separate
<audio> element, see PhoneContext.jsx's remoteAudioRef) was using.
The call was audible on the headset; this tone was not — the
JavaScript ran perfectly end to end (confirmed via console logging),
it just came out of a different physical device than the one being
listened to. Fixed by explicitly routing through an <audio> element
with setSinkId() pointed at the SAME device id the call audio is
using (passed in by the caller — see PhoneContext.jsx's
getOutputSinkId), rather than trusting two separate audio APIs to
resolve "default" the same way.

sinkId: the output device id to match (from
usePhone().getOutputSinkId()). Optional — if omitted, or if this
browser doesn't support setSinkId() at all (support is decent but not
universal), falls back to the plain ctx.destination behavior, which
is still correct for the common case of a single audio device.
*/
export function playConnectedBeep(sinkId = "") {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return; // very old browser — fail silently, not worth surfacing an error for a cosmetic tone

    const ctx = new AudioContextClass();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = 880; // a clear, pleasant A5 tone — noticeable without being jarring

    // Per explicit request — louder, and each beep at least 750ms
    // long. Ramp up/down (20ms each) rather than an abrupt on/off is
    // still needed even at this length — skipping it produces an
    // audible click at the start and end of each tone.
    const BEEP_DURATION = 0.75;
    const GAP = 0.15;
    const RAMP = 0.02;
    const VOLUME = 0.5;

    const t = ctx.currentTime;
    const beep1Start = t;
    const beep1End = beep1Start + BEEP_DURATION;
    const beep2Start = beep1End + GAP;
    const beep2End = beep2Start + BEEP_DURATION;

    gain.gain.setValueAtTime(0, beep1Start);
    gain.gain.linearRampToValueAtTime(VOLUME, beep1Start + RAMP);
    gain.gain.setValueAtTime(VOLUME, beep1End - RAMP);
    gain.gain.linearRampToValueAtTime(0, beep1End);

    gain.gain.setValueAtTime(0, beep2Start);
    gain.gain.linearRampToValueAtTime(VOLUME, beep2Start + RAMP);
    gain.gain.setValueAtTime(VOLUME, beep2End - RAMP);
    gain.gain.linearRampToValueAtTime(0.001, beep2End);

    oscillator.connect(gain);

    const canTargetDevice = sinkId && typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

    if (canTargetDevice) {
      // Route through a real <audio> element (which DOES support
      // setSinkId) instead of straight to ctx.destination, so this
      // tone explicitly follows the same device the call itself is
      // using.
      const destination = ctx.createMediaStreamDestination();
      gain.connect(destination);

      const audioEl = new Audio();
      audioEl.srcObject = destination.stream;
      audioEl
        .setSinkId(sinkId)
        .then(() => audioEl.play())
        .catch(() => {
          // Device targeting failed for some reason (e.g. the id is
          // stale) — fall back to playing through the default
          // device rather than staying silent.
          gain.connect(ctx.destination);
          audioEl.play().catch(() => {});
        });
    } else {
      gain.connect(ctx.destination);
    }

    oscillator.start();
    oscillator.stop(beep2End);
    oscillator.onended = () => ctx.close();
  } catch {
    // Never let a beep failure break the actual call-connected flow.
  }
}