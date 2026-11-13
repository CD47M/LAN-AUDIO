package com.carl.lanaudio

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView

class MainActivity : Activity() {
    companion object {
        private const val REQ_PERMISSIONS = 100
        private const val REQ_PROJECTION = 200
        private const val PREFS = "lanaudio"

        @Volatile
        var instance: MainActivity? = null
    }

    private lateinit var prefs: SharedPreferences

    private lateinit var tvStatus: TextView
    private lateinit var etHost: EditText
    private lateinit var etRoom: EditText
    private lateinit var btnDiscover: Button
    private lateinit var spinnerSource: Spinner
    private lateinit var spinnerRate: Spinner
    private lateinit var spinnerMicRate: Spinner
    private lateinit var spinnerChannels: Spinner
    private lateinit var spinnerPeer: Spinner
    private lateinit var swAec: CheckBox
    private lateinit var swNs: CheckBox
    private lateinit var swPlay: Switch
    private lateinit var swBoost: CheckBox
    private lateinit var seekVolume: SeekBar
    private lateinit var tvVolume: TextView
    private lateinit var seekMicGain: SeekBar
    private lateinit var tvMicGain: TextView
    private lateinit var seekNr: SeekBar
    private lateinit var tvNr: TextView
    private lateinit var btnNr0: Button
    private lateinit var btnNr25: Button
    private lateinit var btnNr60: Button
    private lateinit var btnNr100: Button
    private lateinit var btnSendStart: Button
    private lateinit var btnSendStop: Button
    private lateinit var btnPeerSendStart: Button
    private lateinit var btnPeerSendStop: Button
    private lateinit var btnRecvStart: Button
    private lateinit var btnRecvStop: Button
    private lateinit var btnPeerRecvStart: Button
    private lateinit var btnPeerRecvStop: Button
    private lateinit var tvLog: TextView
    private lateinit var logScroll: ScrollView

    private val handler = Handler(Looper.getMainLooper())
    private var lastLog = ""
    private var serverPort = 8080
    private var discovering = false
    private var pendingStart = false
    private var pendingToPeer = false
    private var pendingSourceChange = -1
    private var syncingSource = false

    private val uiTick = object : Runnable {
        override fun run() {
            if (!syncingSource && RunState.running &&
                spinnerSource.selectedItemPosition != RunState.sourceMode
            ) {
                syncingSource = true
                spinnerSource.setSelection(RunState.sourceMode)
                syncingSource = false
            }
            tvStatus.text = RunState.status
            val log = RunState.logText()
            if (log != lastLog) {
                lastLog = log
                tvLog.text = log
                logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
            }
            val running = RunState.running
            btnSendStart.isEnabled = !RunState.sendRunning
            btnSendStop.isEnabled = RunState.sendRunning
            btnPeerSendStart.isEnabled = !RunState.sendPeerRunning
            btnPeerSendStop.isEnabled = RunState.sendPeerRunning
            btnRecvStart.isEnabled = !RunState.receiveRunning
            btnRecvStop.isEnabled = RunState.receiveRunning
            btnPeerRecvStart.isEnabled = !RunState.receivePeerRunning
            btnPeerRecvStop.isEnabled = RunState.receivePeerRunning
            btnDiscover.isEnabled = !discovering
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        instance = this
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        tvStatus = findViewById(R.id.tvStatus)
        etHost = findViewById(R.id.etHost)
        etRoom = findViewById(R.id.etRoom)
        btnDiscover = findViewById(R.id.btnDiscover)
        spinnerSource = findViewById(R.id.spinnerSource)
        spinnerRate = findViewById(R.id.spinnerRate)
        spinnerMicRate = findViewById(R.id.spinnerMicRate)
        spinnerChannels = findViewById(R.id.spinnerChannels)
        spinnerPeer = findViewById(R.id.spinnerPeer)
        swAec = findViewById(R.id.swAec)
        swNs = findViewById(R.id.swNs)
        swPlay = findViewById(R.id.swPlay)
        swBoost = findViewById(R.id.swBoost)
        seekVolume = findViewById(R.id.seekVolume)
        tvVolume = findViewById(R.id.tvVolume)
        seekMicGain = findViewById(R.id.seekMicGain)
        tvMicGain = findViewById(R.id.tvMicGain)
        seekNr = findViewById(R.id.seekNr)
        tvNr = findViewById(R.id.tvNr)
        btnNr0 = findViewById(R.id.btnNr0)
        btnNr25 = findViewById(R.id.btnNr25)
        btnNr60 = findViewById(R.id.btnNr60)
        btnNr100 = findViewById(R.id.btnNr100)
        btnSendStart = findViewById(R.id.btnSendStart)
        btnSendStop = findViewById(R.id.btnSendStop)
        btnPeerSendStart = findViewById(R.id.btnPeerSendStart)
        btnPeerSendStop = findViewById(R.id.btnPeerSendStop)
        btnRecvStart = findViewById(R.id.btnRecvStart)
        btnRecvStop = findViewById(R.id.btnRecvStop)
        btnPeerRecvStart = findViewById(R.id.btnPeerRecvStart)
        btnPeerRecvStop = findViewById(R.id.btnPeerRecvStop)
        tvLog = findViewById(R.id.tvLog)
        logScroll = findViewById(R.id.logScroll)

        setupSpinner(spinnerSource, arrayOf("手机内部声音", "麦克风", "内部声音 + 麦克风"))
        setupSpinner(spinnerRate, arrayOf("48 kHz · 音乐", "24 kHz · 标准", "16 kHz · 语音"))
        setupSpinner(spinnerMicRate, arrayOf("24 kHz · 推荐", "48 kHz · 高音质", "16 kHz · 省流量"))
        setupSpinner(spinnerChannels, arrayOf("立体声", "单声道"))
        updatePeerSpinner(emptyList())

        loadPrefs()
        bindEvents()
        handler.post(uiTick)
    }

    private var peerList: List<Pair<Int, String>> = emptyList()

    private fun updatePeerSpinner(list: List<Pair<Int, String>>) {
        peerList = list
        val labels = mutableListOf("未选择目标手机")
        for ((pid, name) in list) labels.add("$name (#$pid)")
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerPeer.adapter = adapter
        val saved = prefs.getInt("peer", 0)
        spinnerPeer.setSelection(if (saved in labels.indices) saved else 0)
    }

    private fun selectedPeerId(): Int {
        val pos = spinnerPeer.selectedItemPosition
        return if (pos <= 0 || pos > peerList.size) 0 else peerList[pos - 1].first
    }

    private fun pushPeerTarget() {
        if (!RunState.running) return
        startService(Intent(this, CaptureService::class.java).apply {
            action = CaptureService.ACTION_SET_PEER
            putExtra(CaptureService.EXTRA_PEER, selectedPeerId())
        })
    }

    fun onPeersChanged(list: List<Pair<Int, String>>) {
        runOnUiThread { updatePeerSpinner(list) }
    }

    private fun setupSpinner(spinner: Spinner, items: Array<String>) {
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, items)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinner.adapter = adapter
    }

    private fun loadPrefs() {
        etHost.setText(prefs.getString("host", ""))
        serverPort = prefs.getInt("port", 8080)
        etRoom.setText(prefs.getString("room", "8888"))
        spinnerSource.setSelection(prefs.getInt("source", 0))
        spinnerRate.setSelection(prefs.getInt("rate", 0))
        spinnerMicRate.setSelection(prefs.getInt("micRate", 0))
        spinnerChannels.setSelection(prefs.getInt("channels", 0))
        swAec.isChecked = prefs.getBoolean("aec", true)
        swNs.isChecked = prefs.getBoolean("ns", true)
        swPlay.isChecked = prefs.getBoolean("play", true)
        swBoost.isChecked = prefs.getBoolean("boost", false)
        seekVolume.progress = prefs.getInt("volume", 100)
        tvVolume.text = "${seekVolume.progress}%"
        seekMicGain.progress = prefs.getInt("micGain", 100)
        tvMicGain.text = "${seekMicGain.progress}%"
        seekNr.progress = prefs.getInt("nr", 60)
        tvNr.text = "${seekNr.progress}"
        if (!RunState.running && RunState.status == "未运行") {
            RunState.addLog("就绪。可以只接收电脑声音，也可以只发送手机声音。")
        }
    }

    private fun savePrefs() {
        prefs.edit()
            .putString("host", etHost.text.toString().trim())
            .putInt("port", serverPort)
            .putString("room", etRoom.text.toString().trim())
            .putInt("source", spinnerSource.selectedItemPosition)
            .putInt("rate", spinnerRate.selectedItemPosition)
            .putInt("micRate", spinnerMicRate.selectedItemPosition)
            .putInt("channels", spinnerChannels.selectedItemPosition)
            .putBoolean("aec", swAec.isChecked)
            .putBoolean("ns", swNs.isChecked)
            .putBoolean("play", swPlay.isChecked)
            .putBoolean("boost", swBoost.isChecked)
            .putInt("volume", seekVolume.progress)
            .putInt("micGain", seekMicGain.progress)
            .putInt("nr", seekNr.progress)
            .putInt("peer", spinnerPeer.selectedItemPosition)
            .apply()
    }

    private fun pushAudioSettings() {
        if (!RunState.running) return
        startService(Intent(this, CaptureService::class.java).apply {
            action = CaptureService.ACTION_SET_AUDIO
            putExtra(CaptureService.EXTRA_PLAY, swPlay.isChecked)
            putExtra(CaptureService.EXTRA_VOLUME, seekVolume.progress / 100f)
            putExtra(CaptureService.EXTRA_BOOST, swBoost.isChecked)
            putExtra(CaptureService.EXTRA_MIC_GAIN, seekMicGain.progress / 100f)
            putExtra(CaptureService.EXTRA_NR, seekNr.progress.toFloat())
        })
    }

    private fun bindEvents() {
        seekVolume.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                tvVolume.text = "$progress%"
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar?) {
                savePrefs()
                pushAudioSettings()
            }
        })

        seekMicGain.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                tvMicGain.text = "$progress%"
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar?) {
                savePrefs()
                pushAudioSettings()
                if (RunState.running) {
                    RunState.addLog("麦克风发送增益：${seekMicGain.progress}%")
                }
            }
        })

        seekNr.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                tvNr.text = "$progress"
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar?) {
                savePrefs()
                pushAudioSettings()
                if (RunState.running) {
                    RunState.addLog("麦克风降噪：${seekNr.progress}（${nrLabel(seekNr.progress)}）")
                }
            }
        })

        fun applyNrPreset(value: Int) {
            seekNr.progress = value
            tvNr.text = "$value"
            savePrefs()
            pushAudioSettings()
            if (RunState.running) {
                RunState.addLog("麦克风降噪预设：${nrLabel(value)}（$value）")
            }
        }
        btnNr0.setOnClickListener { applyNrPreset(0) }
        btnNr25.setOnClickListener { applyNrPreset(25) }
        btnNr60.setOnClickListener { applyNrPreset(60) }
        btnNr100.setOnClickListener { applyNrPreset(100) }

        btnDiscover.setOnClickListener { discoverOnly() }
        btnSendStart.setOnClickListener { beginSend(false) }
        btnSendStop.setOnClickListener {
            savePrefs()
            startService(Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_SEND_STOP
            })
            RunState.status = "正在停止发送…"
        }
        btnPeerSendStart.setOnClickListener { beginSend(true) }
        btnPeerSendStop.setOnClickListener {
            savePrefs()
            startService(Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_PEER_SEND_STOP
            })
            RunState.status = "正在停止发送给手机…"
        }
        btnRecvStart.setOnClickListener { beginReceive(false) }
        btnRecvStop.setOnClickListener {
            savePrefs()
            startService(Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_RECEIVE_STOP
            })
            RunState.status = "正在停止接收…"
        }
        btnPeerRecvStart.setOnClickListener { beginReceive(true) }
        btnPeerRecvStop.setOnClickListener {
            savePrefs()
            startService(Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_PEER_RECEIVE_STOP
            })
            RunState.status = "正在停止接收手机声音…"
        }

        val sourceNames = arrayOf("手机内部声音", "麦克风", "内部声音 + 麦克风")
        var lastSource = spinnerSource.selectedItemPosition
        spinnerSource.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (syncingSource) {
                    lastSource = position
                    return
                }
                // A remote control may update RunState and the spinner; that is
                // not a user action and must not restart the capture engine.
                if (position == RunState.sourceMode) {
                    lastSource = position
                    return
                }
                if (position == lastSource) return
                lastSource = position
                savePrefs()
                if (!RunState.sendRunning && !RunState.sendPeerRunning) {
                    RunState.addLog("音源已切换为“${sourceNames[position]}”")
                    return
                }
                val needsProjection = position != AudioEngine.SOURCE_MIC
                if (needsProjection && !RunState.hasProjection) {
                    pendingSourceChange = position
                    RunState.status = "等待系统授权…"
                    launchProjection()
                    return
                }
                startService(Intent(this@MainActivity, CaptureService::class.java).apply {
                    action = CaptureService.ACTION_SET_SOURCE
                    putExtra(CaptureService.EXTRA_SOURCE, position)
                })
                RunState.status = "正在切换音源…"
                RunState.addLog("音源已切换为“${sourceNames[position]}”，正在恢复发送")
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }

        swBoost.setOnCheckedChangeListener { _, checked ->
            savePrefs()
            pushAudioSettings()
            if (RunState.running) {
                RunState.addLog(if (checked) "已开启 2× 音量增强" else "已关闭 2× 音量增强")
            }
        }

        swPlay.setOnCheckedChangeListener { _, _ ->
            savePrefs()
            pushAudioSettings()
        }

        spinnerPeer.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                savePrefs()
                pushPeerTarget()
                if (peerList.isNotEmpty() && position > 0 && position <= peerList.size) {
                    RunState.addLog("手机互传目标：${peerList[position - 1].second}")
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
    }

    private fun nrLabel(value: Int): String = when {
        value <= 0 -> "关闭"
        value <= 25 -> "普通"
        value <= 60 -> "强"
        else -> "超强"
    }

    private fun discoverOnly() {
        if (discovering) return
        discovering = true
        btnDiscover.isEnabled = false
        RunState.status = "正在搜索电脑…"

        Thread {
            val found = Discovery.discover(1800)
            runOnUiThread {
                discovering = false
                btnDiscover.isEnabled = true
                if (found == null) {
                    RunState.status = "未发现电脑，请手动输入 IP"
                    RunState.addLog("自动发现失败，请确认电脑服务已启动并允许防火墙")
                    return@runOnUiThread
                }
                etHost.setText(found.host)
                etRoom.setText(found.room)
                serverPort = found.port
                RunState.status = "已发现 ${found.host}:${found.port}"
                RunState.addLog("发现电脑 ${found.host}:${found.port}，房间 ${found.room}")
            }
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun beginStart() {
        beginReceive(false)
    }

    private fun beginReceive(fromPeer: Boolean) {
        savePrefs()
        val host = etHost.text.toString().trim()
        if (host.isEmpty()) {
            autoDiscoverThen {
                startReceiveService(fromPeer)
            }
            return
        }
        startReceiveService(fromPeer)
    }

    private fun startReceiveService(fromPeer: Boolean) {
        val host = etHost.text.toString().trim()
        if (host.isEmpty()) {
            RunState.status = "请先填写或发现电脑地址"
            return
        }
        savePrefs()

        val intent = Intent(this, CaptureService::class.java).apply {
            action = if (fromPeer) CaptureService.ACTION_PEER_RECEIVE_START
                     else CaptureService.ACTION_RECEIVE_START
            putExtra(CaptureService.EXTRA_HOST, host)
            putExtra(CaptureService.EXTRA_PORT, serverPort)
            putExtra(CaptureService.EXTRA_ROOM, etRoom.text.toString().trim().ifBlank { "8888" })
            putExtra(CaptureService.EXTRA_PLAY, swPlay.isChecked)
            putExtra(CaptureService.EXTRA_BOOST, swBoost.isChecked)
            putExtra(CaptureService.EXTRA_VOLUME, seekVolume.progress / 100f)
            putExtra(CaptureService.EXTRA_PEER, selectedPeerId())
            putExtra(CaptureService.EXTRA_NAME, Build.MODEL)
        }
        startForegroundService(intent)
        RunState.status = if (fromPeer) "正在接收手机声音…" else "正在连接电脑…"
        RunState.addLog(
            if (fromPeer) "开始接收手机声音：$host:$serverPort"
            else "开始接收：$host:$serverPort"
        )
    }

    private fun beginSend(toPeer: Boolean) {
        if (toPeer) {
            if (RunState.sendPeerRunning) return
            if (selectedPeerId() == 0) {
                RunState.status = "请先选择目标手机"
                RunState.addLog("手机互传：请先在下拉框里选择另一台手机")
                return
            }
        } else {
            if (RunState.sendRunning) return
        }
        savePrefs()

        // Capture is already running for the other target: just switch it on.
        if (RunState.sendRunning || RunState.sendPeerRunning) {
            startService(Intent(this, CaptureService::class.java).apply {
                action = if (toPeer) CaptureService.ACTION_PEER_SEND_START
                         else CaptureService.ACTION_SEND_START
                putExtra(CaptureService.EXTRA_PEER, selectedPeerId())
            })
            return
        }

        pendingToPeer = toPeer
        val host = etHost.text.toString().trim()
        if (host.isEmpty()) {
            autoDiscoverThen { continueSend() }
            return
        }
        continueSend()
    }

    private fun autoDiscoverThen(next: () -> Unit) {
        if (discovering) return
        discovering = true
        btnDiscover.isEnabled = false
        RunState.status = "正在自动发现电脑…"

        Thread {
            val found = Discovery.discover(1800)
            runOnUiThread {
                discovering = false
                btnDiscover.isEnabled = true
                if (found == null) {
                    RunState.status = "未发现电脑，请手动输入 IP"
                    RunState.addLog("自动发现失败，请确认电脑服务已启动并允许防火墙")
                    return@runOnUiThread
                }
                etHost.setText(found.host)
                etRoom.setText(found.room)
                serverPort = found.port
                RunState.addLog("发现电脑 ${found.host}:${found.port}，房间 ${found.room}")
                next()
            }
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun continueSend() {
        if (!ensurePermissions()) return
        if (spinnerSource.selectedItemPosition == AudioEngine.SOURCE_MIC) {
            // Microphone-only mode does not need MediaProjection at all.
            startSendService(RESULT_OK, null)
        } else {
            launchProjection()
        }
    }

    private fun ensurePermissions(): Boolean {
        val missing = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.RECORD_AUDIO)
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (missing.isNotEmpty()) {
            pendingStart = true
            requestPermissions(missing.toTypedArray(), REQ_PERMISSIONS)
            return false
        }
        return true
    }

    private fun launchProjection() {
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        RunState.status = "等待系统授权…"
        startActivityForResult(manager.createScreenCaptureIntent(), REQ_PROJECTION)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS) return

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            if (pendingStart) {
                pendingStart = false
                continueSend()
            }
        } else {
            pendingStart = false
            RunState.status = "需要录音权限才能采集声音"
            RunState.addLog("录音权限被拒绝")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return

        if (resultCode != RESULT_OK || data == null) {
            RunState.status = "已取消授权"
            RunState.addLog("用户取消了投屏/音频授权")
            if (pendingSourceChange >= 0) {
                pendingSourceChange = -1
                syncingSource = true
                spinnerSource.setSelection(RunState.sourceMode)
                syncingSource = false
            }
            return
        }

        if (pendingSourceChange >= 0) {
            val source = pendingSourceChange
            pendingSourceChange = -1
            startService(Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_SET_SOURCE
                putExtra(CaptureService.EXTRA_SOURCE, source)
                putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
                @Suppress("DEPRECATION")
                putExtra(CaptureService.EXTRA_DATA, data)
            })
            RunState.status = "正在切换音源…"
            return
        }

        startSendService(resultCode, data)
    }

    private fun startSendService(resultCode: Int, data: Intent?) {
        val host = etHost.text.toString().trim()
        val room = etRoom.text.toString().trim().ifBlank { "8888" }
        if (host.isEmpty()) {
            RunState.status = "请先填写或发现电脑地址"
            return
        }
        savePrefs()

        val source = spinnerSource.selectedItemPosition
        val rate = when (spinnerRate.selectedItemPosition) {
            1 -> 24000
            2 -> 16000
            else -> 48000
        }
        val micRate = when (spinnerMicRate.selectedItemPosition) {
            1 -> 48000
            2 -> 16000
            else -> 24000
        }
        val channels = if (spinnerChannels.selectedItemPosition == 1) 1 else 2

        val intent = Intent(this, CaptureService::class.java).apply {
            action = if (pendingToPeer) CaptureService.ACTION_PEER_SEND_START
                     else CaptureService.ACTION_SEND_START
            putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
            if (data != null) putExtra(CaptureService.EXTRA_DATA, data)
            putExtra(CaptureService.EXTRA_HOST, host)
            putExtra(CaptureService.EXTRA_PORT, serverPort)
            putExtra(CaptureService.EXTRA_ROOM, room)
            putExtra(CaptureService.EXTRA_SOURCE, source)
            putExtra(CaptureService.EXTRA_RATE, rate)
            putExtra(CaptureService.EXTRA_MIC_RATE, micRate)
            putExtra(CaptureService.EXTRA_CHANNELS, channels)
            putExtra(CaptureService.EXTRA_AEC, swAec.isChecked)
            putExtra(CaptureService.EXTRA_NS, swNs.isChecked)
            putExtra(CaptureService.EXTRA_PLAY, swPlay.isChecked)
            putExtra(CaptureService.EXTRA_BOOST, swBoost.isChecked)
            putExtra(CaptureService.EXTRA_VOLUME, seekVolume.progress / 100f)
            putExtra(CaptureService.EXTRA_MIC_GAIN, seekMicGain.progress / 100f)
            putExtra(CaptureService.EXTRA_NR, seekNr.progress.toFloat())
            putExtra(CaptureService.EXTRA_PEER, selectedPeerId())
            putExtra(CaptureService.EXTRA_NAME, Build.MODEL)
        }

        startForegroundService(intent)
        val targetLabel = if (pendingToPeer) "另一台手机" else "电脑"
        RunState.status = "正在启动发送…"
        RunState.addLog(
            "开始发送到$targetLabel，连接 $host:$serverPort 房间 $room，" +
                "音源：${if (source == 1) "麦克风" else if (source == 2) "内部声音 + 麦克风" else "内部声音"}"
        )
        pendingToPeer = false
    }

    override fun onPause() {
        super.onPause()
        savePrefs()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
