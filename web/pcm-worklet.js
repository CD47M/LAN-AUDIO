/* AudioWorklets for LAN Audio
 *
 * pcm-sender  : captures mixed input at 48 kHz and posts 20 ms stereo blocks
 * pcm-mixer   : resamples every phone stream, keeps one jitter buffer per phone
 *               and sums them into a single stereo output
 * pcm-monitor : local PC microphone monitoring with optional noise gate
 *
 * This file deliberately keeps the mixer simple.  An earlier version added a
 * per-phone downward expander and a soft limiter inside the mixer; both
 * modulated the waveform on every sample and were audible as a low hum.
 * Volume is now plain linear gain, exactly like the original working build.
 */

class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.max(1, Math.round(sampleRate * 0.02));
    this.chunkL = new Float32Array(this.frameSize);
    this.chunkR = new Float32Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const left = input[0];
    const right = input.length > 1 && input[1] ? input[1] : input[0];
    let i = 0;

    while (i < left.length) {
      const n = Math.min(left.length - i, this.frameSize - this.offset);
      this.chunkL.set(left.subarray(i, i + n), this.offset);
      this.chunkR.set(right.subarray(i, i + n), this.offset);
      this.offset += n;
      i += n;

      if (this.offset >= this.frameSize) {
        const outL = this.chunkL;
        const outR = this.chunkR;
        this.port.postMessage({ l: outL, r: outR }, [outL.buffer, outR.buffer]);
        this.chunkL = new Float32Array(this.frameSize);
        this.chunkR = new Float32Array(this.frameSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

/* Linear limiter used only to stop hard digital clipping when several phones
 * are summed.  Unlike the old soft-knee curve it is transparent below 1.0,
 * so a single phone at normal volume is never altered. */
function hardClip(x) {
  return x > 1 ? 1 : (x < -1 ? -1 : x);
}

/* Microphone noise reduction for phone mic streams.
 * Gated by strength 0..100; only ever applied to "#mic" streams. */
class MicNoiseFilter {
  constructor() {
    this.strength = 0;
    this.hpA = Math.exp((-2 * Math.PI * 85) / sampleRate);
    this.reset();
  }

  setStrength(value) {
    this.strength = Math.max(0, Math.min(100, Number(value) || 0));
  }

  reset() {
    this.hpX = 0;
    this.hpY = 0;
    this.hpX2 = 0;
    this.hpY2 = 0;
    this.env = 0;
    this.floor = 0;
    this.gate = 1;
  }

  process(l, r) {
    if (this.strength <= 0) return [l, r];
    const level = this.strength / 100;
    const a = this.hpA;
    this.hpY = a * (this.hpY + l - this.hpX);
    this.hpX = l;
    this.hpY2 = a * (this.hpY2 + r - this.hpX2);
    this.hpX2 = r;

    const peak = Math.max(Math.abs(this.hpY), Math.abs(this.hpY2));
    this.env += (peak - this.env) * (peak > this.env ? 0.15 : 0.0025);
    if (this.floor <= 0) this.floor = Math.max(1e-5, this.env);
    else this.floor += (this.env - this.floor) * (this.env < this.floor ? 0.004 : 0.00003);

    const threshold = Math.max(0.0015, this.floor * 3.5) + level * 0.0015;
    const open = this.env > threshold;
    // Shallow closure only: deep gating on a continuous stream reads as hum.
    const closed = 1 - level * 0.6;
    const target = open ? 1 : closed;
    this.gate += (target - this.gate) * (open ? 0.08 : 0.02);
    return [this.hpY * this.gate, this.hpY2 * this.gate];
  }
}

class PhoneStream {
  constructor(sampleRate) {
    this.cap = Math.round(sampleRate * 2);
    this.bufL = new Float32Array(this.cap);
    this.bufR = new Float32Array(this.cap);
    this.readPos = 0;
    this.writePos = 0;
    this.count = 0;
    this.readFrac = 0;
    this.step = 1;
    this.playing = false;
    this.lastUnderrunBlock = 0;
    this.underruns = 0;
    this.dropped = 0;
    this.peak = 0;
    this.prevL = 0;
    this.prevR = 0;
    this.prevRate = 0;
    this.gain = 1;
    this.mainGain = 1;
    this.micGain = 1;
    this.hasCfgGain = false;   // explicit slider value wins over frame gain
    this.mic = false;
    this.phoneId = 'default';
    this.pan = 0;
    this.panL = 1;
    this.panR = 1;
    this.baseTarget = 0;
    this.extra = 0;
    this.targetSamples = 0;
    this.effTarget = 0;
    this.idleFrames = 0;
    this.dead = false;
    this.lastPushBlock = 0;
    this.pushed = 0;
    this.lastOutL = 0;
    this.lastOutR = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.shortUnderruns = 0;
    this.nr = 0;
    this.nrFilter = new MicNoiseFilter();
    this.nrActive = false;
    this.fadeLeft = 0;
    this.fadeTotal = 0;
    this.started = false;
    this.lastReceiveBlock = 0;
    // Block-level expander state for the per-phone boost.
    this.env = 0;
    this.peakRef = 0;
    this.boostEnv = 1;
  }
}

class PcmMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.streams = new Map();
    this.phoneCfg = new Map();
    this.defaultTarget = Math.round(sampleRate * 0.09);
    this.maxTargetSamples = Math.round(sampleRate * 0.55);
    this.maxBufferSamples = Math.round(sampleRate * 0.75);
    this.maxExtra = Math.round(sampleRate * 0.08);
    this.extraStep = Math.round(sampleRate * 0.02);
    // ~25 blocks (about 66 ms) of sustained starvation before a real rebuffer.
    this.maxShortUnderruns = 25;
    this.balance = true;
    this.blocks = 0;
    this.lastReport = 0;
    this.outPeak = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;

      if (msg.type === 'config' && Number.isFinite(msg.bufferMs)) {
        this.defaultTarget = this.msToSamples(msg.bufferMs);
        for (const s of this.streams.values()) {
          const cfg = this.phoneCfg.get(s.phoneId) || {};
          if (!Number.isFinite(cfg.bufferMs)) s.baseTarget = this.defaultTarget;
        }
        this.retargetAll();
        return;
      }
      if (msg.type === 'balance' || msg.type === 'sync-mic') {
        this.balance = msg.enabled !== false;
        this.retargetAll();
        return;
      }
      if (msg.type === 'set-phone') {
        this.updatePhoneCfg(msg);
        return;
      }
      if (msg.type === 'set-gain' && msg.id != null) {
        // Legacy path: treat as the main gain.
        const s = this.streams.get(String(msg.id));
        if (s) {
          s.mainGain = Number.isFinite(msg.gain) ? Math.max(0, Math.min(3, msg.gain)) : 1;
          s.hasCfgGain = true;
          this.applyStreamConfig(s);
        }
        return;
      }
      if (msg.type === 'remove' && msg.id != null) {
        this.streams.delete(String(msg.id));
        return;
      }
      if (msg.type === 'flush') {
        this.streams.clear();
        return;
      }
      if (msg.pcm) this.receive(msg);
    };
  }

  msToSamples(ms) {
    const clamped = Math.max(20, Math.min(400, ms));
    return Math.round((sampleRate * clamped) / 1000);
  }

  updatePhoneCfg(msg) {
    const pid = String(msg.id == null ? 'default' : msg.id);
    const cfg = this.phoneCfg.get(pid) || {};
    if (Number.isFinite(msg.gain)) cfg.gain = Math.max(0, Math.min(3, msg.gain));
    if (Number.isFinite(msg.micGain)) cfg.micGain = Math.max(0, Math.min(5, msg.micGain));
    if (Number.isFinite(msg.nr)) cfg.nr = Math.max(0, Math.min(100, msg.nr));
    if (Number.isFinite(msg.pan)) cfg.pan = Math.max(-1, Math.min(1, msg.pan));
    if (Number.isFinite(msg.bufferMs)) cfg.bufferMs = Math.max(20, Math.min(400, msg.bufferMs));
    if (Number.isFinite(msg.catchup)) cfg.catchup = Math.max(0, Math.min(100, msg.catchup));
    this.phoneCfg.set(pid, cfg);

    for (const s of this.streams.values()) {
      if (s.phoneId === pid) this.applyStreamConfig(s);
    }
    this.retargetAll();
  }

  applyStreamConfig(s) {
    const cfg = this.phoneCfg.get(s.phoneId) || {};
    const hasGain = Number.isFinite(cfg.gain);
    if (hasGain) s.hasCfgGain = true;
    const main = hasGain ? cfg.gain : s.mainGain;
    const micGain = Number.isFinite(cfg.micGain) ? cfg.micGain : s.micGain;
    const pan = Number.isFinite(cfg.pan) ? cfg.pan : s.pan;

    s.mainGain = main;
    s.micGain = micGain;
    s.gain = main * (s.mic ? micGain : 1);
    s.pan = pan;
    s.nr = s.mic && Number.isFinite(cfg.nr) ? cfg.nr : 0;
    s.nrFilter.setStrength(s.nr);
    const nrActive = s.nr > 0;
    if (s.nrActive !== nrActive) {
      s.nrActive = nrActive;
      s.nrFilter.reset();
    }
    const p = s.mic ? pan : 0;
    s.panL = 1 - Math.max(0, p);
    s.panR = 1 + Math.min(0, p);

    s.baseTarget = Number.isFinite(cfg.bufferMs)
      ? this.msToSamples(cfg.bufferMs)
      : this.defaultTarget;
    s.catchup = Number.isFinite(cfg.catchup) ? cfg.catchup : 25;
  }

  computeNeed() {
    let need = 0;
    let active = 0;
    for (const s of this.streams.values()) {
      if (!(s.playing || s.count > 0)) continue;
      active++;
      const own = Math.min(this.maxTargetSamples, s.baseTarget + s.extra);
      if (own > need) need = own;
    }
    return { need, active };
  }

  targetFor(s, need) {
    const own = Math.min(this.maxTargetSamples, s.baseTarget + s.extra);
    if (this.balance && need > own) return Math.min(this.maxTargetSamples, need);
    return own;
  }

  retargetAll() {
    const { need } = this.computeNeed();
    const tol = Math.round(sampleRate * 0.01);

    for (const s of this.streams.values()) {
      const next = this.targetFor(s, need);
      const prev = s.effTarget || 0;
      if (next > prev + tol && s.playing && s.count < next) s.playing = false;
      s.effTarget = next;
      s.targetSamples = next;
    }
  }

  streamFor(id) {
    let s = this.streams.get(id);
    if (s) return s;

    s = new PhoneStream(sampleRate);
    s.id = id;
    s.mic = id.endsWith('#mic');
    s.phoneId = s.mic ? id.slice(0, -4) : id;
    s.mainGain = 1;
    s.micGain = 1;
    s.gain = 1;
    s.baseTarget = this.defaultTarget;
    s.extra = 0;
    this.streams.set(id, s);
    this.applyStreamConfig(s);
    const target = Math.min(this.maxTargetSamples, s.baseTarget);
    s.targetSamples = target;
    s.effTarget = target;
    return s;
  }

  receive(msg) {
    const id = msg.id == null ? 'default' : String(msg.id);
    const s = this.streamFor(id);

    // The per-frame gain is only a fallback.  Once the volume slider sent an
    // explicit "set-phone", that value must win, otherwise every frame would
    // undo the slider (this was why the sliders appeared dead).
    if (Number.isFinite(msg.gain) && !s.hasCfgGain) {
      const g = Math.max(0, Math.min(3, msg.gain));
      if (g !== s.mainGain) {
        s.mainGain = g;
        s.gain = s.mainGain * (s.mic ? s.micGain : 1);
      }
    }

    s.idleFrames = 0;
    s.dead = false;
    const gap = s.lastReceiveBlock > 0 ? this.blocks - s.lastReceiveBlock : 0;
    s.lastReceiveBlock = this.blocks;
    s.lastPushBlock = this.blocks;
    // A long silence gap leaves stale samples in the ring buffer.
    if (s.started && gap > Math.round(sampleRate * 0.25)) this.resetBuffer(s);
    this.receivePcm(s, msg.pcm, msg.rate || 48000, msg.channels || 1);
  }

  /** Drop buffered audio and restart cleanly. */
  resetBuffer(s) {
    s.count = 0;
    s.readPos = 0;
    s.writePos = 0;
    s.readFrac = 0;
    s.step = 1;
    s.playing = false;
    s.prevL = 0;
    s.prevR = 0;
    s.nrFilter.reset();
    s.lastOutL = 0;
    s.lastOutR = 0;
    s.holdL = 0;
    s.holdR = 0;
    s.shortUnderruns = 0;
    s.fadeLeft = 0;
    s.env = 0;
    s.peakRef = 0;
    s.boostEnv = 1;
  }

  receivePcm(s, pcm, rate, channels) {
    const n = pcm.length / channels;
    if (!Number.isInteger(n) || n <= 0) return;

    if (rate !== s.prevRate) {
      s.prevRate = rate;
      s.prevL = 0;
      s.prevR = 0;
      s.nrFilter.reset();
    }

    const ratio = sampleRate / rate;

    for (let i = 0; i < n; i++) {
      let l;
      let r;
      if (channels === 1) {
        l = r = pcm[i] / 32768;
      } else {
        l = pcm[i * channels] / 32768;
        r = pcm[i * channels + 1] / 32768;
      }

      if (s.mic && s.nr > 0) {
        const filtered = s.nrFilter.process(l, r);
        l = filtered[0];
        r = filtered[1];
      }

      if (ratio === 1) {
        this.push(s, l, r);
      } else if (ratio === 2) {
        this.push(s, (s.prevL + l) / 2, (s.prevR + r) / 2);
        this.push(s, l, r);
      } else if (ratio === 3) {
        this.push(s, s.prevL + (l - s.prevL) / 3, s.prevR + (r - s.prevR) / 3);
        this.push(s, s.prevL + ((l - s.prevL) * 2) / 3, s.prevR + ((r - s.prevR) * 2) / 3);
        this.push(s, l, r);
      } else {
        const step = 1 / ratio;
        for (let f = 0; f < 1; f += step) {
          this.push(s, s.prevL + (l - s.prevL) * f, s.prevR + (r - s.prevR) * f);
        }
      }
      s.prevL = l;
      s.prevR = r;
    }
  }

  push(s, l, r) {
    if (s.count >= s.cap) {
      s.readPos = (s.readPos + 1) % s.cap;
      s.count--;
      s.dropped++;
    }
    s.bufL[s.writePos] = l;
    s.bufR[s.writePos] = r;
    s.writePos = (s.writePos + 1) % s.cap;
    s.count++;
    s.pushed++;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    if (!left) return true;

    left.fill(0);
    if (right !== left) right.fill(0);

    const { need } = this.computeNeed();

    for (const [id, s] of this.streams) {
      const target = this.targetFor(s, need);
      s.targetSamples = target;
      s.effTarget = target;

      const deficit = Math.round(sampleRate * 0.04);
      if (s.playing && s.count < target - deficit) s.playing = false;

      if (!s.playing) {
        s.step = 1;
        s.readFrac = 0;
        if (s.count >= target) {
          s.playing = true;
          s.lastUnderrunBlock = this.blocks;
          // 20 ms raised-cosine fade: no step at the start of playback.
          s.fadeTotal = Math.max(1, Math.round(sampleRate * 0.02));
          s.fadeLeft = s.fadeTotal;
        } else {
          s.idleFrames++;
          if (s.idleFrames > 400) {
            s.dead = true;
            this.streams.delete(id);
            this.port.postMessage({ type: 'gone', id });
          }
          continue;
        }
      }

      // Emergency trim only above 750 ms; the per-stream speed handles the rest.
      if (s.count > this.maxBufferSamples) {
        const drop = Math.min(s.count - target, s.count - 1);
        if (drop > 0) {
          s.readPos = (s.readPos + drop) % s.cap;
          s.count -= drop;
          s.dropped += drop;
        }
      }

      let underrun = false;
      const g = s.gain;
      const gl = s.mic ? s.panL : 1;
      const gr = s.mic ? s.panR : 1;

      // Block-level expander for the per-phone boost.
      //
      // Raising one phone above 100 % multiplies the whole stream, so any
      // noise baked into the phone's PCM (codec hiss, device noise floor)
      // grows with it.  This measures the block once, then applies a slowly
      // smoothed gain: quiet blocks stay at 1.0, loud blocks get the full
      // boost.  It runs per block, never per sample, so it cannot modulate
      // the waveform (that produced the earlier low-frequency hum).
      let blockBoost = g;
      if (g > 1.0001) {
        let peak = 0;
        for (let i = 0; i < left.length; i++) {
          const idx = (s.readPos + i) % s.cap;
          const a = Math.abs(s.bufL[idx]);
          const b = Math.abs(s.bufR[idx]);
          if (a > peak) peak = a;
          if (b > peak) peak = b;
        }
        // Envelope: fast attack, slow release, in normalised amplitude.
        s.env += (peak - s.env) * (peak > s.env ? 0.25 : 0.02);
        // Recent loudest block, decaying slowly: a relative reference that
        // adapts to whatever level this phone is actually sending.
        s.peakRef = Math.max(peak, s.peakRef * 0.9995);

        // Relative gate: blocks that are more than ~26 dB below the recent
        // peak are treated as background and stay at unity gain.  Music at
        // any level clears the threshold, so raising the volume never lifts
        // the hiss that sits below it.
        const rel = s.peakRef > 1e-6 ? s.env / s.peakRef : 1;
        const lowGate = 0.05;   // -26 dB
        const highGate = 0.16;  // -16 dB
        let target;
        if (rel <= lowGate) target = 1;
        else if (rel >= highGate) target = g;
        else target = 1 + (g - 1) * ((rel - lowGate) / (highGate - lowGate));

        // Fast enough to follow real audio, slow enough to stay inaudible.
        s.boostEnv += (target - s.boostEnv) * 0.15;
        blockBoost = s.boostEnv;
      } else {
        s.boostEnv = g;
      }

      const boostMul = blockBoost;

      for (let i = 0; i < left.length; i++) {
        if (s.count > 1) {
          const i0 = s.readPos;
          const i1 = (s.readPos + 1) % s.cap;
          const f = s.readFrac;
          const l = s.bufL[i0] + (s.bufL[i1] - s.bufL[i0]) * f;
          const r = s.bufR[i0] + (s.bufR[i1] - s.bufR[i0]) * f;
          let outL = l * boostMul * gl;
          let outR = r * boostMul * gr;

          if (s.fadeLeft > 0) {
            const k = 1 - s.fadeLeft / s.fadeTotal;
            const fade = 0.5 - 0.5 * Math.cos(Math.PI * k);
            outL *= fade;
            outR *= fade;
            s.fadeLeft--;
          }

          left[i] += outL;
          right[i] += outR;
          s.lastOutL = outL;
          s.lastOutR = outR;
          s.holdL = outL;
          s.holdR = outR;
          s.started = true;
          const p = Math.max(Math.abs(outL), Math.abs(outR));
          if (p > s.peak) s.peak = p;

          s.readFrac += s.step;
          while (s.readFrac >= 1) {
            s.readFrac -= 1;
            s.readPos = (s.readPos + 1) % s.cap;
            s.count--;
          }
        } else {
          // Starved: hold the last output value with a decay so the gap fades
          // instead of snapping to zero.  The immediate jump from a non-zero
          // sample to silence was audible as a click on every dropped packet.
          s.holdL *= 0.985;
          s.holdR *= 0.985;
          left[i] += s.holdL;
          right[i] += s.holdR;
          if (!underrun) {
            s.underruns++;
            underrun = true;
          }
        }
      }

      if (underrun) {
        // Short starvation (a dropped packet) should not tear down playback:
        // stopping and re-buffering the whole target is what produced the
        // audible gaps and the burst when it resumed.  Keep the stream
        // running and let the resampler coast on the last samples.
        s.shortUnderruns = (s.shortUnderruns || 0) + 1;
        s.extra = Math.min(this.maxExtra, s.extra + Math.round(this.extraStep * 0.5));
        if (s.shortUnderruns > this.maxShortUnderruns) {
          s.playing = false;
          s.shortUnderruns = 0;
        }
        s.lastUnderrunBlock = this.blocks;
      } else {
        s.shortUnderruns = 0;
        if (this.blocks - s.lastUnderrunBlock > 200) {
          if (s.extra > 0) s.extra = Math.max(0, s.extra - Math.round(sampleRate * 0.005));
          s.lastUnderrunBlock = this.blocks;
        }
      }

      // Gentle catch-up: keeps the buffer near target without pitch jumps.
      const excess = s.count - target;
      const ramp = Math.round(sampleRate * 0.06);
      const level = Math.max(0, Math.min(100, s.catchup == null ? 25 : s.catchup));
      const maxRate = 1.005 + 0.145 * (level / 100) * (level / 100);
      let desired = 1;
      if (excess > Math.round(sampleRate * 0.002)) {
        desired = excess >= ramp ? maxRate : 1 + (maxRate - 1) * (excess / ramp);
      } else if (excess < -Math.round(sampleRate * 0.01)) {
        desired = 0.995;
      }
      const slew = 0.002;
      if (desired > s.step + slew) s.step += slew;
      else if (desired < s.step - slew) s.step -= slew;
      else s.step = desired;
      s.step = Math.max(0.99, Math.min(1.15, s.step));
    }

    // Plain hard limit: transparent below full scale, so normal playback is
    // untouched.  No soft-knee curve, no envelope.
    for (let i = 0; i < left.length; i++) {
      left[i] = hardClip(left[i]);
      right[i] = hardClip(right[i]);
      const p = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (p > this.outPeak) this.outPeak = p;
    }

    this.report();
    return true;
  }

  report() {
    this.blocks++;
    if (this.blocks - this.lastReport < 20) return; // ~53 ms at 128 frames
    this.lastReport = this.blocks;

    let under = 0;
    let drop = 0;
    let buf = 0;
    let playing = 0;
    let micSpread = 0;
    let micMin = Infinity;
    let micMax = 0;
    const phones = [];
    const { active } = this.computeNeed();

    for (const [id, s] of this.streams) {
      if (s.playing && s.count > 0 && s.lastPushBlock > 0 && this.blocks - s.lastPushBlock > 300) {
        this.streams.delete(id);
        this.port.postMessage({ type: 'gone', id });
        continue;
      }
      under += s.underruns;
      drop += s.dropped;
      buf = Math.max(buf, (s.count / sampleRate) * 1000);
      if (s.playing) playing++;
      if (s.mic && (s.playing || s.count > 0)) {
        const ms = (s.count / sampleRate) * 1000;
        if (ms < micMin) micMin = ms;
        if (ms > micMax) micMax = ms;
      }
      const peak = s.peak;
      s.peak = 0;
      phones.push({
        id,
        peak,
        gain: s.gain,
        bufferMs: (s.count / sampleRate) * 1000,
        targetMs: (s.targetSamples / sampleRate) * 1000,
        playing: s.playing,
        rate: s.step,
        catchup: s.catchup,
        pushed: s.pushed,
        underruns: s.underruns,
        dropped: s.dropped,
      });
    }
    if (active >= 2 && Number.isFinite(micMin)) micSpread = micMax - micMin;

    const peak = this.outPeak;
    this.outPeak = 0;
    this.port.postMessage({
      type: 'meter',
      peak,
      bufferMs: buf,
      underruns: under,
      dropped: drop,
      playing: playing > 0,
      voices: this.streams.size,
      balancedPhones: active,
      micSpreadMs: micSpread,
      phones,
    });
  }
}

/* Local PC microphone monitor.  Volume is applied after this node, so the
 * gate always sees the unscaled microphone signal. */
class PcmMonitor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.filter = new MicNoiseFilter();
    this.enabled = true;
    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'config') this.filter.setStrength(msg.nr);
      if (msg.type === 'enable') {
        this.enabled = msg.on !== false;
        if (!this.enabled) this.filter.reset();
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    out[0].fill(0);
    if (out[1]) out[1].fill(0);
    if (!this.enabled) return true;

    const input = inputs[0];
    if (!input || !input[0]) return true;
    const left = input[0];
    const right = input.length > 1 && input[1] ? input[1] : input[0];
    const outL = out[0];
    const outR = out[1] || out[0];

    for (let i = 0; i < left.length; i++) {
      const y = this.filter.process(left[i], right[i]);
      outL[i] = hardClip(y[0]);
      outR[i] = hardClip(y[1]);
    }
    return true;
  }
}

registerProcessor('pcm-sender', PcmSender);
registerProcessor('pcm-mixer', PcmMixer);
registerProcessor('pcm-monitor', PcmMonitor);
