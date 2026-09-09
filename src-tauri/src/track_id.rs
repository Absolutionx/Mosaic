// "Track ID": identify the music currently playing. The frontend (track-id.js) captures a few seconds
// of the player's audio as little-endian i16 mono 16 kHz PCM (base64); here we decode it and hand it
// to the native fingerprinter in song_id, which builds a Shazam signature locally and looks it up
// against Shazam's public endpoint — no API key, no account, no external binary (the SongRec approach
// that wouldn't build on Windows is gone). Returns None when nothing matched.
use base64::{engine::general_purpose, Engine};

#[tauri::command]
pub async fn identify_song(audio_b64: String) -> Result<Option<crate::song_id::SongMatch>, String> {
    let bytes = general_purpose::STANDARD
        .decode(audio_b64.as_bytes())
        .map_err(|e| format!("bad audio payload: {e}"))?;
    if bytes.len() % 2 != 0 {
        return Err("audio payload has an odd byte length".to_string());
    }
    // reinterpret the byte stream as little-endian i16 samples (mono 16 kHz)
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();

    crate::song_id::identify(samples).await
}
