/* AudioWorklets for LAN Audio
 * pcm-sender : captures mixed input at 48 kHz and posts 20 ms stereo blocks
 * pcm-mixer  : resamples every phone stream, keeps one jitter buffer per phone
 *              and sums them into a single stereo output.
 *
 * Streams are keyed by "<phoneId>" (app / system sound) or "<phoneId>#mic"
 * (microphone only).  App 1.2+ sends those as separate frames so the PC can
 * apply a microphone-only gain and place a mic in the left/right channel.
 *
 * Each phone has its own receive-buffer target (20..400 ms).  When the
 * “balance buffer” switch is on, all active phones share the largest target;
 * otherwise each phone uses its own.  Underrun margin is capped, so the real
 * buffer can never run away to absurd values.
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

function softClip(x) {
  const a = Math.abs(x);
  if (a <= 0.8) return x;
  return Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
}

/** PC-side microphone conditioning: gentle high-pass + adaptive downward
 *  expander.  It only ever runs on "#mic" streams, never on app audio. */
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
    // Low strength barely gates; 100 only attenuates by about 20 dB.
    const closed = 1 - level * 0.9;
    const target = open ? 1 : closed;
    this.gate += (target - this.gate) * (open ? 0.08 : 0.0025);
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
    this.catchup = 25;     // 0..100 -> 1.005x .. 1.15x
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
    this.mic = false;
    this.phoneId = 'default';
    this.pan = 0;
    this.panL = 1;
    this.panR = 1;
    // target buffer, in samples
    this.baseTarget = 0;   // configured by the user
    this.extra = 0;        // temporary underrun safety margin
    this.targetSamples = 0;
    this.effTarget = 0;    // last effective target, used to detect changes
    this.idleFrames = 0;
    this.dead = false;
    this.lastPushBlock = 0;
    this.pushed = 0;
    // Declick state used only for the 750 ms emergency cut.
    this.declickLeft = 0;
    this.declickTotal = 0;
    this.lastOutL = 0;
    this.lastOutR = 0;
    this.nr = 0;
    this.nrFilter = new MicNoiseFilter();
    this.fadeLeft = 0;
    this.fadeTotal = 0;
  }
}

class PcmMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.streams = new Map();
    this.phoneCfg = new Map();
    this.defaultTarget = Math.round(sampleRate * 0.09);
    // User range is 20..400 ms; underrun margin adds at most 120 ms.
    this.maxTargetSamples = Math.round(sampleRate * 0.55);
    // Hard trim: whatever happens, never keep more than 750 ms of audio.
    this.maxBufferSamples = Math.round(sampleRate * 0.75);
    this.maxExtra = Math.round(sampleRate * 0.08);
    this.extraStep = Math.round(sampleRate * 0.02);
    this.balance = true;
    this.blocks = 0;
    this.lastReport = 0;
    this.outPeak = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;

      if (msg.type === 'config' && Number.isFinite(msg.bufferMs)) {
        this.defaultTarget = this.msToSamples(msg.bufferMs);
        // Streams without an explicit per-phone target follow the global one.
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
        // Legacy path (no separate mic stream): treat as the main gain.
        const s = this.streams.get(String(msg.id));
        if (s) {
          s.mainGain = Number.isFinite(msg.gain) ? Math.max(0, Math.min(3, msg.gain)) : 1;
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
    const main = Number.isFinite(cfg.gain) ? cfg.gain : s.mainGain;
    const micGain = Number.isFinite(cfg.micGain) ? cfg.micGain : s.micGain;
    const pan = Number.isFinite(cfg.pan) ? cfg.pan : s.pan;

    s.mainGain = main;
    s.micGain = micGain;
    s.gain = main * (s.mic ? micGain : 1);
    s.pan = pan;
    s.nr = s.mic && Number.isFinite(cfg.nr) ? cfg.nr : 0;
    s.nrFilter.setStrength(s.nr);
    const p = s.mic ? pan : 0;
    // Simple balance pan: centre keeps both channels at full level.
    s.panL = 1 - Math.max(0, p);
    s.panR = 1 + Math.min(0, p);

    s.baseTarget = Number.isFinite(cfg.bufferMs)
      ? this.msToSamples(cfg.bufferMs)
      : this.defaultTarget;
    s.catchup = Number.isFinite(cfg.catchup) ? cfg.catchup : 25;
  }

  /** Largest configured target among streams that are actually running. */
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

  /**
   * Re-evaluate every stream after a target/balance change.
   *
   * A higher target pauses playback so the buffer can fill immediately.
   * A lower target is NOT cut: the per-device catch-up speed gradually
   * consumes the surplus, which avoids the click/noise of dropping samples.
   */
  retargetAll() {
    const { need } = this.computeNeed();
    const tol = Math.round(sampleRate * 0.01);

    for (const s of this.streams.values()) {
      const next = this.targetFor(s, need);
      const prev = s.effTarget || 0;

      if (next > prev + tol && s.playing && s.count < next) {
        s.playing = false;
      }

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
    // Defaults before the first set-phone message arrives.
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
    if (Number.isFinite(msg.gain)) {
      // The frame gain is the per-device main gain; mic gain is applied by
      // applyStreamConfig so it is never counted twice.
      s.mainGain = Math.max(0, Math.min(3, msg.gain));
      s.gain = s.mainGain * (s.mic ? s.micGain : 1);
    }
    s.idleFrames = 0;
    s.dead = false;
    s.lastPushBlock = this.blocks;
    this.receivePcm(s, msg.pcm, msg.rate || 48000, msg.channels || 1);
  }

  receivePcm(s, pcm, rate, channels) {
    const n = pcm.length / channels;
    if (!Number.isInteger(n) || n <= 0) return;

    if (rate !== s.prevRate) {
      // reset continuity when this phone changes format
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
    // The 750 ms emergency cut is handled in process(), where a short
    // declick ramp can be applied.  Never drop audio here.
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

      // If we are already playing but the target has moved up (balance or
      // extra margin), re-buffer instead of drifting below it for ages.
      const deficit = Math.round(sampleRate * 0.04);
      if (s.playing && s.count < target - deficit) s.playing = false;

      if (!s.playing) {
        // No audio is being emitted, so resetting the rate here is inaudible
        // and prevents a high catch-up speed from leaking into the resume.
        s.step = 1;
        if (s.count >= target) {
          s.playing = true;
          s.lastUnderrunBlock = this.blocks;
          s.fadeTotal = Math.max(1, Math.round(sampleRate * 0.003));
          s.fadeLeft = s.fadeTotal;
        } else {
          // No audio yet: forget the stream if it has been quiet for a while.
          s.idleFrames++;
          if (s.idleFrames > 400) {
            s.dead = true;
            this.streams.delete(id);
            this.port.postMessage({ type: 'gone', id });
          }
          continue;
        }
      }

      // Emergency stop: only when the real buffer exceeds 750 ms.  Drop back
      // to the target and ramp from the last output sample for 1.5 ms, so the
      // cut does not click.
      if (s.count > this.maxBufferSamples) {
        const drop = Math.min(s.count - target, s.count - 1);
        if (drop > 0) {
          s.declickLeft = Math.max(1, Math.round(sampleRate * 0.0015));
          s.declickTotal = s.declickLeft;
          s.readPos = (s.readPos + drop) % s.cap;
          s.count -= drop;
          s.dropped += drop;
        }
      }

      let underrun = false;
      const g = s.gain;
      const gl = s.mic ? s.panL : 1;
      const gr = s.mic ? s.panR : 1;

      for (let i = 0; i < left.length; i++) {
        if (s.count > 1) {
          const i0 = s.readPos;
          const i1 = (s.readPos + 1) % s.cap;
          const f = s.readFrac;
          const l = s.bufL[i0] + (s.bufL[i1] - s.bufL[i0]) * f;
          const r = s.bufR[i0] + (s.bufR[i1] - s.bufR[i0]) * f;
          let outL = l * g * gl;
          let outR = r * g * gr;

          if (s.fadeLeft > 0) {
            const fade = 1 - s.fadeLeft / s.fadeTotal;
            outL *= fade;
            outR *= fade;
            s.fadeLeft--;
          }

          if (s.declickLeft > 0) {
            // Continue from the last emitted sample into the new position.
            const k = 1 - s.declickLeft / s.declickTotal;
            outL = s.lastOutL + (outL - s.lastOutL) * k;
            outR = s.lastOutR + (outR - s.lastOutR) * k;
            s.declickLeft--;
          }

          left[i] += outL;
          right[i] += outR;
          s.lastOutL = outL;
          s.lastOutR = outR;
          const p = Math.max(Math.abs(outL), Math.abs(outR));
          if (p > s.peak) s.peak = p;

          s.readFrac += s.step;
          while (s.readFrac >= 1) {
            s.readFrac -= 1;
            s.readPos = (s.readPos + 1) % s.cap;
            s.count--;
          }
        } else if (!underrun) {
          s.underruns++;
          underrun = true;
        }
      }

      if (underrun) {
        s.playing = false;
        s.lastUnderrunBlock = this.blocks;
        s.extra = Math.min(this.maxExtra, s.extra + this.extraStep);
      } else if (this.blocks - s.lastUnderrunBlock > 200) {
        // Stable for ~1.1 s: slowly remove the temporary safety margin.
        if (s.extra > 0) {
          s.extra = Math.max(0, s.extra - Math.round(sampleRate * 0.005));
        }
        s.lastUnderrunBlock = this.blocks;
      }

      // Continuous, per-device catch-up speed.
      //
      // 0..100 maps to 1.005x..1.15x.  Above 60 ms of surplus the chosen
      // speed is used in full; below that the target speed eases back to 1.0
      // *before* reaching the target.  A slew limit prevents any abrupt
      // "double speed" step, so the pitch change is always gradual.
      const excess = s.count - target;
      const ramp = Math.round(sampleRate * 0.06);
      const level = Math.max(0, Math.min(100, s.catchup == null ? 25 : s.catchup));
      const maxRate = 1.005 + 0.145 * (level / 100) * (level / 100);
      let desired = 1;
      if (excess > Math.round(sampleRate * 0.002)) {
        desired = excess >= ramp
          ? maxRate
          : 1 + (maxRate - 1) * (excess / ramp);
      } else if (excess < -Math.round(sampleRate * 0.01)) {
        desired = 0.995;
      }

      const slew = 0.002;
      if (desired > s.step + slew) s.step += slew;
      else if (desired < s.step - slew) s.step -= slew;
      else s.step = desired;
      s.step = Math.max(0.99, Math.min(1.15, s.step));
    }

    // Soft limiter: keeps several simultaneous phones from clipping.
    for (let i = 0; i < left.length; i++) {
      left[i] = softClip(left[i]);
      right[i] = softClip(right[i]);
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
      // Purge streams whose owner is gone (no frames for >4 s). The browser
      // can unload a page or a phone can vanish without a JSON event, and
      // stale streams would otherwise keep pumping garbage into the speaker.
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

/* Local PC microphone monitor: same high-pass / adaptive gate as phone mic
 * streams, followed by a soft limiter.  The gain node sits before this
 * processor, so boosting the monitor up to 300% is still clipped smoothly. */
class PcmMonitor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.filter = new MicNoiseFilter();
    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'config') this.filter.setStrength(msg.nr);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    out[0].fill(0);
    if (out[1]) out[1].fill(0);

    const input = inputs[0];
    if (!input || !input[0]) return true;
    const left = input[0];
    const right = input.length > 1 && input[1] ? input[1] : input[0];
    const outL = out[0];
    const outR = out[1] || out[0];

    for (let i = 0; i < left.length; i++) {
      const y = this.filter.process(left[i], right[i]);
      outL[i] = softClip(y[0]);
      outR[i] = softClip(y[1]);
    }
    return true;
  }
}

registerProcessor('pcm-sender', PcmSender);
registerProcessor('pcm-mixer', PcmMixer);
registerProcessor('pcm-monitor', PcmMonitor);
