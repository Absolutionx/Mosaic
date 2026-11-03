// Mosaic's background playback service (Android). build-android.yml copies this next to MainActivity.kt and
// puts MainActivity's package line on top, so it has no package line of its own.
//
// Background audio (the player's Options, "When locked" or "Always"): while a stream is open with it on,
// MainActivity runs this service. A foreground service with its notification is how Android lets an app keep
// playing with the screen off, and the wake lock keeps the phone's processor running for the stream while it
// plays (the screen itself still turns off). It stops when the stream is closed or Background audio is set back
// to Never.
// The notification is a media one with a media session, like a music app's: the phone shows it as a player on the
// lock screen and at the top of the notification shade, with the stream's picture and a play / pause button. The
// button (and the phone's own media controls) go to MainActivity through onMediaButton, which pauses or plays the
// stream in the web view; the web view then reports the new state back here (mosaicSetBackground).

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.net.HttpURLConnection
import java.net.URL

class PlaybackService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var session: MediaSession? = null
    private var title = "Mosaic"
    private var paused = false
    private var artUrl = ""
    private var art: Bitmap? = null
    private var foreground = false
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // the notification's play / pause button
        when (intent?.action) {
            ACTION_PLAY -> { onMediaButton?.invoke(true); return START_NOT_STICKY }
            ACTION_PAUSE -> { onMediaButton?.invoke(false); return START_NOT_STICKY }
        }
        // Mosaic's window is gone (swiped away from recent apps): a late update from the closing app mustn't bring
        // the notification back with nothing playing behind it
        if (!appOnScreenOrInRecents()) {
            MosaicLog.add(this, "service: Mosaic's window is gone, not starting")
            stopEverything()
            return START_NOT_STICKY
        }
        title = intent?.getStringExtra("title")?.takeIf { it.isNotBlank() } ?: title
        paused = intent?.getBooleanExtra("paused", false) ?: false
        val wantArt = intent?.getStringExtra("art") ?: ""
        if (!foreground) MosaicLog.add(this, "service: starting for $title (notifications allowed: ${manager().areNotificationsEnabled()})")
        if (wantArt != artUrl) {
            artUrl = wantArt
            art = null
            if (wantArt.isNotEmpty()) loadArt(wantArt)
        }
        if (!show()) return START_NOT_STICKY
        // the processor stays awake only while the stream plays
        if (!paused && wake == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mosaic:playback").apply {
                setReferenceCounted(false)
                acquire()
            }
        } else if (paused) {
            releaseWake()
        }
        return START_NOT_STICKY
    }

    // puts the media session and the notification up to date; false when Android refused the foreground
    private fun show(): Boolean {
        val manager = manager()
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
        val media = session ?: MediaSession(this, "Mosaic").also {
            session = it
            it.setCallback(object : MediaSession.Callback() {
                override fun onPlay() { onMediaButton?.invoke(true) }
                override fun onPause() { onMediaButton?.invoke(false) }
            })
        }
        media.setSessionActivity(open)
        val meta = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, "Live on Mosaic")
        art?.let {
            meta.putBitmap(MediaMetadata.METADATA_KEY_ART, it)
            meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it)
        }
        media.setMetadata(meta.build())
        media.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)
                .setState(
                    if (paused) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING,
                    PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (paused) 0f else 1f
                )
                .build()
        )
        media.isActive = true
        val button = Notification.Action.Builder(
            if (paused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
            if (paused) "Play" else "Pause",
            PendingIntent.getService(
                this, 1,
                Intent(this, PlaybackService::class.java).setAction(if (paused) ACTION_PLAY else ACTION_PAUSE),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        ).build()
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
            else @Suppress("DEPRECATION") Notification.Builder(this)
        builder
            .setContentTitle(title)
            .setContentText("Live on Mosaic")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(button)
            .setStyle(Notification.MediaStyle().setMediaSession(media.sessionToken).setShowActionsInCompactView(0))
        art?.let { builder.setLargeIcon(it) }
        val notification = builder.build()
        if (foreground) {
            manager.notify(NOTIFICATION_ID, notification)
            return true
        }
        return try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            foreground = true
            val channel = if (Build.VERSION.SDK_INT >= 26) manager.getNotificationChannel(CHANNEL)?.importance?.toString() ?: "missing" else "n/a"
            MosaicLog.add(this, "service: in the foreground with its media notification (channel importance $channel)")
            true
        } catch (e: Exception) {
            MosaicLog.add(this, "service: Android refused the foreground: $e")
            stopSelf()
            false
        }
    }

    // swiping Mosaic away from recent apps closes it: the playback (and its notification) go with it
    override fun onTaskRemoved(rootIntent: Intent?) {
        MosaicLog.add(this, "service: Mosaic was closed from recent apps, stopping")
        stopEverything()
        super.onTaskRemoved(rootIntent)
    }

    private fun stopEverything() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
        } catch (_: Exception) { }
        manager().cancel(NOTIFICATION_ID)
        foreground = false
        stopSelf()
    }

    // whether Mosaic still has its window (on screen, floating, or in the background in recent apps)
    private fun appOnScreenOrInRecents(): Boolean = try {
        (getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager).appTasks.isNotEmpty()
    } catch (_: Exception) { true }

    // the stream's picture, fetched off the main thread and shrunk to what a media player shows, then put up
    private fun loadArt(url: String) {
        Thread {
            val bitmap = try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.inputStream.use { BitmapFactory.decodeStream(it) }?.let { shrink(it) }
            } catch (e: Exception) {
                null
            }
            main.post {
                if (bitmap != null && url == artUrl && session != null) {
                    art = bitmap
                    show()
                }
            }
        }.start()
    }

    private fun shrink(b: Bitmap): Bitmap {
        val most = 640
        if (b.width <= most && b.height <= most) return b
        val scale = most.toFloat() / maxOf(b.width, b.height)
        return Bitmap.createScaledBitmap(b, (b.width * scale).toInt(), (b.height * scale).toInt(), true)
    }

    private fun releaseWake() {
        wake?.let { if (it.isHeld) it.release() }
        wake = null
    }

    override fun onDestroy() {
        MosaicLog.add(this, "service: stopped")
        session?.let { it.isActive = false; it.release() }
        session = null
        releaseWake()
        foreground = false
        super.onDestroy()
    }

    private fun manager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        const val CHANNEL = "mosaic_playback"
        const val NOTIFICATION_ID = 4101
        const val ACTION_PLAY = "mosaic.play"
        const val ACTION_PAUSE = "mosaic.pause"
        // set by MainActivity while it's around: true plays the stream, false pauses it
        @Volatile var onMediaButton: ((Boolean) -> Unit)? = null
    }
}
