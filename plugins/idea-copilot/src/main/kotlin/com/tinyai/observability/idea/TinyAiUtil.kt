package com.tinyai.observability.idea

import java.net.InetAddress
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

fun sha256(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
}

fun sha256Short(value: String): String = sha256(value).take(32)

fun textHash(value: String): String = sha256(value)

fun copilotClientId(identity: TinyAiIdentity): String =
    sha256Short("copilot:${identity.userId}:${identity.machineId}")

fun copilotTurnEventId(clientId: String, sessionId: String, requestId: String, responseId: String): String =
    sha256Short("copilot:turn:$clientId:$sessionId:$requestId:$responseId")

fun isCollectorUploadAllowedForUrl(baseUrl: String, token: String): Boolean {
    val uri = runCatching { URI.create(baseUrl.trim()) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase() ?: return false

    if (scheme == "https") return token.trim().isNotEmpty()
    if (scheme != "http") return false

    val host = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
    if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true

    val labels = host.split(".")
    if (labels.size != 4) return false
    val octets = labels.map { label -> label.toIntOrNull() ?: return false }
    if (octets.any { it !in 0..255 }) return false

    return when {
        octets[0] == 10 -> true
        octets[0] == 192 && octets[1] == 168 -> true
        octets[0] == 172 && octets[1] in 16..31 -> true
        else -> false
    }
}

fun assertCollectorUploadAllowed(baseUrl: String, token: String) {
    if (!isCollectorUploadAllowedForUrl(baseUrl, token)) {
        throw IllegalArgumentException("collector upload blocked: public collector requires HTTPS with a bearer token")
    }
}

fun nowIso(): String = Instant.now().toString()

fun stableEventId(seed: String): String = sha256Short(seed)

fun randomEventId(): String = UUID.randomUUID().toString()

fun localMachineName(): String = runCatching {
    InetAddress.getLocalHost().hostName
}.getOrDefault("local")

fun cleanIdentity(value: String?): String? {
    val cleaned = value?.trim()
    return cleaned?.takeIf { it.isNotEmpty() && it.lowercase() !in setOf("unknown", "null", "none", "user") }
}
