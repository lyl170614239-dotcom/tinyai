package com.tinyai.observability.idea

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@Service(Service.Level.APP)
@State(name = "TinyAiObservabilitySettings", storages = [Storage("tinyai-observability.xml")])
class TinyAiSettings : PersistentStateComponent<TinyAiSettings.StateData> {
    data class StateData(
        var collectorUrl: String = DEFAULT_COLLECTOR_URL,
        var token: String = "",
        var userName: String = "",
        var userId: String = "",
        var team: String = "",
        var extraLogRoots: String = "",
        var autoCaptureCopilotLogs: Boolean = true,
        var captureHistoryOnFirstScan: Boolean = true,
        var scanIntervalSeconds: Int = 30,
        var cursors: MutableMap<String, Long> = mutableMapOf(),
        var turnCaptureStates: MutableMap<String, TinyAiTurnCaptureState> = mutableMapOf(),
        var lastScanDiagnostics: TinyAiScanDiagnostics = TinyAiScanDiagnostics()
    )

    private var stateData = StateData()

    override fun getState(): StateData = stateData

    override fun loadState(state: StateData) {
        stateData = state
    }

    fun identity(): TinyAiIdentity {
        val machine = localMachineName()
        val name = cleanIdentity(stateData.userName) ?: System.getProperty("user.name") ?: "unknown"
        val userId = cleanIdentity(stateData.userId) ?: name

        return TinyAiIdentity(
            username = name,
            userId = userId,
            userDisplayName = name,
            team = cleanIdentity(stateData.team),
            machineId = machine,
            hostHash = sha256Short(machine)
        )
    }

    fun normalizedCollectorUrl(): String = stateData.collectorUrl.trim().ifEmpty { DEFAULT_COLLECTOR_URL }.trimEnd('/')

    companion object {
        fun getInstance(): TinyAiSettings = service()
    }
}
