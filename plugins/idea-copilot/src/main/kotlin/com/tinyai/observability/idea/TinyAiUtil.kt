package com.tinyai.observability.idea

import java.net.InetAddress
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

fun sha256Short(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }.take(32)
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
