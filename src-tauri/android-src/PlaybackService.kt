// Mosaic's background playback service (Android). build-android.yml copies this next to MainActivity.kt and
// puts MainActivity's package line on top, so it has no package line of its own.
//
// Background audio (the player's Options, "When locked" or "Always"): while a stream plays with it on,
// MainActivity runs this service. A foreground service with its notification is how Android lets an app keep
// playing with the screen off, and the wake lock keeps the phone's processor running for the stream (the
// screen itself still turns off). It stops when the stream stops or Background audio is set back to Never.
// The notification is a media one with a media session, like a music app's: the phone shows it as a player on the
// lock screen and at the top of the notification shade (a plain quiet notification can be hidden in both).

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class PlaybackService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var session: MediaSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra("title")?.takeIf { it.isNotBlank() } ?: "Mosaic"
        MosaicLog.add(this, "service: starting for $title (notifications allowed: ${manager().areNotificationsEnabled()})")
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
        val media = session ?: MediaSession(this, "Mosaic").also { session = it }
        media.setSessionActivity(open)
        media.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Live on Mosaic")
                .build()
        )
        media.setPlaybackState(
            PlaybackState.Builder()
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build()
        )
        media.isActive = true
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
            else @Suppress("DEPRECATION") Notification.Builder(this)
        val notification = builder
            .setContentTitle(title)
            .setContentText("Playing in Mosaic")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setStyle(Notification.MediaStyle().setMediaSession(media.sessionToken))
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            val channel = if (Build.VERSION.SDK_INT >= 26) manager.getNotificationChannel(CHANNEL)?.importance?.toString() ?: "missing" else "n/a"
            MosaicLog.add(this, "service: in the foreground with its media notification (channel importance $channel)")
        } catch (e: Exception) {
            MosaicLog.add(this, "service: Android refused the foreground: $e")
            stopSelf()
            return START_NOT_STICKY
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
        MosaicLog.add(this, "service: stopped")
        session?.let { it.isActive = false; it.release() }
        session = null
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        super.onDestroy()
    }

    private fun manager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        const val CHANNEL = "mosaic_playback"
        const val NOTIFICATION_ID = 4101
    }
}
