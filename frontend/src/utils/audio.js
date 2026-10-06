// Shared by playConnectedBeep and playDtmfTone — sends `node` to the
// output device the call audio is actually using (see the REAL BUG FIX
// note on playConnectedBeep for why plain ctx.destination isn't enough
// with a headset plugged in).
function connectToOutput(ctx, node, sinkId) {
  const canTargetDevice = sinkId && typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  if (canTargetDevice) {
    // Route through a real <audio> element (which DOES support
    // setSinkId) instead of straight to ctx.destination, so this
    // tone explicitly follows the same device the call itself is
    // using.
    const destination = ctx.createMediaStreamDestination();
    node.connect(destination);

    const audioEl = new Audio();
    audioEl.srcObject = destination.stream;
    audioEl
      .setSinkId(sinkId)
      .then(() => audioEl.play())
      .catch(() => {
        // Device targeting failed for some reason (e.g. the id is
        // stale) — fall back to playing through the default
        // device rather than staying silent.
        node.connect(ctx.destination);
        audioEl.play().catch(() => {});
      });
  } else {
    node.connect(ctx.destination);
  }
}

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

    // Per explicit request — one single beep, 750ms, louder than the
    // original. Ramp up/down (20ms each) rather than an abrupt on/off
    // is still needed even at this length — skipping it produces an
    // audible click at the start and end of the tone.
    const BEEP_DURATION = 0.75;
    const RAMP = 0.02;
    const VOLUME = 0.5;

    const t = ctx.currentTime;
    const beepEnd = t + BEEP_DURATION;

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(VOLUME, t + RAMP);
    gain.gain.setValueAtTime(VOLUME, beepEnd - RAMP);
    gain.gain.linearRampToValueAtTime(0.001, beepEnd);

    oscillator.connect(gain);

    connectToOutput(ctx, gain, sinkId);

    oscillator.start();
    oscillator.stop(beepEnd);
    oscillator.onended = () => ctx.close();
  } catch {
    // Never let a beep failure break the actual call-connected flow.
  }
}

/*
==================================================
playDtmfTone
==================================================
Local-only feedback for the in-call keypad — the real tone is played
into the customer's leg by Asterisk (see dialerService.sendDtmf), which
the agent doesn't hear back through the ConfBridge room. Standard DTMF
row/column frequency pair, short and quiet, so the agent gets the
familiar "key pressed" sound. Never reaches the customer.
*/
const DTMF_FREQUENCIES = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  "*": [941, 1209], 0: [941, 1336], "#": [941, 1477],
};

export function playDtmfTone(digit, sinkId = "") {
  const pair = DTMF_FREQUENCIES[digit];
  if (!pair) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const TONE_DURATION = 0.15;
    const RAMP = 0.01;
    const VOLUME = 0.15;
    const t = ctx.currentTime;
    const toneEnd = t + TONE_DURATION;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(VOLUME, t + RAMP);
    gain.gain.setValueAtTime(VOLUME, toneEnd - RAMP);
    gain.gain.linearRampToValueAtTime(0.001, toneEnd);

    const oscillators = pair.map((frequency) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      return oscillator;
    });

    connectToOutput(ctx, gain, sinkId);

    oscillators.forEach((oscillator) => {
      oscillator.start();
      oscillator.stop(toneEnd);
    });
    oscillators[0].onended = () => ctx.close();
  } catch {
    // Cosmetic only — never let it interfere with the call.
  }
}
