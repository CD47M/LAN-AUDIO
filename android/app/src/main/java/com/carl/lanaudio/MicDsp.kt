package com.carl.lanaudio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Microphone-only DSP running at 48 kHz mono, 20 ms frames.
 *
 * Chain: high-pass (90 Hz) -> downward expander (noise gate) -> optional
 * magnitude-domain spectral subtraction -> output gain.
 *
 * [strength] is a continuous 0..100 control:
 *   0        = bypass (system NoiseSuppressor may still be active)
 *   1..25    = gentle gate
 *   26..100  = gate + spectral subtraction, progressively stronger
 *
 * The chain is intentionally simple and allocation-free on the hot path.
 */
class MicDsp {
    companion object {
        private const val RATE = 48000
        private const val FFT = 512
        private const val HOP = 256
        private const val BINS = FFT / 2 + 1
        const val FRAME = 960 // 20 ms at 48 kHz
    }

    @Volatile
    var gain: Float = 1f

    @Volatile
    var strength: Float = 0f

    private val hpf = Biquad.highPass(90.0, RATE.toDouble())

    // sqrt(Hann) analysis + synthesis gives constant overlap-add with hop = N/2.
    private val window = DoubleArray(FFT) {
        sqrt(0.5 - 0.5 * cos(2.0 * PI * it / FFT))
    }

    private val fft = Fft(FFT)
    private val re = DoubleArray(FFT)
    private val im = DoubleArray(FFT)
    private val mag = DoubleArray(BINS)
    private val power = DoubleArray(BINS)
    private val noise = DoubleArray(BINS)
    private val gainSm = DoubleArray(BINS) { 1.0 }
    private val gainTmp = DoubleArray(BINS)
    private val slide = DoubleArray(FFT)
    private val ola = DoubleArray(FFT)
    private val hopBuf = DoubleArray(HOP)
    private val pending = DoubleArray(HOP * 8)
    private var pendingLen = 0
    private val outQueue = DoubleArray(HOP * 8)
    private var outLen = 0
    private var noiseInit = false
    private var lastGate = 1.0
    private var noiseFloorDb = -60.0

    fun process(input: ShortArray): ShortArray {
        val s = strength
        val n = input.size
        val out = ShortArray(n)

        if (s <= 0.5f) {
            // Bypass keeps the CPU cost at zero and preserves the untouched signal.
            resetState()
            val g = gain.toDouble()
            for (i in 0 until n) out[i] = clamp(softLimit(input[i] * g))
            return out
        }

        for (i in 0 until n) {
            if (pendingLen >= pending.size) {
                // Should never happen with 960-sample frames, but stay safe.
                System.arraycopy(pending, HOP, pending, 0, pendingLen - HOP)
                pendingLen -= HOP
            }
            pending[pendingLen++] = hpf.process(input[i].toDouble())
        }

        while (pendingLen >= HOP) {
            // Copy the hop out, then build the 512-sample analysis frame.
            System.arraycopy(pending, 0, hopBuf, 0, HOP)
            System.arraycopy(pending, HOP, pending, 0, pendingLen - HOP)
            pendingLen -= HOP

            System.arraycopy(slide, HOP, slide, 0, FFT - HOP)
            System.arraycopy(hopBuf, 0, slide, FFT - HOP, HOP)

            val gate = nextGate(hopBuf, s)
            processFrame(s, gate)

            for (i in 0 until HOP) outQueue[outLen++] = ola[i]
            System.arraycopy(ola, HOP, ola, 0, FFT - HOP)
            java.util.Arrays.fill(ola, FFT - HOP, FFT, 0.0)
        }

        val g = gain.toDouble()
        for (i in 0 until n) {
            val v = if (i < outLen) outQueue[i] * g else 0.0
            out[i] = clamp(softLimit(v))
        }
        if (outLen > n) {
            System.arraycopy(outQueue, n, outQueue, 0, outLen - n)
            outLen -= n
        } else {
            outLen = 0
        }
        return out
    }

    /** Downward expander with a smooth attack/release, evaluated per hop. */
    private fun nextGate(hop: DoubleArray, s: Float): Double {
        var sum = 0.0
        for (v in hop) sum += v * v
        val rms = sqrt(sum / HOP)
        val db = 20.0 * log10(max(rms / 32768.0, 1e-9))

        val t = ((s - 1f) / 99f).coerceIn(0f, 1f).toDouble()

        // Track the background floor so the gate adapts to each phone / room
        // instead of relying on one fixed dB threshold.
        if (noiseFloorDb < -59.0) noiseFloorDb = db
        else if (db < noiseFloorDb) noiseFloorDb += (db - noiseFloorDb) * 0.35
        else noiseFloorDb += (db - noiseFloorDb) * 0.002

        val thresholdDb = (noiseFloorDb + 2.0 + 5.0 * t).coerceIn(-70.0, -12.0)
        val minGain = 10.0.pow(-(6.0 + 30.0 * t) / 20.0)
        val open = thresholdDb + 3.0
        val close = thresholdDb - 6.0

        val target = when {
            db >= open -> 1.0
            db <= close -> minGain
            else -> minGain + (1.0 - minGain) * (db - close) / (open - close)
        }
        // ~5 ms attack, ~65 ms release at 48 kHz / 256 hop.
        val coeff = if (target > lastGate) 0.55 else 0.08
        lastGate += (target - lastGate) * coeff
        return lastGate
    }

    private fun processFrame(s: Float, gate: Double) {
        for (i in 0 until FFT) {
            re[i] = slide[i] * window[i]
            im[i] = 0.0
        }
        fft.forward(re, im)

        var energy = 0.0
        for (k in 0 until BINS) {
            val r = re[k]
            val imk = im[k]
            val p = r * r + imk * imk
            power[k] = p
            mag[k] = sqrt(p)
            energy += p
        }

        if (!noiseInit) {
            System.arraycopy(power, 0, noise, 0, BINS)
            noiseInit = true
        } else {
            var noiseEnergy = 0.0
            for (k in 0 until BINS) noiseEnergy += noise[k]
            val speech = energy > noiseEnergy * 3.0
            val fast = if (speech) 0.001 else 0.10
            val slow = 1.0 - fast
            for (k in 0 until BINS) noise[k] = slow * noise[k] + fast * power[k]
        }

        if (s > 25f) {
            val t = ((s - 25f) / 75f).coerceIn(0f, 1f).toDouble()
            val alpha = 0.5 + 1.1 * t
            val floor = 10.0.pow((-22.0 + 10.0 * t) / 20.0)

            for (k in 0 until BINS) {
                val raw = 1.0 - alpha * sqrt(noise[k]) / max(mag[k], 1e-9)
                gainTmp[k] = max(floor, min(1.0, raw))
            }
            // Smooth across frequency, then across time, to avoid musical noise.
            for (k in 0 until BINS) {
                val a = gainTmp[if (k > 0) k - 1 else k]
                val b = gainTmp[k]
                val c = gainTmp[if (k < BINS - 1) k + 1 else k]
                val g = (a + b + c) / 3.0
                gainSm[k] = 0.55 * gainSm[k] + 0.45 * g
                re[k] *= gainSm[k]
                im[k] *= gainSm[k]
            }
        }

        fft.inverse(re, im)
        for (i in 0 until FFT) {
            ola[i] += re[i] * window[i] * gate
        }
    }

    private fun resetState() {
        if (pendingLen == 0 && outLen == 0 && !noiseInit) return
        pendingLen = 0
        outLen = 0
        noiseInit = false
        lastGate = 1.0
        noiseFloorDb = -60.0
        java.util.Arrays.fill(ola, 0.0)
        java.util.Arrays.fill(slide, 0.0)
        java.util.Arrays.fill(gainSm, 1.0)
        hpf.reset()
    }

    /** Soft knee above 0.8 full-scale; stops 500% gain from hard-clipping. */
    private fun softLimit(v: Double): Double {
        val a = kotlin.math.abs(v)
        if (a <= 0.8 * 32768.0) return v
        val sign = if (v < 0) -1.0 else 1.0
        val over = (a - 0.8 * 32768.0) / (0.2 * 32768.0)
        return sign * (0.8 * 32768.0 + 0.2 * 32768.0 * kotlin.math.tanh(over))
    }

    private fun clamp(v: Double): Short = when {
        v >= 32767.0 -> 32767
        v <= -32768.0 -> -32768
        else -> v.toInt().toShort()
    }
}

/** Anti-aliasing decimator for the microphone stream.
 *
 *  Capture stays at 48 kHz but the microphone is often sent at 24 or 16 kHz.
 *  Plain block averaging is a weak low-pass, so out-of-band hiss folded back
 *  into the speech band; this applies a short windowed-sinc FIR before taking
 *  every N-th sample.  It runs after [MicDsp] and does not alter its tuning.
 */
internal class MicDecimator {
    private val taps = DoubleArray(TAPS) { i ->
        val m = i - (TAPS - 1) / 2.0
        val sinc = if (m == 0.0) 1.0 else sin(PI * 0.42 * m) / (PI * 0.42 * m)
        val w = 0.42 - 0.5 * cos(2.0 * PI * i / (TAPS - 1)) + 0.08 * cos(4.0 * PI * i / (TAPS - 1))
        sinc * w
    }
    private val history = DoubleArray(TAPS)
    private var pos = 0
    private var primed = false

    fun process(input: DoubleArray): DoubleArray {
        val out = DoubleArray(input.size)
        if (!primed) {
            java.util.Arrays.fill(history, input[0])
            primed = true
        }
        for (i in input.indices) {
            history[pos] = input[i]
            pos = (pos + 1) % TAPS
            var acc = 0.0
            var idx = pos
            for (k in 0 until TAPS) {
                acc += history[idx] * taps[k]
                idx++
                if (idx == TAPS) idx = 0
            }
            out[i] = acc
        }
        return out
    }

    fun reset() {
        primed = false
        pos = 0
        java.util.Arrays.fill(history, 0.0)
    }

    companion object {
        private const val TAPS = 31
    }
}

/** Simple RBJ biquad, used for the microphone high-pass. */
private class Biquad(
    private val b0: Double,
    private val b1: Double,
    private val b2: Double,
    private val a1: Double,
    private val a2: Double,
) {
    private var x1 = 0.0
    private var x2 = 0.0
    private var y1 = 0.0
    private var y2 = 0.0

    fun process(x: Double): Double {
        val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        return y
    }

    fun reset() {
        x1 = 0.0
        x2 = 0.0
        y1 = 0.0
        y2 = 0.0
    }

    companion object {
        fun highPass(freq: Double, rate: Double): Biquad {
            val w0 = 2.0 * PI * freq / rate
            val cosw = cos(w0)
            val sinw = sin(w0)
            val alpha = sinw / (2.0 * 0.70710678)
            val b0 = (1.0 + cosw) / 2.0
            val b1 = -(1.0 + cosw)
            val b2 = (1.0 + cosw) / 2.0
            val a0 = 1.0 + alpha
            val a1 = -2.0 * cosw
            val a2 = 1.0 - alpha
            return Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
        }
    }
}

/** In-place radix-2 FFT with precomputed tables. */
private class Fft(private val n: Int) {
    private val levels = Integer.numberOfTrailingZeros(n)
    private val cosTable = DoubleArray(n / 2) { cos(2.0 * PI * it / n) }
    private val sinTable = DoubleArray(n / 2) { sin(2.0 * PI * it / n) }
    private val rev = IntArray(n) { Integer.reverse(it) ushr (32 - levels) }

    fun forward(re: DoubleArray, im: DoubleArray) = transform(re, im, false)

    fun inverse(re: DoubleArray, im: DoubleArray) {
        transform(re, im, true)
        val inv = 1.0 / n
        for (i in 0 until n) {
            re[i] *= inv
            im[i] *= inv
        }
    }

    private fun transform(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
        for (i in 0 until n) {
            val j = rev[i]
            if (j > i) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }

        var size = 2
        while (size <= n) {
            val half = size / 2
            val step = n / size
            var start = 0
            while (start < n) {
                var k = 0
                for (j in start until start + half) {
                    val idx = k * step
                    val c = cosTable[idx]
                    val s = if (inverse) sinTable[idx] else -sinTable[idx]
                    val jr = j + half
                    val tre = re[jr] * c - im[jr] * s
                    val tim = re[jr] * s + im[jr] * c
                    re[jr] = re[j] - tre
                    im[jr] = im[j] - tim
                    re[j] += tre
                    im[j] += tim
                    k++
                }
                start += size
            }
            size *= 2
        }
    }
}