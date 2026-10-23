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
        messages.push(run_winget_install("Streamlink.Streamlink", "streamlink", "--version").await?);
    }
    if !status.ffmpeg {
        messages.push(run_winget_install("Gyan.FFmpeg", "ffmpeg", "-version").await?);
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

// winget's "nothing to do" answers to an install: the package is already installed (it then tries an upgrade,
// and with no newer version that fails as UPDATE_NOT_APPLICABLE), as signed 32-bit exit codes
#[cfg(windows)]
const WINGET_ALREADY_INSTALLED: [i32; 2] = [
    0x8A15002Bu32 as i32, // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE
    0x8A150061u32 as i32, // APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED
];

// one winget run, with its output folded into one line: (exit code, "stdout | stderr"). Err when winget itself
// couldn't be started
#[cfg(windows)]
async fn winget(args: &[&str]) -> Result<(Option<i32>, String), std::io::Error> {
    let mut cmd = Command::new("winget");
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().await?;
    let text = [
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" | ");
    Ok((out.status.code(), text))
}

// installs one package. winget is asked to install it outright; when it says the package is already installed,
// that copy is looked for where Mosaic looks (PATH and the installers' folders, stream_relay::locate_tool) and
// used as it is. only a package winget remembers but whose files are gone gets uninstalled and installed again.
// (this used to uninstall first every time: with two copies on the PC, the uninstall removed one and the
// install then failed on the other)
#[cfg(windows)]
async fn run_winget_install(package_id: &str, display_name: &str, version_flag: &str) -> Result<String, String> {
    // the winget source only: both packages live there, and on a new PC the Microsoft Store source is the one
    // that tends to fail (agreements, certificates, a Store that hasn't set itself up yet)
    let install_args = [
        "install", "--id", package_id, "-e", "--source", "winget",
        "--accept-package-agreements", "--accept-source-agreements", "--silent",
    ];
    let not_started = |e: std::io::Error| {
        // winget ships as "App Installer", preinstalled on current Windows 10/11, but older or trimmed-down
        // Windows 10 images can lack it, and a brand-new account only gets it a few minutes after first sign-in
        format!(
            "Couldn't run winget ({e}) - it may not be installed. \
             Get it from the Microsoft Store (\"App Installer\"), or \
             install {display_name} manually."
        )
    };
    let (code, text) = winget(&install_args).await.map_err(not_started)?;
    println!("[deps_check] winget install {package_id} exit={code:?}");
    if code == Some(0) {
        return Ok(format!("Installed {display_name}."));
    }
    let failed = |code: Option<i32>, text: &str, note: &str| {
        // winget often writes its actual reason to STDOUT, which is why both streams are in here; both empty
        // with a nonzero exit happens when an installer wanted Windows' permission and didn't get it
        let detail = if text.is_empty() {
            "no output from winget - it may need permission to install (try again and click Yes when Windows asks)".to_string()
        } else {
            text.to_string()
        };
        format!(
            "winget failed installing {display_name} (exit code {}): {detail}{note}",
            code.map_or("unknown".to_string(), |c| c.to_string())
        )
    };
    if !code.is_some_and(|c| WINGET_ALREADY_INSTALLED.contains(&c)) {
        return Err(failed(code, &text, ""));
    }
    // already installed: fine, as long as Mosaic can find and run it
    if is_on_path(display_name, version_flag).await {
        return Ok(format!("{display_name} was already installed."));
    }
    // winget remembers it, but it isn't where it should be: reinstall it from scratch
    let (ucode, utext) = winget(&["uninstall", "--id", package_id, "-e", "--source", "winget", "--silent", "--accept-source-agreements"])
        .await
        .map_err(not_started)?;
    println!("[deps_check] winget uninstall {package_id} exit={ucode:?}");
    let (code, text) = winget(&install_args).await.map_err(not_started)?;
    println!("[deps_check] winget reinstall {package_id} exit={code:?}");
    if code == Some(0) {
        Ok(format!("Installed {display_name}."))
    } else {
        Err(failed(code, &text, &format!(" [uninstall first: exit {ucode:?}: {utext}]")))
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

// ---- keeping streamlink current ---------------------------------------------------------------------
// streamlink is what blocks Twitch ads (stream_relay.rs). when Twitch changes how ads are marked, the fix
// arrives as a streamlink release, so an outdated streamlink is how ads would come back. Mosaic checks at
// each start and daily (streamlink-update.js) and updates it with one click, like its own updater:
//   installed: `streamlink --version` from the copy Mosaic runs (the first streamlink.exe on PATH)
//   latest:    the newest official Windows build (github.com/streamlink/windows-builds), whose installer is
//              downloaded, checked against the SHA-256 GitHub publishes for it, and run silently into the same
//              place (/CurrentUser for a per-user copy, /AllUsers for a system-wide one, which asks Windows
//              for permission). other platforms, and copies the installer didn't make (pip, portable), get
//              told how to update instead
// winget isn't involved: on a test PC it upgraded a second, unused copy and reported success

#[derive(Serialize, Debug, PartialEq)]
pub struct StreamlinkUpdateStatus {
    installed: Option<String>,
    // the version an update would bring, when there is one
    available: Option<String>,
    update_available: bool,
    // Mosaic can install it itself (Windows, a copy made by the official installer, a verifiable download)
    can_update: bool,
    // the streamlink Mosaic runs and how it was installed: "user" (per-user), "machine" (Program Files) or None
    path: Option<String>,
    scope: Option<String>,
}

// "1.2.3" style comparison, ignoring anything after the numbers ("8.6.1+3.gabc", "v8.7.0", the Windows
// builds' packaging revision "8.6.2-1")
fn parse_version(s: &str) -> Option<Vec<u64>> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let s = s.split(['+', '-']).next().unwrap_or(""); // build metadata / revisions don't count
    let nums: Vec<u64> = s
        .split('.')
        .take_while(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|p| p.parse().ok())
        .collect();
    (!nums.is_empty()).then_some(nums)
}

fn version_newer(candidate: &str, installed: &str) -> bool {
    match (parse_version(candidate), parse_version(installed)) {
        (Some(mut a), Some(mut b)) => {
            let n = a.len().max(b.len());
            a.resize(n, 0);
            b.resize(n, 0);
            a > b
        }
        _ => false,
    }
}

// the version from `streamlink --version` ("streamlink 8.6.1")
fn installed_from_version_output(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|w| parse_version(w).is_some() && w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

// the streamlink.exe Mosaic launches: the first one on PATH, else the installers' folders (resolve_dep_path).
// two copies at once is real (a per-user install plus a system-wide one, found on a test PC), and the update
// has to go to the copy that's actually used
#[cfg(windows)]
fn streamlink_exe_on_path() -> Option<std::path::PathBuf> {
    // the same lookup playback uses (PATH, then the installers' folders)
    let p = crate::stream_relay::resolve_dep_path("streamlink");
    p.is_file().then_some(p)
}

#[cfg(not(windows))]
fn streamlink_exe_on_path() -> Option<std::path::PathBuf> {
    None
}

// the official installer puts streamlink in <root>\Streamlink\bin: under %LOCALAPPDATA%\Programs for a per-user
// install, under Program Files for a system-wide one. anything else (pip's Scripts folder, a portable copy)
// wasn't made by it, so it isn't updated by running it
fn install_scope(exe: &std::path::Path, local_app_data: Option<&str>, program_files: &[String]) -> Option<&'static str> {
    let p = exe.to_string_lossy().to_lowercase().replace('/', "\\");
    let under = |root: &str| {
        let r = root.to_lowercase().replace('/', "\\");
        !r.is_empty() && p.starts_with(&format!("{}\\", r.trim_end_matches('\\')))
    };
    if !p.ends_with("\\streamlink\\bin\\streamlink.exe") {
        return None;
    }
    if local_app_data.is_some_and(under) {
        return Some("user");
    }
    if program_files.iter().any(|r| under(r)) {
        return Some("machine");
    }
    None
}

fn current_install_scope(exe: Option<&std::path::Path>) -> Option<&'static str> {
    let exe = exe?;
    let lad = std::env::var("LOCALAPPDATA").ok();
    let pf: Vec<String> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .collect();
    install_scope(exe, lad.as_deref(), &pf)
}

async fn streamlink_installed_version() -> Option<String> {
    let mut cmd = Command::new(crate::stream_relay::resolve_dep_path("streamlink"));
    cmd.arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    installed_from_version_output(&text)
}

#[derive(Debug, Clone, PartialEq)]
struct WindowsBuild {
    tag: String,    // "8.6.2-1"
    url: String,    // the installer's download link
    sha256: String, // lowercase hex, from GitHub's asset digest
    size: u64,
}

const WINDOWS_BUILDS_RELEASE: &str = "https://api.github.com/repos/streamlink/windows-builds/releases/latest";
const WINDOWS_BUILDS_DOWNLOAD: &str = "https://github.com/streamlink/windows-builds/releases/download/";
// a real installer is ~60 MB; anything far outside that isn't one
const INSTALLER_MAX_BYTES: u64 = 400 * 1024 * 1024;

// the 64-bit installer in a windows-builds release ("streamlink-8.6.2-1-py314-x86_64.exe"), only with a
// SHA-256 digest to check it against and a download link on the project's own release path
fn pick_windows_installer(release: &serde_json::Value) -> Option<WindowsBuild> {
    let tag = release.get("tag_name")?.as_str()?.to_string();
    parse_version(&tag)?;
    let assets = release.get("assets")?.as_array()?;
    assets.iter().find_map(|a| {
        let name = a.get("name")?.as_str()?;
        if !(name.starts_with("streamlink-") && name.ends_with("-x86_64.exe")) {
            return None;
        }
        let url = a.get("browser_download_url")?.as_str()?;
        if !url.starts_with(WINDOWS_BUILDS_DOWNLOAD) || url.contains("..") {
            return None;
        }
        let sha = a.get("digest")?.as_str()?.strip_prefix("sha256:")?.to_ascii_lowercase();
        if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        if size == 0 || size > INSTALLER_MAX_BYTES {
            return None;
        }
        Some(WindowsBuild { tag: tag.clone(), url: url.to_string(), sha256: sha, size })
    })
}

async fn github_json(url: &str) -> Option<serde_json::Value> {
    let resp = crate::http::client()
        .get(url)
        .header("User-Agent", "Mosaic")
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

async fn latest_windows_build() -> Option<WindowsBuild> {
    pick_windows_installer(&github_json(WINDOWS_BUILDS_RELEASE).await?)
}

// other platforms: the newest streamlink release, to say an update exists
async fn streamlink_latest_release() -> Option<String> {
    let json = github_json("https://api.github.com/repos/streamlink/streamlink/releases/latest").await?;
    let tag = json.get("tag_name")?.as_str()?.trim_start_matches(['v', 'V']).to_string();
    parse_version(&tag).is_some().then_some(tag)
}

fn decide(installed: Option<String>, latest: Option<String>, installable: bool, path: Option<String>, scope: Option<String>) -> StreamlinkUpdateStatus {
    let available = match (&installed, &latest) {
        (Some(i), Some(l)) if version_newer(l, i) => Some(l.clone()),
        _ => None,
    };
    StreamlinkUpdateStatus {
        update_available: available.is_some(),
        can_update: available.is_some() && installable && scope.is_some(),
        installed,
        available,
        path,
        scope,
    }
}

#[tauri::command]
pub async fn check_streamlink_update() -> Result<StreamlinkUpdateStatus, String> {
    let exe = streamlink_exe_on_path();
    let scope = current_install_scope(exe.as_deref());
    let path = exe.map(|p| p.to_string_lossy().to_string());
    if cfg!(windows) {
        let (installed, build) = tokio::join!(streamlink_installed_version(), latest_windows_build());
        let latest = build.as_ref().map(|b| b.tag.clone());
        Ok(decide(installed, latest, build.is_some(), path, scope.map(str::to_string)))
    } else {
        let (installed, latest) = tokio::join!(streamlink_installed_version(), streamlink_latest_release());
        Ok(decide(installed, latest, false, path, None))
    }
}

// downloads the installer to a temp file while hashing it; the file is kept only if the hash matches
#[cfg(windows)]
async fn download_verified(build: &WindowsBuild) -> Result<std::path::PathBuf, String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let dest = std::env::temp_dir().join(format!("mosaic-streamlink-{}.exe", uuid::Uuid::new_v4().simple()));
    let resp = crate::http::client()
        .get(&build.url)
        .header("User-Agent", "Mosaic")
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed ({})", resp.status()));
    }
    let mut file = tokio::fs::File::create(&dest).await.map_err(|e| format!("Couldn't save the download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut stream = resp.bytes_stream();
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download failed: {e}"))?;
            total += chunk.len() as u64;
            if total > INSTALLER_MAX_BYTES {
                return Err("The download is larger than a streamlink installer should be".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| format!("Couldn't save the download: {e}"))?;
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    drop(file);
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(e);
    }
    if got != build.sha256 {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err("The downloaded installer didn't match its published checksum, so it wasn't run".into());
    }
    Ok(dest)
}

// runs the installer silently into the same place as the copy Mosaic uses. Start-Process (ShellExecute) rather
// than spawning it directly: the installer asks for the highest rights the user has, which a plain spawn can't
// grant. a system-wide (/AllUsers) update shows the Windows permission prompt; declining it is reported as such
#[cfg(windows)]
async fn run_installer(installer: &std::path::Path, scope: &str) -> Result<(), String> {
    let mode = if scope == "user" { "/CurrentUser" } else { "/AllUsers" };
    let script = format!(
        "$ErrorActionPreference='Stop'; try {{ $p = Start-Process -FilePath $env:MOSAIC_SL_INSTALLER -ArgumentList '/S','{mode}' -Wait -PassThru; exit $p.ExitCode }} catch {{ Write-Output $_.Exception.Message; exit 1223 }}"
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .env("MOSAIC_SL_INSTALLER", installer)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| "The installer took too long".to_string())?
        .map_err(|e| format!("Couldn't start the installer ({e})"))?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(1223) => {
            let msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if msg.to_lowercase().contains("cancel") {
                Err("Windows' permission prompt was declined, so streamlink wasn't updated".into())
            } else {
                Err(format!("Couldn't start the installer: {}", msg.chars().take(200).collect::<String>()))
            }
        }
        Some(c) => Err(format!("The streamlink installer exited with code {c}")),
        None => Err("The streamlink installer was stopped".into()),
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn update_streamlink() -> Result<String, String> {
    let exe = streamlink_exe_on_path();
    let Some(scope) = current_install_scope(exe.as_deref()) else {
        return Err("This streamlink wasn't installed with the official installer, so update it the way you installed it.".into());
    };
    let build = latest_windows_build().await.ok_or("Couldn't find the latest streamlink installer")?;
    let before = streamlink_installed_version().await;
    if let Some(b) = &before {
        if !version_newer(&build.tag, b) {
            return Ok(format!("Streamlink {b} is already the latest."));
        }
    }
    let installer = download_verified(&build).await?;
    let ran = run_installer(&installer, scope).await;
    let _ = tokio::fs::remove_file(&installer).await;
    ran?;
    let after = streamlink_installed_version().await;
    match (&after, &before) {
        // success means the copy Mosaic runs changed, not just that an installer exited cleanly
        (Some(a), Some(b)) if a == b => Err(format!(
            "The installer finished, but the streamlink Mosaic uses ({}) is still {a}.",
            exe.map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
        )),
        (Some(a), _) => Ok(format!("Updated streamlink to {a}.")),
        (None, _) => Err("The installer finished, but streamlink didn't start afterwards. Try reinstalling it.".into()),
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn update_streamlink() -> Result<String, String> {
    Err("Update streamlink the way you installed it: brew upgrade streamlink, or pip install -U streamlink.".into())
}

#[cfg(test)]
mod streamlink_update_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions() {
        assert!(version_newer("8.7.0", "8.6.1"));
        assert!(version_newer("8.10", "8.9.2"));
        assert!(version_newer("v9", "8.99"));
        assert!(version_newer("8.6.2-1", "8.4.0"));
        assert!(!version_newer("8.6.2-2", "8.6.2"));
        assert!(!version_newer("8.6.1", "8.6.1"));
        assert!(!version_newer("8.6.1+3.gabc", "8.6.1"));
        assert!(!version_newer("8.6.0", "8.6.1"));
        assert!(!version_newer("junk", "8.6.1"));
        assert_eq!(installed_from_version_output("streamlink 8.6.1\r\n").as_deref(), Some("8.6.1"));
        assert_eq!(installed_from_version_output("command not found"), None);
    }

    // the two installs found on a real PC: a per-user one first on PATH, plus a system-wide one
    #[test]
    fn install_scopes() {
        use std::path::Path;
        let lad = Some(r"C:\Users\jt628\AppData\Local");
        let pf = vec![r"C:\Program Files".to_string(), r"C:\Program Files (x86)".to_string()];
        assert_eq!(install_scope(Path::new(r"C:\Users\jt628\AppData\Local\Programs\Streamlink\bin\streamlink.exe"), lad, &pf), Some("user"));
        assert_eq!(install_scope(Path::new(r"C:\Program Files\Streamlink\bin\streamlink.exe"), lad, &pf), Some("machine"));
        assert_eq!(install_scope(Path::new(r"c:\program files\streamlink\bin\STREAMLINK.EXE"), lad, &pf), Some("machine"));
        assert_eq!(install_scope(Path::new(r"C:\Users\jt628\AppData\Local\Programs\Python\Python312\Scripts\streamlink.exe"), lad, &pf), None);
        assert_eq!(install_scope(Path::new(r"D:\tools\Streamlink\bin\streamlink.exe"), lad, &pf), None);
        assert_eq!(install_scope(Path::new(r"C:\Program FilesX\Streamlink\bin\streamlink.exe"), lad, &pf), None);
    }

    // the shape of the real 8.6.2-1 release
    #[test]
    fn picks_the_verified_installer() {
        let sha = "f7614d463c21ef45831debfe464dd54ca2f7604fe849fa3e306b15945c9342b1";
        let rel = json!({"tag_name": "8.6.2-1", "assets": [
            {"name": "streamlink-8.6.2-1-py314-x86_64.zip", "size": 84000000, "digest": format!("sha256:{sha}"),
             "browser_download_url": "https://github.com/streamlink/windows-builds/releases/download/8.6.2-1/streamlink-8.6.2-1-py314-x86_64.zip"},
            {"name": "streamlink-8.6.2-1-py314-x86_64.exe", "size": 64000000, "digest": format!("sha256:{}", sha.to_uppercase()),
             "browser_download_url": "https://github.com/streamlink/windows-builds/releases/download/8.6.2-1/streamlink-8.6.2-1-py314-x86_64.exe"}]});
        let b = pick_windows_installer(&rel).unwrap();
        assert_eq!(b.tag, "8.6.2-1");
        assert!(b.url.ends_with(".exe"));
        assert_eq!(b.sha256, sha);
        // no checksum, or a link outside the project's releases: not used
        let mut no_digest = rel.clone();
        no_digest["assets"][1].as_object_mut().unwrap().remove("digest");
        assert_eq!(pick_windows_installer(&no_digest), None);
        let mut elsewhere = rel.clone();
        elsewhere["assets"][1]["browser_download_url"] = json!("https://evil.example/streamlink-8.6.2-1-py314-x86_64.exe");
        assert_eq!(pick_windows_installer(&elsewhere), None);
        let mut traversal = rel.clone();
        traversal["assets"][1]["browser_download_url"] = json!("https://github.com/streamlink/windows-builds/releases/download/../../x/streamlink-1-x86_64.exe");
        assert_eq!(pick_windows_installer(&traversal), None);
    }

    #[test]
    fn decisions() {
        let s = decide(Some("8.4.0".into()), Some("8.6.2-1".into()), true, None, Some("user".into()));
        assert!(s.update_available && s.can_update && s.available.as_deref() == Some("8.6.2-1"));
        // not a copy the installer made: update offered, but not one-click
        let s = decide(Some("8.4.0".into()), Some("8.6.2-1".into()), true, None, None);
        assert!(s.update_available && !s.can_update);
        let s = decide(Some("8.6.2".into()), Some("8.6.2-1".into()), true, None, Some("user".into()));
        assert!(!s.update_available && !s.can_update);
        let s = decide(None, None, false, None, None);
        assert!(!s.update_available);
    }
}
