package com.carl.lanaudio

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

class WsClient(
    private val host: String,
    private val port: Int,
    private val room: String,
    private val onState: (String) -> Unit,
    private val onAudio: (ShortArray, Int, Int, Int) -> Unit,
    private val onEvent: (String) -> Unit = {},
    private var deviceName: String = "Android",
    private var deviceId: String = "",
    private val onPhones: (List<Pair<Int, String>>) -> Unit = {},
    private val onControl: (String, org.json.JSONObject) -> Unit = { _, _ -> },
) {
    @Volatile
    var sendEnabled: Boolean = false

    @Volatile
    var sendPeerEnabled: Boolean = false

    @Volatile
    var receiveEnabled: Boolean = true

    @Volatile
    var receivePeerEnabled: Boolean = false

    @Volatile
    var peerTarget: Int = 0

    /** 0 = app, 1 = mic, 2 = both; reported to the PC so it can show the current mode. */
    @Volatile
    var sourceMode: Int = 0

    @Volatile
    var clientDrops: Int = 0

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var closed = false

    @Volatile
    private var reconnectScheduled = false

    private val sendQueue = ArrayBlockingQueue<ByteArray>(60)
    private var senderThread: Thread? = null

    fun connect() {
        if (closed) return
        reconnectScheduled = false
        val url = "ws://$host:$port/ws?room=$room&role=phone"
        onState("正在连接 $host:$port …")

        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onState("已连接电脑，等待音频")
                try {
                    webSocket.send(buildHello())
                } catch (_: Exception) {
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                handlePcm(bytes.toByteArray())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleText(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket === webSocket) socket = null
                if (!closed) {
                    onState("连接已关闭（$code）")
                    scheduleReconnect()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket === webSocket) socket = null
                if (!closed) {
                    onState("连接失败：${t.message ?: "网络错误"}")
                    scheduleReconnect()
                }
            }
        })

        startSender()
    }

    private fun buildHello(): String {
        val safeName = deviceName.replace("\\", "\\\\").replace("\"", "\\\"")
        val safeId = deviceId.replace("\\", "\\\\").replace("\"", "\\\"")
        return """{"type":"hello","info":{"name":"$safeName","deviceId":"$safeId","send":$sendEnabled,"receive":$receiveEnabled,"sendPeer":$sendPeerEnabled,"receivePeer":$receivePeerEnabled,"micSplit":true,"mode":$sourceMode,"drops":$clientDrops,"ver":"1.4"}}"""
    }

    fun sendStatus() {
        val ws = socket ?: return
        try {
            ws.send(buildHello())
        } catch (_: Exception) {
        }
    }

    private fun scheduleReconnect() {
        if (closed || reconnectScheduled) return
        reconnectScheduled = true
        Thread {
            try {
                Thread.sleep(2000)
            } catch (_: InterruptedException) {
                return@Thread
            }
            if (!closed) connect()
        }.also {
            it.isDaemon = true
            it.name = "ws-reconnect"
            it.start()
        }
    }

    private fun startSender() {
        if (senderThread?.isAlive == true) return
        senderThread = Thread {
            while (!closed) {
                val data = try {
                    sendQueue.poll(200, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    break
                }
                if (data == null) continue
                val ws = socket ?: continue
                try {
                    ws.send(ByteString.of(*data))
                } catch (_: Exception) {
                    // next frame will be dropped / reconnect will happen
                }
            }
        }.also {
            it.isDaemon = true
            it.name = "ws-sender"
            it.start()
        }
    }

    fun sendAudio(samples: ShortArray, sampleRate: Int, channels: Int, target: Int, frameType: Int = 1) {
        if (closed) return
        if (target == 0) {
            if (!sendEnabled) return
        } else {
            if (!sendPeerEnabled) return
        }
        val rateCode = when (sampleRate) {
            16000 -> 1
            24000 -> 2
            else -> 3
        }
        val buffer = ByteBuffer.allocate(5 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put(target.toByte())   // 0 = PC, 1..255 = another phone
        buffer.put(frameType.toByte()) // 1 = app/system audio, 2 = microphone only
        buffer.put(rateCode.toByte())
        buffer.put(channels.toByte())
        buffer.put(0)
        for (s in samples) buffer.putShort(s)

        val bytes = buffer.array()
        if (!sendQueue.offer(bytes)) {
            // Queue full (network stalled).  Dropping the NEWEST frame keeps the
            // already-queued audio contiguous; dropping the oldest punched a
            // hole in the timeline, which was audible as a click/burst.
            clientDrops++
            if (clientDrops == 1 || clientDrops % 100 == 0) onEvent("发送队列丢帧 $clientDrops")
        }
    }

    private fun handleText(text: String) {
        try {
            val json = org.json.JSONObject(text)
            when (json.optString("type")) {
                "phones" -> {
                    val arr = json.optJSONArray("phones") ?: return
                    val out = mutableListOf<Pair<Int, String>>()
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        val pid = o.optString("id").toIntOrNull() ?: continue
                        out.add(pid to o.optString("name", "Android"))
                    }
                    onPhones(out)
                }
                "phone-info" -> {
                    val pid = json.optString("id").toIntOrNull()
                    val info = json.optJSONObject("info")
                    if (pid != null) {
                        onEvent("phone-info:${pid}:${info?.optString("name") ?: "Android"}")
                    }
                }
                "peer" -> {
                    val connected = json.optBoolean("connected")
                    onEvent("peer:${json.optString("role")}:$connected")
                }
                "welcome" -> {
                    onEvent("welcome")
                }
                "control" -> {
                    onControl(json.optString("action"), json)
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun handlePcm(bytes: ByteArray) {
        // The server always prefixes a 1-byte source id: 0 = PC, >0 = another phone.
        if (bytes.size < 6) return
        val from = bytes[0].toInt() and 0xFF
        val fromPc = from == 0
        if (fromPc && !receiveEnabled) return
        if (!fromPc && !receivePeerEnabled) return

        val body = bytes.copyOfRange(1, bytes.size)
        if (body.size < 5) return
        val frameType = body[0].toInt()
        if (frameType != 1 && frameType != 2) return
        val sampleRate = when (body[1].toInt()) {
            1 -> 16000
            2 -> 24000
            else -> 48000
        }
        val channels = if (body[2].toInt() == 2) 2 else 1

        val view = ByteBuffer.wrap(body, 4, body.size - 4).order(ByteOrder.LITTLE_ENDIAN)
        val shorts = view.asShortBuffer()
        val samples = ShortArray(shorts.remaining())
        shorts.get(samples)

        try {
            onAudio(samples, sampleRate, channels, if (fromPc) 0 else from)
        } catch (_: Exception) {
        }
    }

    fun close() {
        closed = true
        reconnectScheduled = true
        val ws = socket
        socket = null
        try {
            ws?.close(1000, "bye")
        } catch (_: Exception) {
        }
        sendQueue.clear()
        try {
            client.dispatcher.executorService.shutdown()
        } catch (_: Exception) {
        }
    }
}
