// Starts Mosaic fresh (Android). build-android.yml copies this next to MainActivity.kt and puts MainActivity's
// package line on top, so it has no package line of its own.
//
// Tauri can only draw into the first copy of Mosaic's screen in a run of the app. When Android makes another (a
// Galaxy Z Flip moving Mosaic between its screens while it plays in the background, for one), that copy would stay
// black. MainActivity then asks this to restart Mosaic: it runs in a process of its own (the manifest says so),
// ends the old one, and opens Mosaic again, which picks the stream it was playing back up (session-restore.js).
// The same trick as the ProcessPhoenix library.

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Process

class RestartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val oldPid = intent.getIntExtra(EXTRA_PID, -1)
        if (oldPid > 0 && oldPid != Process.myPid()) Process.killProcess(oldPid)
        packageManager.getLaunchIntentForPackage(packageName)?.let {
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            startActivity(it)
        }
        finish()
        Runtime.getRuntime().exit(0)
    }

    companion object {
        const val EXTRA_PID = "mosaic_restart_pid"
    }
}
