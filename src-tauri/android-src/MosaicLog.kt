// Mosaic's background playback log (Android). build-android.yml copies this next to MainActivity.kt and puts
// MainActivity's package line on top, so it has no package line of its own.
//
// What happened the last few times a stream went into the background (the activity's lifecycle, the playback
// service, whether Android treated Mosaic as playing in the foreground), kept on the phone so it survives Mosaic
// being stopped. Settings > Other > Background playback log shows it (app_extras.rs background_log).

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object MosaicLog {
    private const val PREFS = "mosaic_background_log"
    private const val KEY = "lines"
    private const val KEEP = 150

    @Synchronized
    fun add(context: Context, line: String) {
        android.util.Log.i("Mosaic", line)
        try {
            val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val stamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
            val lines = (prefs.getString(KEY, "") ?: "").split('\n').filter { it.isNotEmpty() }.toMutableList()
            lines.add("$stamp  $line")
            prefs.edit().putString(KEY, lines.takeLast(KEEP).joinToString("\n")).apply()
        } catch (_: Exception) { }
    }

    @Synchronized
    fun read(context: Context): String =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "") ?: ""

    @Synchronized
    fun clear(context: Context) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
    }
}
