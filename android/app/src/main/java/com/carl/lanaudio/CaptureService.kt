package com.carl.lanaudio

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import java.util.Locale
import kotlin.math.abs
import kotlin.math.log10

/**
 * Holds one WebSocket to the PC and runs the send and receive halves
 * independently: either half can be started or stopped without touching the
 * other one. The service stops itself once both halves are off.
 */
class CaptureService : Service() {
    companion object {
        private const val TAG = "LanAudio"

        const val ACTION_SEND_START = "com.carl.lanaudio.action.SEND_START"
        const val ACTION_SEND_STOP = "com.carl.lanaudio.action.SEND_STOP"
        const val ACTION_PEER_SEND_START = "com.carl.lanaudio.action.PEER_SEND_START"
        const val ACTION_PEER_SEND_STOP = "com.carl.lanaudio.action.PEER_SEND_STOP"
        const val ACTION_RECEIVE_START = "com.carl.lanaudio.action.RECEIVE_START"
        const val ACTION_RECEIVE_STOP = "com.carl.lanaudio.action.RECEIVE_STOP"
        const val ACTION_PEER_RECEIVE_START = "com.carl.lanaudio.action.PEER_RECEIVE_START"
        const val ACTION_PEER_RECEIVE_STOP = "com.carl.lanaudio.action.PEER_RECEIVE_STOP"
        const val ACTION_STOP = "com.carl.lanaudio.action.STOP"
        const val ACTION_SET_AUDIO = "com.carl.lanaudio.action.SET_AUDIO"
        const val ACTION_SET_PEER = "com.carl.lanaudio.action.SET_PEER"
        const val ACTION_SET_SOURCE = "com.carl.lanaudio.action.SET_SOURCE"

        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "data"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_ROOM = "room"
        const val EXTRA_SOURCE = "source"
        const val EXTRA_RATE = "rate"
        const val EXTRA_MIC_RATE = "mic_rate"
        const val EXTRA_CHANNELS = "channels"
        const val EXTRA_AEC = "aec"
        const val EXTRA_NS = "ns"
        const val EXTRA_PLAY = "play"
        const val EXTRA_VOLUME = "volume"
        const val EXTRA_BOOST = "boost"
        const val EXTRA_PEER = "peer"
        const val EXTRA_NAME = "device_name"
        const val EXTRA_MIC_GAIN = "mic_gain"
        const val EXTRA_NR = "nr_strength"

        private const val CHANNEL_ID = "lanaudio_fgs"
        private const val NOTIF_ID = 42
    }

    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var engine: AudioEngine? = null
    private var player: AudioPlayer? = null
    private var ws: WsClient? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var tearingDown = false

    // Keep the WS + service alive briefly after the PC turns off the last
    // stream, so the same PC can turn it back on without the phone UI.
    private var remoteKeepAlive = false
    private val idleHandler = Handler(Looper.getMainLooper())
    private val idleStop = Runnable {
        remoteKeepAlive = false
        stopIfIdle()
    }

    private var connection: Connection? = null

    private var sendOn = false
    private var sendPeerOn = false
    private var receiveOn = false
    private var receivePeerOn = false
    private var sourceMode = AudioEngine.SOURCE_APP
    private var targetRate = 48000
    private var micTargetRate = 24000
    private var targetChannels = 2
    private var aecEnabled = true
    private var nsEnabled = true
    private var startResultCode = Activity.RESULT_CANCELED
    private var startProjectionData: Intent? = null

    @Volatile
    private var deviceId = ""

    private var playEnabled = true
    private var volume = 1f
    private var boost = false
    private var peerTarget = 0
    private var deviceName = "Android"
    private var micGain = 1f
    private var nrStrength = 0f

    private var micLevelChecked = false
    private var micLevelStartedAt = 0L
    private var micPeak = 0f

    private data class Connection(val host: String, val port: Int, val room: String)

    override fun onCreate() {
        super.onCreate()
        deviceId = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        } catch (_: Exception) {
            ""
        }
        createChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY

        // Android 12+ kills the app if startForegroundService() is not followed
        // by startForeground() promptly, and it also complains when the service
        // type changes later on. Decide the full type set first, enter the
        // foreground once, and keep it for the rest of the session.
        when (intent.action) {
            ACTION_RECEIVE_START -> {
                receiveOn = true
            }
            ACTION_PEER_RECEIVE_START -> {
                receivePeerOn = true
            }
            ACTION_SEND_START -> {
                // sourceMode decides the foreground type set, so read it before
                // entering the foreground.
                sourceMode = intent.getIntExtra(EXTRA_SOURCE, AudioEngine.SOURCE_APP)
                sendOn = true
            }
            ACTION_PEER_SEND_START -> {
                sourceMode = intent.getIntExtra(EXTRA_SOURCE, AudioEngine.SOURCE_APP)
                sendPeerOn = true
            }
            ACTION_RECEIVE_STOP, ACTION_PEER_RECEIVE_STOP,
            ACTION_SEND_STOP, ACTION_PEER_SEND_STOP, ACTION_STOP,
            ACTION_SET_AUDIO, ACTION_SET_PEER, ACTION_SET_SOURCE -> {
                // These never need to start the foreground by themselves.
            }
        }

        if (sendOn || sendPeerOn || receiveOn || receivePeerOn) startForegroundCompat()

        when (intent.action) {
            ACTION_SET_AUDIO -> {
                applyAudioSettings(intent)
                return START_NOT_STICKY
            }
            ACTION_SET_SOURCE -> {
                val source = intent.getIntExtra(EXTRA_SOURCE, sourceMode)
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                @Suppress("DEPRECATION")
                val data = intent.getParcelableExtra(EXTRA_DATA) as? Intent
                if (resultCode == Activity.RESULT_OK && data != null) {
                    // The user just authorized MediaProjection for switching from
                    // a mic-only session to app audio.
                    startResultCode = resultCode
                    startProjectionData = data
                    adoptProjection(resultCode, data)
                }
                applySourceMode(source, remote = false)
                return START_NOT_STICKY
            }
            ACTION_SET_PEER -> {
                peerTarget = intent.getIntExtra(EXTRA_PEER, 0)
                ws?.peerTarget = peerTarget
                RunState.addLog(
                    if (peerTarget == 0) "手机互传：未选择目标手机"
                    else "手机互传：目标 #$peerTarget"
                )
                return START_NOT_STICKY
            }
            ACTION_RECEIVE_STOP -> {
                clearRemoteKeepAlive()
                stopReceiving(false)
                return START_NOT_STICKY
            }
            ACTION_PEER_RECEIVE_STOP -> {
                clearRemoteKeepAlive()
                stopReceiving(true)
                return START_NOT_STICKY
            }
            ACTION_SEND_STOP -> {
                clearRemoteKeepAlive()
                stopSending(false)
                return START_NOT_STICKY
            }
            ACTION_PEER_SEND_STOP -> {
                clearRemoteKeepAlive()
                stopSending(true)
                return START_NOT_STICKY
            }
            ACTION_STOP -> {
                clearRemoteKeepAlive()
                stopSelf()
                return START_NOT_STICKY
            }
        }

        if (intent.action == ACTION_RECEIVE_START) {
            startReceiving(intent, false)
            return START_NOT_STICKY
        }
        if (intent.action == ACTION_PEER_RECEIVE_START) {
            startReceiving(intent, true)
            return START_NOT_STICKY
        }
        if (intent.action == ACTION_SEND_START) {
            startSending(intent, false)
            return START_NOT_STICKY
        }
        if (intent.action == ACTION_PEER_SEND_START) {
            startSending(intent, true)
            return START_NOT_STICKY
        }

        return START_NOT_STICKY
    }

    /* ---------------- receive (independent PC / phone sources) ---------------- */

    private fun startReceiving(intent: Intent, fromPeer: Boolean) {
        clearRemoteKeepAlive()
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty().trim()
        val port = intent.getIntExtra(EXTRA_PORT, 8080)
        val room = intent.getStringExtra(EXTRA_ROOM).orEmpty().ifBlank { "8888" }
        applyAudioSettings(intent)

        if (host.isBlank()) {
            fail("需要先填写或发现电脑地址")
            return
        }

        val hostChanged = connection?.let {
            it.host != host || it.port != port || it.room != room
        } ?: true

        if (hostChanged) {
            try {
                ws?.close()
            } catch (_: Exception) {
            }
            ws = null
            connection = null
        }

        if (player == null) player = AudioPlayer(if (playEnabled) volume else 0f, boost)
        ensureClient(Connection(host, port, room))
        publishState()
        RunState.addLog(
            if (fromPeer) "开始接收另一台手机的声音"
            else "开始接收电脑声音（不采集手机声音）"
        )
    }

    private fun stopReceiving(fromPeer: Boolean) {
        if (fromPeer) receivePeerOn = false else receiveOn = false

        if (!receiveOn && !receivePeerOn) {
            try {
                player?.release()
            } catch (_: Exception) {
            }
            player = null
        }

        ws?.receiveEnabled = receiveOn
        ws?.receivePeerEnabled = receivePeerOn
        ws?.sendStatus()
        RunState.addLog(if (fromPeer) "已停止接收手机声音" else "已停止接收电脑声音")
        publishState()
        stopIfIdle()
    }

    /* ---------------- send (independent PC / phone targets) ---------------- */

    private fun startSending(intent: Intent, toPeer: Boolean) {
        clearRemoteKeepAlive()
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty().trim()
        val port = intent.getIntExtra(EXTRA_PORT, 8080)
        val room = intent.getStringExtra(EXTRA_ROOM).orEmpty().ifBlank { "8888" }
        val source = intent.getIntExtra(EXTRA_SOURCE, AudioEngine.SOURCE_APP)
        val rate = intent.getIntExtra(EXTRA_RATE, 48000)
        val micRate = intent.getIntExtra(EXTRA_MIC_RATE, 24000)
        val channels = intent.getIntExtra(EXTRA_CHANNELS, 2)
        val aec = intent.getBooleanExtra(EXTRA_AEC, true)
        val ns = intent.getBooleanExtra(EXTRA_NS, true)
        sourceMode = source
        targetRate = rate
        micTargetRate = micRate
        targetChannels = channels
        aecEnabled = aec
        nsEnabled = ns
        applyAudioSettings(intent)

        if (toPeer && peerTarget <= 0) {
            sendPeerOn = false
            RunState.addLog("请先在“手机互传”里选择目标手机")
            publishState()
            return
        }

        // The capture engine is shared: if it is already running (for the other
        // target) just flip the new target on. No host/permission needed again.
        if (engine != null) {
            publishState()
            RunState.addLog(if (toPeer) "开始发送给手机" else "开始发送给电脑")
            return
        }

        if (host.isBlank()) {
            fail("需要先填写或发现电脑地址")
            return
        }
        if (!ensureClient(Connection(host, port, room))) return

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        @Suppress("DEPRECATION")
        val data = intent.getParcelableExtra(EXTRA_DATA) as? Intent
        startResultCode = resultCode
        startProjectionData = data

        var mp: MediaProjection? = null
        if (source != AudioEngine.SOURCE_MIC) {
            mp = adoptProjection(resultCode, data)
            if (mp == null) {
                fail("没有拿到投屏/音频授权")
                return
            }
        }

        micLevelChecked = false
        micLevelStartedAt = 0L
        micPeak = 0f

        val engine = createEngine(source, mp)
        this.engine = engine

        try {
            engine.start()
        } catch (e: Exception) {
            Log.e(TAG, "engine start failed", e)
            fail("音频采集启动失败：${e.message}")
            return
        }

        acquireLocks()
        ws?.sendStatus()

        RunState.addLog(
            "开始发送：${sourceName(source)}，${rate / 1000} kHz，" +
                if (channels == 2) "立体声" else "单声道"
        )
        if (source != AudioEngine.SOURCE_APP) {
            RunState.addLog(
                "麦克风：${micTargetRate / 1000} kHz，发送增益 ${(micGain * 100).toInt()}%，降噪 ${nrStrength.toInt()}"
            )
        }
        publishState()
    }

    private fun createEngine(source: Int, mp: MediaProjection?): AudioEngine {
        val engine = AudioEngine(
            sourceMode = source,
            targetRate = targetRate,
            micTargetRate = micTargetRate,
            targetChannels = targetChannels,
            aecEnabled = aecEnabled,
            nsEnabled = nsEnabled,
            projection = mp,
            onFrame = { samples, sampleRate, channelCount, frameType ->
                if (frameType == AudioEngine.FRAME_MIC) checkMicLevel(samples)
                if (sendOn) ws?.sendAudio(samples, sampleRate, channelCount, 0, frameType)
                if (sendPeerOn && peerTarget > 0) {
                    ws?.sendAudio(samples, sampleRate, channelCount, peerTarget, frameType)
                }
            },
            onError = { message ->
                RunState.addLog(message)
                RunState.status = message
                updateNotification(message)
                stopSending(false)
            },
        )
        engine.micGain = micGain
        engine.nrStrength = nrStrength
        return engine
    }

    private fun adoptProjection(resultCode: Int, data: Intent?): MediaProjection? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = try {
            mpm.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            Log.e(TAG, "getMediaProjection failed", e)
            null
        } ?: return null

        val oldCallback = projectionCallback
        projectionCallback = null
        try {
            if (oldCallback != null) projection?.unregisterCallback(oldCallback)
        } catch (_: Exception) {
        }
        try {
            projection?.stop()
        } catch (_: Exception) {
        }

        projection = mp
        val callback = object : MediaProjection.Callback() {
            override fun onStop() {
                if (!tearingDown) {
                    RunState.addLog("系统已停止授权")
                    sendOn = false
                    sendPeerOn = false
                    stopSending(false)
                }
            }
        }
        projectionCallback = callback
        mp.registerCallback(callback, Handler(Looper.getMainLooper()))
        return mp
    }

    /**
     * Switch the capture source without stopping the WebSocket or the send
     * flags.  This is shared by the phone UI, the PC remote control and hotkeys.
     */
    private fun applySourceMode(source: Int, remote: Boolean): Boolean {
        if (source !in AudioEngine.SOURCE_APP..AudioEngine.SOURCE_BOTH) return false
        if (source == sourceMode && engine != null) {
            publishState()
            return true
        }
        if (source != AudioEngine.SOURCE_MIC && projection == null) {
            RunState.addLog("切换内部声音需要先在手机上授权一次投屏/音频")
            ws?.sendStatus()
            return false
        }

        val wasRunning = engine != null
        try {
            engine?.stop()
        } catch (_: Exception) {
        }
        engine = null
        sourceMode = source
        ws?.sourceMode = source
        RunState.sourceMode = source
        RunState.hasProjection = projection != null

        if (wasRunning) {
            startForegroundCompat()
            val next = createEngine(source, if (source == AudioEngine.SOURCE_MIC) null else projection)
            engine = next
            try {
                next.start()
            } catch (e: Exception) {
                Log.e(TAG, "engine restart failed", e)
                RunState.addLog("切换音源失败：${e.message}")
                stopSending(false)
                return false
            }
            RunState.addLog(
                "音源已切换为“${sourceName(source)}”，发送已自动恢复" +
                    if (remote) "（来自电脑）" else ""
            )
        } else {
            RunState.addLog("音源已切换为“${sourceName(source)}”")
        }
        publishState()
        return true
    }

    private fun stopSending(toPeer: Boolean, keepProjection: Boolean = false) {
        if (toPeer) sendPeerOn = false else sendOn = false

        if (!sendOn && !sendPeerOn) {
            try {
                engine?.stop()
            } catch (_: Exception) {
            }
            engine = null

            if (!keepProjection) {
                val callback = projectionCallback
                projectionCallback = null
                try {
                    if (callback != null) projection?.unregisterCallback(callback)
                } catch (_: Exception) {
                }
                try {
                    projection?.stop()
                } catch (_: Exception) {
                }
                projection = null
            }

            ws?.sendEnabled = false
            ws?.sendPeerEnabled = false
            ws?.sendStatus()
            releaseLocks()
        }

        RunState.addLog(if (toPeer) "已停止发送给手机" else "已停止发送给电脑")
        publishState()
        stopIfIdle()
    }

    /* ---------------- shared pieces ---------------- */

    private fun applyAudioSettings(intent: Intent) {
        playEnabled = intent.getBooleanExtra(EXTRA_PLAY, playEnabled)
        volume = intent.getFloatExtra(EXTRA_VOLUME, volume)
        boost = intent.getBooleanExtra(EXTRA_BOOST, boost)
        micGain = intent.getFloatExtra(EXTRA_MIC_GAIN, micGain).coerceIn(0f, 5f)
        nrStrength = intent.getFloatExtra(EXTRA_NR, nrStrength).coerceIn(0f, 100f)
        engine?.let {
            it.micGain = micGain
            it.nrStrength = nrStrength
        }
        if (intent.hasExtra(EXTRA_PEER)) peerTarget = intent.getIntExtra(EXTRA_PEER, peerTarget)
        intent.getStringExtra(EXTRA_NAME)?.takeIf { it.isNotBlank() }?.let { deviceName = it }
        player?.setVolume(if (playEnabled) volume else 0f)
        player?.setBoost(boost)
        ws?.peerTarget = peerTarget
        ws?.sourceMode = sourceMode
    }

    private fun ensureClient(target: Connection): Boolean {
        ensurePeerHandler()
        val wsClient = ws
        if (wsClient != null && connection == target) {
            wsClient.sendEnabled = sendOn
            wsClient.sendPeerEnabled = sendPeerOn
            wsClient.receiveEnabled = receiveOn
            wsClient.receivePeerEnabled = receivePeerOn
            wsClient.peerTarget = peerTarget
            wsClient.sourceMode = sourceMode
            wsClient.sendStatus()
            return true
        }

        try {
            ws?.close()
        } catch (_: Exception) {
        }
        ws = null
        connection = target

        val client = WsClient(
            host = target.host,
            port = target.port,
            room = target.room,
            onState = { state ->
                RunState.addLog(state)
                updateNotification(state)
            },
            onAudio = { samples, sampleRate, channelCount, _ ->
                player?.write(samples, sampleRate, channelCount)
            },
            onPhones = { list ->
                peerHandler?.invoke(list)
            },
            deviceName = deviceName,
            deviceId = deviceId,
            onControl = { action, json ->
                Handler(Looper.getMainLooper()).post { handleControl(action, json) }
            },
        )
        client.sendEnabled = sendOn
        client.sendPeerEnabled = sendPeerOn
        client.receiveEnabled = receiveOn
        client.receivePeerEnabled = receivePeerOn
        client.peerTarget = peerTarget
        client.sourceMode = sourceMode
        ws = client
        client.connect()
        return true
    }

    private fun handleControl(action: String, json: org.json.JSONObject) {
        when (action) {
            "set-mode" -> {
                val source = json.optInt("source", sourceMode)
                applySourceMode(source, remote = true)
            }
            "set-send" -> {
                val on = json.optBoolean("on", false)
                if (on) {
                    if (engine == null) {
                        if (connection == null) {
                            RunState.addLog("远程开始发送失败：手机还没有连接电脑")
                            return
                        }
                        if (sourceMode != AudioEngine.SOURCE_MIC && projection == null) {
                            RunState.addLog("远程开始发送失败：需要手机先授权内部声音")
                            ws?.sendStatus()
                            return
                        }
                        // Set the flag before entering the foreground so the
                        // service type includes microphone / mediaProjection.
                        sendOn = true
                        startForegroundCompat()
                        val next = createEngine(
                            sourceMode,
                            if (sourceMode == AudioEngine.SOURCE_MIC) null else projection,
                        )
                        engine = next
                        try {
                            next.start()
                        } catch (e: Exception) {
                            RunState.addLog("远程开始发送失败：${e.message}")
                            sendOn = false
                            engine = null
                            publishState()
                            return
                        }
                        acquireLocks()
                    } else {
                        sendOn = true
                    }
                    clearRemoteKeepAlive()
                    RunState.addLog("电脑端已开启发送")
                    publishState()
                } else {
                    val willBeIdle = !sendPeerOn && !receiveOn && !receivePeerOn
                    if (willBeIdle) keepAliveForRemote()
                    // Remote stop keeps the MediaProjection token alive so a
                    // later remote start of internal audio does not need a new
                    // phone-side consent prompt. It is released by teardown,
                    // local stop, or the remote keep-alive timeout.
                    stopSending(false, keepProjection = true)
                    if (willBeIdle) {
                        RunState.status = "已停止（电脑可远程开启）"
                        updateNotification(RunState.status)
                    }
                }
            }
            "set-receive" -> {
                val on = json.optBoolean("on", false)
                if (on) {
                    if (connection == null) {
                        RunState.addLog("远程开启接收失败：手机还没有连接电脑")
                        return
                    }
                    if (player == null) player = AudioPlayer(if (playEnabled) volume else 0f, boost)
                    receiveOn = true
                    clearRemoteKeepAlive()
                    RunState.addLog("电脑端已开启接收")
                    publishState()
                } else {
                    val willBeIdle = !receivePeerOn && !sendOn && !sendPeerOn
                    if (willBeIdle) keepAliveForRemote()
                    stopReceiving(false)
                    if (willBeIdle) {
                        RunState.status = "已停止（电脑可远程开启）"
                        updateNotification(RunState.status)
                    }
                }
            }
        }
    }

    private var peerHandler: ((List<Pair<Int, String>>) -> Unit)? = null

    private fun ensurePeerHandler() {
        if (peerHandler != null) return
        try {
            peerHandler = { list -> MainActivity.instance?.onPeersChanged(list) }
        } catch (_: Exception) {
        }
    }

    private fun checkMicLevel(samples: ShortArray) {
        var peak = 0f
        for (s in samples) {
            val v = abs(s.toInt()) / 32768f
            if (v > peak) peak = v
        }
        if (peak > micPeak) micPeak = peak
        val now = SystemClock.elapsedRealtime()
        if (micLevelStartedAt == 0L) micLevelStartedAt = now
        if (!micLevelChecked && now - micLevelStartedAt >= 2500) {
            micLevelChecked = true
            if (micPeak < 0.001f) {
                RunState.addLog("麦克风没有检测到声音：请检查录音权限、是否被其他 App 占用，或关闭回声消除/降噪后重试")
            } else {
                val db = 20 * log10(micPeak.toDouble())
                RunState.addLog("麦克风电平 ${String.format(Locale.US, "%.1f", db)} dB")
            }
        }
    }

    private fun publishState() {
        val receiving = receiveOn || receivePeerOn
        if (receiving && player == null) {
            player = AudioPlayer(if (playEnabled) volume else 0f, boost)
        } else if (player != null) {
            player?.setVolume(if (receiving && playEnabled) volume else 0f)
            player?.setBoost(boost)
        }
        ws?.sendEnabled = sendOn
        ws?.sendPeerEnabled = sendPeerOn
        ws?.receiveEnabled = receiveOn
        ws?.receivePeerEnabled = receivePeerOn
        ws?.sourceMode = sourceMode

        RunState.sourceMode = sourceMode
        RunState.hasProjection = projection != null
        RunState.sendRunning = sendOn
        RunState.sendPeerRunning = sendPeerOn
        RunState.receiveRunning = receiveOn
        RunState.receivePeerRunning = receivePeerOn
        RunState.running = sendOn || sendPeerOn || receiving

        val parts = mutableListOf<String>()
        if (sendOn) parts.add("发给电脑")
        if (sendPeerOn) parts.add("发给手机")
        if (receiveOn) parts.add("收电脑")
        if (receivePeerOn) parts.add("收手机")
        val text = if (parts.isEmpty()) "已停止" else parts.joinToString(" · ")

        RunState.status = text
        updateNotification(text)
        ws?.sendStatus()
        stopIfIdle()
    }

    private fun clearRemoteKeepAlive() {
        remoteKeepAlive = false
        idleHandler.removeCallbacks(idleStop)
    }

    private fun keepAliveForRemote() {
        remoteKeepAlive = true
        idleHandler.removeCallbacks(idleStop)
        // If the PC page disappears, do not leave an idle foreground service forever.
        idleHandler.postDelayed(idleStop, 5 * 60 * 1000L)
    }

    private fun stopIfIdle() {
        if (sendOn || sendPeerOn || receiveOn || receivePeerOn || remoteKeepAlive) return
        stopSelf()
    }

    private fun sourceName(source: Int): String = when (source) {
        AudioEngine.SOURCE_MIC -> "麦克风"
        AudioEngine.SOURCE_BOTH -> "内部声音 + 麦克风"
        else -> "手机内部声音"
    }

    private fun fail(message: String) {
        RunState.addLog(message)
        RunState.status = message
        updateNotification(message)
        sendOn = false
        sendPeerOn = false
        receiveOn = false
        receivePeerOn = false
        RunState.sendRunning = false
        RunState.sendPeerRunning = false
        RunState.receiveRunning = false
        RunState.receivePeerRunning = false
        RunState.running = false
        stopSelf()
    }

    /** Same fgsType() always, so startForeground() can be called repeatedly. */
    private fun startForegroundCompat() {
        try {
            // Entering the foreground must be the first thing that happens after
            // startForegroundService(), and the type set must not change later.
            // On API 29/30 the plain (type-less) overload is the safest form.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                startForeground(NOTIF_ID, buildNotification("准备中…"), fgsType())
            } else {
                // Android 10/11: the type-less form is the safe path.
                startForeground(NOTIF_ID, buildNotification("准备中…"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed", e)
            RunState.addLog("前台服务启动失败：${e.message}")
        }
    }

    private fun fgsType(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        // The set must always be a subset of the manifest attribute
        // (mediaProjection|microphone|mediaPlayback), otherwise startForeground()
        // throws IllegalArgumentException and Android kills the service 8s later.
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (sendOn || sendPeerOn) {
            // Microphone type without RECORD_AUDIO is rejected on Android 14+,
            // so only add what this session actually uses.
            if (sourceMode != AudioEngine.SOURCE_APP) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (sourceMode != AudioEngine.SOURCE_MIC) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            }
        }
        return type
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_audio)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, R.drawable.ic_stat_audio),
                    "停止",
                    stopIntent,
                ).build()
            )
            .build()
    }

    private fun updateNotification(text: String) {
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIF_ID, buildNotification(text))
        } catch (_: Exception) {
        }
    }

    private fun acquireLocks() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LanAudio::capture").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "wake lock failed", e)
        }

        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "LanAudio::wifi").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "wifi lock failed", e)
        }
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
        }
        wifiLock = null
    }

    private fun teardown() {
        if (tearingDown) return
        tearingDown = true

        sendOn = false
        receiveOn = false

        try {
            engine?.stop()
        } catch (_: Exception) {
        }
        engine = null

        try {
            player?.release()
        } catch (_: Exception) {
        }
        player = null

        try {
            ws?.close()
        } catch (_: Exception) {
        }
        ws = null
        connection = null

        val callback = projectionCallback
        projectionCallback = null
        try {
            if (callback != null) projection?.unregisterCallback(callback)
        } catch (_: Exception) {
        }
        try {
            projection?.stop()
        } catch (_: Exception) {
        }
        projection = null

        releaseLocks()
        RunState.sendRunning = false
        RunState.receiveRunning = false
        RunState.running = false
        RunState.hasProjection = false
    }

    override fun onDestroy() {
        RunState.status = "已停止"
        clearRemoteKeepAlive()
        teardown()
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
