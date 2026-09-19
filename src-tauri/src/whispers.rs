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
    let client = reqwest::Client::new();
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
    save(&app, &data)?;
    Ok(total_unread(&data, &owner_id))
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
