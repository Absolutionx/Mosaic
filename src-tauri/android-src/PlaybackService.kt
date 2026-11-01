// Mosaic's background playback service (Android). build-android.yml copies this next to MainActivity.kt and
// puts MainActivity's package line on top, so it has no package line of its own.
//
// Background audio (the player's Options, "When locked" or "Always"): while a stream plays with it on,
// MainActivity runs this service. A foreground service with its notification is how Android lets an app keep
// playing with the screen off, and the wake lock keeps the phone's processor running for the stream (the
// screen itself still turns off). It stops when the stream stops or Background audio is set back to Never.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class PlaybackService : Service() {
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra("title")?.takeIf { it.isNotBlank() } ?: "Mosaic"
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Playing in the background", NotificationManager.IMPORTANCE_LOW)
            )
        }
        // a tap on the notification brings Mosaic back
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
            else @Suppress("DEPRECATION") Notification.Builder(this)
        val notification = builder
            .setContentTitle(title)
            .setContentText("Playing in Mosaic")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (wake == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mosaic:playback").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "mosaic_playback"
        const val NOTIFICATION_ID = 4101
    }
}
