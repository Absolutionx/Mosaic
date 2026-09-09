// detects whether streamlink and ffmpeg are on PATH and, on Windows, installs them via winget
// if missing. a startup check rather than an installer step so it's testable, works for any
// install method (msi/portable/dev), and recovers if a tool is removed later

use serde::Serialize;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
pub struct DepsStatus {
    streamlink: bool,
    ffmpeg: bool,
}

// true if `bin version_flag` spawns and runs at all, regardless of exit code. both tools exit 0
// for these flags in practice, but even a nonzero exit proves the binary is on PATH and
// executable, which is all this confirms. a spawn failure (ErrorKind::NotFound) means "not installed"
async fn is_on_path(bin: &str, version_flag: &str) -> bool {
    // resolve exactly the way we LAUNCH it (stream_relay::resolve_dep_path). if detection used a bare
    // name while playback used the Homebrew path, the two would disagree on macOS and the deps banner
    // would nag that the tools are missing even though playback finds them
    let mut cmd = Command::new(crate::stream_relay::resolve_dep_path(bin));
    cmd.arg(version_flag)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.status().await.is_ok()
}

#[tauri::command]
pub async fn check_stream_deps() -> Result<DepsStatus, String> {
    let (streamlink, ffmpeg) = tokio::join!(
        is_on_path("streamlink", "--version"),
        is_on_path("ffmpeg", "-version"),
    );
    Ok(DepsStatus { streamlink, ffmpeg })
}

// installs whichever of streamlink/ffmpeg check_stream_deps() finds missing, via winget, Windows
// only. winget has no macOS/Linux equivalent; those are covered by build-unix.sh and the README,
// which is why this returns an informative error rather than attempting anything there
#[cfg(windows)]
#[tauri::command]
pub async fn install_stream_deps() -> Result<String, String> {
    let status = check_stream_deps().await?;
    let mut messages = Vec::new();

    if !status.streamlink {
        messages.push(run_winget_install("Streamlink.Streamlink", "streamlink").await?);
    }
    if !status.ffmpeg {
        messages.push(run_winget_install("Gyan.FFmpeg", "ffmpeg").await?);
    }

    if messages.is_empty() {
        return Ok("Already installed.".to_string());
    }

    // without this, the newly-installed tools stay invisible to this already-running process until restart, even though winget succeeded
    refresh_current_process_path().await?;
    messages.push("Ready to stream.".to_string());
    Ok(messages.join(" "))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn install_stream_deps() -> Result<String, String> {
    Err("Automatic install is only available on Windows (via winget). \
On macOS: brew install streamlink ffmpeg. \
On Linux: use your distro's package manager - see the README."
        .to_string())
}

#[cfg(windows)]
async fn run_winget_install(package_id: &str, display_name: &str) -> Result<String, String> {
    // uninstall first, tolerating any failure ("not found" is the expected case and fine). winget's
    // `install` auto-redirects to an upgrade whenever its package database still has an entry for that
    // id, even if the files/PATH entry are long gone, and with no newer version to upgrade TO it treats
    // that as a hard failure (UPDATE_NOT_APPLICABLE). forcing a clean uninstall-then-install sidesteps that
    let mut uninstall_cmd = Command::new("winget");
    uninstall_cmd.args(["uninstall", "--id", package_id, "-e", "--silent", "--accept-source-agreements"]);
    uninstall_cmd.creation_flags(CREATE_NO_WINDOW);
    let uninstall_output = uninstall_cmd.output().await;
    // logged (visible in the `npm run tauri dev` terminal) AND kept as a summary for the error message
    // below, needed either way since the previous version discarded it, giving zero visibility into
    // whether this step ran, found anything, or failed. a built app has no visible console, so the
    // summary is also folded into the error text
    let uninstall_summary = match &uninstall_output {
        Ok(out) => {
            let combined = [
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
            let summary = format!(
                "uninstall exit={:?}{}",
                out.status.code(),
                if combined.is_empty() { String::new() } else { format!(" ({combined})") }
            );
            println!("[deps_check] winget {summary}");
            summary
        }
        Err(e) => {
            let summary = format!("uninstall failed to spawn: {e}");
            println!("[deps_check] winget {summary}");
            summary
        }
    };

    let mut cmd = Command::new("winget");
    cmd.args([
        "install",
        "--id",
        package_id,
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().await.map_err(|e| {
        // distinct from a nonzero exit below: this means winget itself couldn't be spawned
        // (ErrorKind::NotFound), i.e. it isn't installed. winget ships as "App Installer" and is
        // preinstalled on current Windows 10/11, but older/de-bloated Windows 10 images can lack it
        format!(
            "Couldn't run winget ({e}) - it may not be installed. \
             Get it from the Microsoft Store (\"App Installer\"), or \
             install {display_name} manually."
        )
    })?;
    if output.status.success() {
        Ok(format!("Installed {display_name}."))
    } else {
        // winget often writes its actual diagnostic text ("No package found matching input criteria",
        // agreement prompts, dependency errors) to STDOUT, not stderr, a previous version surfaced only
        // stderr, which is why the error shown to the user had nothing useful after the package name. both streams plus the exit code are included now
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        let detail = if combined.is_empty() {
            // both streams empty with a nonzero exit is real winget behavior, not a bug here: it can happen
            // when winget needs interactive elevation/UAC it didn't get as a hidden background process. the fix
            // would be re-spawning with an explicit elevation request, not parsing output that was never produced
            "no output from winget - it may need to run elevated \
             (try installing manually from an admin terminal instead)"
                .to_string()
        } else {
            combined
        };
        Err(format!(
            "winget failed installing {display_name} (exit code {}): {detail} [{uninstall_summary}]",
            output.status.code().map_or("unknown".to_string(), |c| c.to_string())
        ))
    }
}

// re-reads PATH from the registry (machine-wide and per-user scopes, the two Windows itself merges
// when building a process's environment) and applies it to THIS process, so a later
// Command::new("streamlink"/"ffmpeg") in this same running instance can find what winget just
// installed. winget updates the registry's PATH, but an already-running process keeps the PATH block
// it launched with, nothing re-reads the registry into a live process automatically. shells out to
// PowerShell rather than adding a registry-access crate (winreg) that couldn't be verified to compile here
#[cfg(windows)]
async fn refresh_current_process_path() -> Result<(), String> {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')",
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to refresh PATH: {e}"))?;
    if !output.status.success() {
        return Err("Failed to read updated PATH from the registry".to_string());
    }
    let new_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if new_path.is_empty() {
        // don't apply an empty PATH, that would make EVERYTHING unresolvable for the rest of this
        // process's life, far worse than leaving the stale-but-nonempty PATH and asking the user to restart
        return Err("Registry PATH read came back empty - not applying".to_string());
    }
    std::env::set_var("PATH", new_path);
    Ok(())
}
