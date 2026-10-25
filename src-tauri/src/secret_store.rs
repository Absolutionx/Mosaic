// Where login tokens live: Windows Credential Manager on Windows (the same place browsers and Git keep
// theirs, encrypted for your Windows account), a file in the app's local data folder elsewhere.
//
// Each token keeps the file name it always had ("oauth_token.json", ...) as its key. A token still in its
// old file from an earlier version is moved into Credential Manager the first time it's read, and the file
// is deleted. If Credential Manager refuses (it can't take more than about 2.5 KB per entry, or the
// store is unavailable), the token stays in its file, as before, so a login never breaks over where it's kept.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// Credential Manager lists these as "<name>.Mosaic" under Windows Credentials
const SERVICE_NAME: &str = "Mosaic";

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok()
}

pub fn save(app: &AppHandle, name: &str, data: &str) -> Result<(), String> {
    save_in(data_dir(app).as_deref(), SERVICE_NAME, name, data)
}

pub fn load(app: &AppHandle, name: &str) -> Option<String> {
    load_in(data_dir(app).as_deref(), SERVICE_NAME, name)
}

pub fn delete(app: &AppHandle, name: &str) {
    delete_in(data_dir(app).as_deref(), SERVICE_NAME, name)
}

// On Windows the fallback file is encrypted with DPAPI (CryptProtectData), the same per-user protection
// Credential Manager and browsers use, so a copied file is useless outside your Windows account. It starts
// with DPAPI_MAGIC; a file without it is a plain one from an earlier version and is read as before
#[cfg(windows)]
const DPAPI_MAGIC: &[u8] = b"MOSAIC-DPAPI1\n";

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    // copies the output blob out and frees it (DPAPI allocates it with LocalAlloc)
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        unsafe {
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
            v
        }
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&input, windows::core::w!("Mosaic"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
            Some(take(out))
        }
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
            Some(take(out))
        }
    }
}

fn write_file(dir: Option<&Path>, name: &str, data: &str) -> Result<(), String> {
    let dir = dir.ok_or_else(|| "no data dir".to_string())?;
    let _ = std::fs::create_dir_all(dir);
    #[cfg(windows)]
    {
        if let Some(enc) = dpapi::protect(data.as_bytes()) {
            let mut bytes = DPAPI_MAGIC.to_vec();
            bytes.extend_from_slice(&enc);
            return std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string());
        }
        eprintln!("[secret_store] couldn't encrypt {name}; saving it unencrypted");
    }
    std::fs::write(dir.join(name), data).map_err(|e| e.to_string())
}

fn read_file(dir: Option<&Path>, name: &str) -> Option<String> {
    let bytes = std::fs::read(dir?.join(name)).ok()?;
    #[cfg(windows)]
    {
        if let Some(enc) = bytes.strip_prefix(DPAPI_MAGIC) {
            // another Windows account's file, or a damaged one: no token (you sign in again)
            return dpapi::unprotect(enc).and_then(|v| String::from_utf8(v).ok());
        }
    }
    String::from_utf8(bytes).ok()
}

fn remove_file(dir: Option<&Path>, name: &str) {
    if let Some(d) = dir {
        let _ = std::fs::remove_file(d.join(name));
    }
}

#[cfg(windows)]
fn entry(service: &str, name: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(service, name).ok()
}

// save (replacing any earlier value)
#[allow(unused_variables)]
fn save_in(dir: Option<&Path>, service: &str, name: &str, data: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Some(e) = entry(service, name) {
            match e.set_password(data) {
                Ok(()) => {
                    remove_file(dir, name); // an older copy on disk must not outlive the stored one
                    return Ok(());
                }
                Err(err) => {
                    eprintln!("[secret_store] Credential Manager refused {name} ({err}); using a file");
                    // an earlier value stored there would be read before the file (load_in looks there first),
                    // handing back the old token forever: take it out
                    let _ = e.delete_credential();
                }
            }
        }
    }
    write_file(dir, name, data)
}

// load, moving an old file into Credential Manager on the way
#[allow(unused_variables)]
fn load_in(dir: Option<&Path>, service: &str, name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(e) = entry(service, name) {
            match e.get_password() {
                Ok(v) => return Some(v),
                Err(keyring::Error::NoEntry) => {}
                Err(err) => eprintln!("[secret_store] couldn't read {name} from Credential Manager ({err})"),
            }
            let from_file = read_file(dir, name)?;
            if e.set_password(&from_file).is_ok() {
                remove_file(dir, name);
            } else if std::fs::read(dir?.join(name)).map(|b| !b.starts_with(DPAPI_MAGIC)).unwrap_or(false) {
                // still refused: at least encrypt a plain file left by an earlier version
                let _ = write_file(dir, name, &from_file);
            }
            return Some(from_file);
        }
    }
    read_file(dir, name)
}

// forget it everywhere it could be
#[allow(unused_variables)]
fn delete_in(dir: Option<&Path>, service: &str, name: &str) {
    #[cfg(windows)]
    {
        if let Some(e) = entry(service, name) {
            let _ = e.delete_credential();
        }
    }
    remove_file(dir, name);
}

#[cfg(test)]
mod tests {
    use super::{delete_in, load_in, save_in};

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mosaic-secret-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // the store's own service name per test, so tests never touch real entries or each other
    fn svc() -> String { format!("MosaicTest-{}", uuid::Uuid::new_v4().simple()) }

    #[test]
    fn save_load_delete() {
        let (d, s) = (tmp(), svc());
        assert_eq!(load_in(Some(&d), &s, "t.json"), None);
        save_in(Some(&d), &s, "t.json", "{\"access_token\":\"abc\"}").unwrap();
        assert_eq!(load_in(Some(&d), &s, "t.json").as_deref(), Some("{\"access_token\":\"abc\"}"));
        save_in(Some(&d), &s, "t.json", "second").unwrap();
        assert_eq!(load_in(Some(&d), &s, "t.json").as_deref(), Some("second"));
        delete_in(Some(&d), &s, "t.json");
        assert_eq!(load_in(Some(&d), &s, "t.json"), None);
        assert!(!d.join("t.json").exists());
    }

    // a token left in its file by an older version is still found (and, where the system store
    // exists, moved into it with the file removed)
    #[test]
    fn old_file_is_read_and_migrated() {
        let (d, s) = (tmp(), svc());
        std::fs::write(d.join("old.json"), "legacy").unwrap();
        assert_eq!(load_in(Some(&d), &s, "old.json").as_deref(), Some("legacy"));
        assert_eq!(load_in(Some(&d), &s, "old.json").as_deref(), Some("legacy"));
        #[cfg(windows)]
        assert!(!d.join("old.json").exists(), "file should be gone once moved into the store");
        delete_in(Some(&d), &s, "old.json");
        assert_eq!(load_in(Some(&d), &s, "old.json"), None);
    }

    // the fallback file (Credential Manager refused) is encrypted, and reads back
    #[cfg(windows)]
    #[test]
    fn fallback_file_is_encrypted() {
        let d = tmp();
        super::write_file(Some(&d), "f.json", "{\"access_token\":\"secret123\"}").unwrap();
        let raw = std::fs::read(d.join("f.json")).unwrap();
        assert!(raw.starts_with(super::DPAPI_MAGIC));
        assert!(!String::from_utf8_lossy(&raw).contains("secret123"));
        assert_eq!(super::read_file(Some(&d), "f.json").as_deref(), Some("{\"access_token\":\"secret123\"}"));
        std::fs::write(d.join("p.json"), "plain").unwrap();
        assert_eq!(super::read_file(Some(&d), "p.json").as_deref(), Some("plain"));
    }
}
