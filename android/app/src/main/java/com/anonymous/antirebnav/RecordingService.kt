package com.anonymous.antirebnav

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Foreground service на час запису (TASK-016): тримає процес живим із вимкненим
 * екраном / іншим застосунком на екрані, показує постійне сповіщення і тримає
 * PARTIAL_WAKE_LOCK. Запускається/зупиняється з JS через SensorModule.
 */
class RecordingService : Service() {

    private val TAG = "RecordingService"
    private val CHANNEL_ID = "recording"
    private val NOTIFICATION_ID = 4101
    private val WAKE_LOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000 // страховка від «вічного» wake lock

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, foregroundType())
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Напр. SecurityException на Android 14+, якщо немає дозволів для обраного типу
            Log.e(TAG, "startForeground не вдався: ", e)
            stopSelf()
            return START_NOT_STICKY
        }

        if (wakeLock == null) {
            try {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AntiRebNav:Recording")
                wl.setReferenceCounted(false)
                wl.acquire(WAKE_LOCK_TIMEOUT_MS)
                wakeLock = wl
            } catch (e: Exception) {
                Log.e(TAG, "WakeLock не отримано: ", e)
            }
        }
        // Запис не відновлюється автоматично після вбивства процесу: стан у JS
        return START_NOT_STICKY
    }

    // Типи беремо лише ті, для яких є runtime-дозволи (інакше SecurityException на Android 14+)
    private fun foregroundType(): Int {
        var type = 0
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        val btGranted = if (Build.VERSION.SDK_INT >= 31) {
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        if (btGranted) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        }
        return type
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "Запис", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Постійне сповіщення під час запису заїзду"
            nm.createNotificationChannel(channel)
        }

        val openApp = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = if (openApp != null) {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            PendingIntent.getActivity(this, 0, openApp, flags)
        } else {
            null
        }

        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setContentTitle("Anti-REB Nav: йде запис")
            .setContentText("Датчики, OBD і GNSS працюють у фоні")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
        if (contentIntent != null) builder.setContentIntent(contentIntent)
        return builder.build()
    }

    override fun onDestroy() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            Log.e(TAG, "Помилка звільнення WakeLock: ", e)
        }
        wakeLock = null
        super.onDestroy()
    }
}
