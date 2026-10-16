// Whispers (Twitch DMs), Stage A: send via Helix, receive live via EventSub (see eventsub.rs), and keep
// history locally so threads accumulate going forward. Storage is one whispers.json in the app data dir,
// keyed by the logged-in owner id then by contact id. No first-party GQL / no ToS gray area.

use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::ChatState;

#[tauri::command]
pub async fn send_whisper(
    state: State<'_, ChatState>,
    to_user_id: String,
    message: String,
) -> Result<(), String> {
    let (token, from_user_id) = crate::helix::require_auth(&state)?;
    if to_user_id == from_user_id {
        return Err("You can't whisper yourself.".into());
    }
    let client = crate::http::client();
    let resp = client
        .post(format!(
            "https://api.twitch.tv/helix/whispers?from_user_id={from_user_id}&to_user_id={to_user_id}"
        ))
        .header("Client-Id", crate::oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({ "message": message }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // Twitch's most common rejections, made readable
        if status.as_u16() == 401 {
            return Err("Not authorized — log out and back in to grant whisper permission.".into());
        }
        if body.contains("phone") || status.as_u16() == 403 {
            return Err("Twitch requires a verified phone number on your account to send whispers.".into());
        }
        if status.as_u16() == 429 {
            return Err("Sending too fast — Twitch rate-limited the whisper. Try again shortly.".into());
        }
        return Err(format!("{status}: {body}"));
    }
    Ok(())
}

// ---- local storage ----

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("whispers.json"))
}

fn load(app: &AppHandle) -> serde_json::Value {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn save(app: &AppHandle, data: &serde_json::Value) -> Result<(), String> {
    let p = path(app).ok_or_else(|| "no app data dir".to_string())?;
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let s = serde_json::to_string(data).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

// list of conversations for the owner, newest activity first
#[tauri::command]
pub fn whisper_get_threads(app: AppHandle, owner_id: String) -> serde_json::Value {
    let data = load(&app);
    let owner = match data.get(&owner_id).and_then(|o| o.as_object()) {
        Some(o) => o,
        None => return json!([]),
    };
    let mut out: Vec<serde_json::Value> = owner
        .iter()
        .map(|(cid, t)| {
            let msgs = t.get("messages").and_then(|m| m.as_array());
            let last = msgs.and_then(|m| m.last());
            json!({
                "contact_id": cid,
                "name": t.get("name").and_then(|n| n.as_str()).unwrap_or(cid),
                "last_text": last.and_then(|m| m.get("text")).and_then(|x| x.as_str()).unwrap_or(""),
                "last_ts": last.and_then(|m| m.get("ts")).and_then(|x| x.as_i64()).unwrap_or(0),
                "unread": t.get("unread").and_then(|u| u.as_i64()).unwrap_or(0),
            })
        })
        .collect();
    out.sort_by(|a, b| b["last_ts"].as_i64().unwrap_or(0).cmp(&a["last_ts"].as_i64().unwrap_or(0)));
    json!(out)
}

// messages of one conversation
#[tauri::command]
pub fn whisper_get_thread(app: AppHandle, owner_id: String, contact_id: String) -> serde_json::Value {
    let data = load(&app);
    data.pointer(&format!("/{owner_id}/{contact_id}/messages"))
        .cloned()
        .unwrap_or_else(|| json!([]))
}

// append a message (sent or received) and persist. returns the total unread for the owner.
#[tauri::command]
pub fn whisper_record(
    app: AppHandle,
    owner_id: String,
    contact_id: String,
    contact_name: String,
    from_self: bool,
    text: String,
) -> Result<i64, String> {
    let mut data = load(&app);
    if !data.is_object() {
        data = json!({});
    }
    let owner = data
        .as_object_mut()
        .unwrap()
        .entry(owner_id.clone())
        .or_insert_with(|| json!({}));
    let thread = owner
        .as_object_mut()
        .ok_or("corrupt store")?
        .entry(contact_id.clone())
        .or_insert_with(|| json!({ "name": contact_name, "unread": 0, "messages": [] }));
    let t = thread.as_object_mut().ok_or("corrupt thread")?;
    if !contact_name.is_empty() {
        t.insert("name".into(), json!(contact_name));
    }
    // Twitch whispers are at most 500 characters; anything longer is cut so one message can't bloat the file
    let text: String = text.chars().take(2000).collect();
    if let Some(arr) = t.get_mut("messages").and_then(|m| m.as_array_mut()) {
        arr.push(json!({ "self": from_self, "text": text, "ts": now_ms() }));
        // cap thread length so the file can't grow unbounded
        if arr.len() > 500 {
            let excess = arr.len() - 500;
            arr.drain(0..excess);
        }
    }
    if !from_self {
        let cur = t.get("unread").and_then(|u| u.as_i64()).unwrap_or(0);
        t.insert("unread".into(), json!(cur + 1));
    }
    cap_threads(&mut data, &owner_id, &contact_id);
    save(&app, &data)?;
    Ok(total_unread(&data, &owner_id))
}

// at most MAX_THREADS conversations per account: past that, the one whose last message is oldest goes
// (never the one just written to). a stranger messaging from many accounts can't grow the file, which
// is rewritten whole on every whisper, without bound
const MAX_THREADS: usize = 200;

fn cap_threads(data: &mut serde_json::Value, owner_id: &str, keep: &str) {
    let Some(owner) = data.get_mut(owner_id).and_then(|o| o.as_object_mut()) else { return };
    while owner.len() > MAX_THREADS {
        let last_ts = |t: &serde_json::Value| {
            t.get("messages").and_then(|m| m.as_array()).and_then(|a| a.last())
                .and_then(|m| m.get("ts")).and_then(|v| v.as_i64()).unwrap_or(0)
        };
        let oldest = owner.iter().filter(|(k, _)| k.as_str() != keep)
            .min_by_key(|(_, t)| last_ts(t)).map(|(k, _)| k.clone());
        match oldest { Some(k) => { owner.remove(&k); } None => break }
    }
}

#[tauri::command]
pub fn whisper_mark_read(app: AppHandle, owner_id: String, contact_id: String) -> Result<(), String> {
    let mut data = load(&app);
    if let Some(t) = data.pointer_mut(&format!("/{owner_id}/{contact_id}")).and_then(|t| t.as_object_mut()) {
        t.insert("unread".into(), json!(0));
        save(&app, &data)?;
    }
    Ok(())
}

#[tauri::command]
pub fn whisper_total_unread(app: AppHandle, owner_id: String) -> i64 {
    total_unread(&load(&app), &owner_id)
}

fn total_unread(data: &serde_json::Value, owner_id: &str) -> i64 {
    data.get(owner_id)
        .and_then(|o| o.as_object())
        .map(|o| o.values().map(|t| t.get("unread").and_then(|u| u.as_i64()).unwrap_or(0)).sum())
        .unwrap_or(0)
}

#[cfg(test)]
mod cap_tests {
    use serde_json::json;
    #[test]
    fn threads_are_capped_oldest_first_and_current_kept() {
        let mut d = json!({ "me": {} });
        for i in 0..250i64 {
            d["me"][format!("c{i}")] = json!({ "messages": [{ "ts": 1000 + i }] });
        }
        d["me"]["c0"]["messages"] = json!([{ "ts": 1 }]); // oldest, but it's the one being written to
        super::cap_threads(&mut d, "me", "c0");
        let o = d["me"].as_object().unwrap();
        assert_eq!(o.len(), super::MAX_THREADS);
        assert!(o.contains_key("c0") && o.contains_key("c249") && !o.contains_key("c1"));
    }
}
