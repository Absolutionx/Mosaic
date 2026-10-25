// What Home, Browse and the sidebar show when nobody is logged in to Twitch.
//
// Their lists come from Helix, which refuses every request without a token, so a first launch (or a logout)
// showed an empty Home and a sidebar still holding the last signed-in session's streams. twitch.tv itself fills
// its logged-out pages from its public GQL, which answers without a login, and this does the same (checked
// 10-25-26 with the TV client id Mosaic already uses for the device login; Mosaic's own Helix client id is
// refused there). Each function returns exactly the shape the Helix version of its command returns, so the
// frontend can't tell the difference: streams as Helix /streams rows, games as /games rows, users as /users rows.
// Only public, read-only queries; no token is ever sent.

use serde_json::{json, Value};

const GQL_URL: &str = "https://gql.twitch.tv/gql";
// GQL's limit for one page of streams
const STREAMS_PAGE: usize = 30;

const STREAM_FIELDS: &str = "edges { cursor node { id title viewersCount createdAt type language \
    freeformTags { name } broadcaster { id login displayName profileImageURL(width: 70) } game { id name } } } \
    pageInfo { hasNextPage }";

async fn gql(query: &str, variables: Value) -> Result<Value, String> {
    let resp = crate::http::client()
        .post(GQL_URL)
        .header("Client-Id", crate::twitch_device_auth::TV_CLIENT_ID)
        .json(&json!({ "query": query, "variables": variables }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(msg) = body["errors"][0]["message"].as_str() {
        return Err(format!("Twitch (logged out) {status}: {msg}"));
    }
    if !status.is_success() {
        return Err(format!("Twitch (logged out) answered {status}"));
    }
    Ok(body["data"].clone())
}

// a GQL stream node as a Helix /streams row (plus profile_image_url, which Home and the sidebar read when present)
fn stream_row(node: &Value) -> Option<Value> {
    let b = &node["broadcaster"];
    let login = b["login"].as_str()?;
    Some(json!({
        "id": node["id"].as_str().unwrap_or_default(),
        "user_id": b["id"].as_str().unwrap_or_default(),
        "user_login": login,
        "user_name": b["displayName"].as_str().unwrap_or(login),
        "game_id": node["game"]["id"].as_str().unwrap_or_default(),
        "game_name": node["game"]["name"].as_str().unwrap_or_default(),
        "type": node["type"].as_str().unwrap_or("live"),
        "title": node["title"].as_str().unwrap_or_default(),
        "viewer_count": node["viewersCount"].as_i64().unwrap_or(0),
        "started_at": node["createdAt"].as_str().unwrap_or_default(),
        "language": node["language"].as_str().unwrap_or_default().to_lowercase(),
        "thumbnail_url": format!("https://static-cdn.jtvnw.net/previews-ttv/live_user_{login}-{{width}}x{{height}}.jpg"),
        "tags": node["freeformTags"].as_array().map(|t| t.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
        "is_mature": false,
        "profile_image_url": b["profileImageURL"].as_str().unwrap_or_default(),
    }))
}

// box art at a fixed size -> Helix's "{width}x{height}" template
fn box_art_template(url: &str, w: u32, h: u32) -> String {
    url.replace(&format!("-{w}x{h}."), "-{width}x{height}.")
}

fn game_row(node: &Value) -> Option<Value> {
    Some(json!({
        "id": node["id"].as_str()?,
        "name": node["displayName"].as_str().or(node["name"].as_str()).unwrap_or_default(),
        "box_art_url": box_art_template(node["boxArtURL"].as_str().unwrap_or_default(), 285, 380),
        "igdb_id": "",
    }))
}

// up to `max` streams from a GQL connection (`path` names it in the answer), page by page. `cursor` resumes a
// list; the cursor of the last row comes back when there's more
async fn streams_from(query: &str, vars: Value, path: &[&str], max: usize, cursor: Option<String>) -> Result<(Vec<Value>, Option<String>), String> {
    let mut rows = Vec::new();
    let mut after = cursor;
    loop {
        let mut v = vars.clone();
        v["first"] = json!(STREAMS_PAGE.min(max - rows.len()));
        v["after"] = after.clone().map(Value::String).unwrap_or(Value::Null);
        let data = gql(query, v).await?;
        let mut conn = &data;
        for p in path {
            conn = &conn[*p];
        }
        let edges = conn["edges"].as_array().cloned().unwrap_or_default();
        let more = conn["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false);
        after = edges.last().and_then(|e| e["cursor"].as_str()).map(str::to_owned);
        rows.extend(edges.iter().filter_map(|e| stream_row(&e["node"])));
        if !more || edges.is_empty() || after.is_none() {
            return Ok((rows, None));
        }
        if rows.len() >= max {
            return Ok((rows, after));
        }
    }
}

// Helix /streams?first=100 (top live, most viewers first), with its cursor
pub async fn top_streams(cursor: Option<String>, max: usize) -> Result<(Vec<Value>, Option<String>), String> {
    let q = format!("query($first: Int, $after: Cursor) {{ streams(first: $first, after: $after) {{ {STREAM_FIELDS} }} }}");
    streams_from(&q, json!({}), &["streams"], max, cursor).await
}

// Helix /streams?game_id=...
pub async fn streams_for_game(game_id: &str, max: usize) -> Result<Vec<Value>, String> {
    let q = format!("query($id: ID!, $first: Int, $after: Cursor) {{ game(id: $id) {{ streams(first: $first, after: $after) {{ {STREAM_FIELDS} }} }} }}");
    Ok(streams_from(&q, json!({ "id": game_id }), &["game", "streams"], max, None).await?.0)
}

// Helix /games?name=...&name=... then their streams, most viewers first
pub async fn streams_for_game_names(names: &[String], per_game: usize) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    for name in names.iter().take(20) {
        let data = gql("query($name: String!) { game(name: $name) { id } }", json!({ "name": name })).await?;
        if let Some(id) = data["game"]["id"].as_str() {
            all.extend(streams_for_game(id, per_game).await.unwrap_or_default());
        }
    }
    all.sort_by_key(|s| std::cmp::Reverse(s["viewer_count"].as_i64().unwrap_or(0)));
    Ok(all)
}

// Helix /games/top, with its cursor
pub async fn top_games(cursor: Option<String>) -> Result<(Vec<Value>, Option<String>), String> {
    let data = gql(
        "query($after: Cursor) { games(first: 100, after: $after) { edges { cursor node { id name displayName \
         boxArtURL(width: 285, height: 380) } } pageInfo { hasNextPage } } }",
        json!({ "after": cursor }),
    )
    .await?;
    let edges = data["games"]["edges"].as_array().cloned().unwrap_or_default();
    let next = if data["games"]["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
        edges.last().and_then(|e| e["cursor"].as_str()).map(str::to_owned)
    } else {
        None
    };
    Ok((edges.iter().filter_map(|e| game_row(&e["node"])).collect(), next))
}

// get_category_viewer_counts' {game_id: {viewer_count, channel_count}}: Twitch's own counts for the top
// categories here (the logged-in version can only estimate them from a sample of streams)
pub async fn category_counts() -> Result<Value, String> {
    let data = gql("query { games(first: 100) { edges { node { id viewersCount broadcastersCount } } } }", json!({})).await?;
    let mut out = serde_json::Map::new();
    for e in data["games"]["edges"].as_array().cloned().unwrap_or_default() {
        let n = &e["node"];
        if let Some(id) = n["id"].as_str() {
            out.insert(id.to_string(), json!({
                "viewer_count": n["viewersCount"].as_i64().unwrap_or(0),
                "channel_count": n["broadcastersCount"].as_i64().unwrap_or(0),
            }));
        }
    }
    Ok(Value::Object(out))
}

// Helix /search/categories
pub async fn search_categories(query: &str) -> Result<Vec<Value>, String> {
    let data = gql(
        "query($q: String!) { searchCategories(query: $q, first: 40) { edges { node { id name displayName boxArtURL(width: 285, height: 380) } } } }",
        json!({ "q": query }),
    )
    .await?;
    Ok(data["searchCategories"]["edges"].as_array().cloned().unwrap_or_default().iter().filter_map(|e| game_row(&e["node"])).collect())
}

// Helix /users?id=... (avatars and names)
pub async fn users(ids: &[String]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(100) {
        let data = gql(
            "query($ids: [ID!]) { users(ids: $ids) { id login displayName profileImageURL(width: 300) } }",
            json!({ "ids": chunk }),
        )
        .await?;
        for u in data["users"].as_array().cloned().unwrap_or_default() {
            if u.is_null() {
                continue;
            }
            out.push(json!({
                "id": u["id"].as_str().unwrap_or_default(),
                "login": u["login"].as_str().unwrap_or_default(),
                "display_name": u["displayName"].as_str().unwrap_or_default(),
                "profile_image_url": u["profileImageURL"].as_str().unwrap_or_default(),
            }));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_rows_match_helix() {
        let node = json!({ "id": "1", "title": "t", "viewersCount": 5, "createdAt": "2026-10-25T00:00:00Z", "type": "live",
            "language": "EN", "freeformTags": [{ "name": "English" }],
            "broadcaster": { "id": "9", "login": "abc", "displayName": "Abc", "profileImageURL": "p" },
            "game": { "id": "7", "name": "G" } });
        let r = stream_row(&node).unwrap();
        assert_eq!(r["user_login"], "abc");
        assert_eq!(r["viewer_count"], 5);
        assert_eq!(r["language"], "en");
        assert_eq!(r["thumbnail_url"], "https://static-cdn.jtvnw.net/previews-ttv/live_user_abc-{width}x{height}.jpg");
        assert_eq!(r["tags"][0], "English");
        assert!(stream_row(&json!({ "broadcaster": null })).is_none());
    }

    // against the real Twitch (needs the internet; run by hand: cargo test anon_feed -- --ignored --nocapture)
    #[tokio::test]
    #[ignore]
    async fn live_twitch() {
        let (top, cursor) = top_streams(None, 100).await.unwrap();
        println!("top streams: {} (first {} {} viewers), cursor {}", top.len(), top[0]["user_login"], top[0]["viewer_count"], cursor.is_some());
        let (page2, _) = top_streams(cursor, 30).await.unwrap();
        println!("next page: {} (first {})", page2.len(), page2[0]["user_login"]);
        let (games, gc) = top_games(None).await.unwrap();
        println!("top games: {} (first {} {}), cursor {}", games.len(), games[0]["name"], games[0]["box_art_url"], gc.is_some());
        let gid = games[0]["id"].as_str().unwrap().to_string();
        let gs = streams_for_game(&gid, 100).await.unwrap();
        println!("streams in {}: {} (first {})", games[0]["name"], gs.len(), gs[0]["user_login"]);
        let rpg = streams_for_game_names(&["ELDEN RING".into(), "Baldur's Gate 3".into()], 30).await.unwrap();
        println!("by names: {}", rpg.len());
        let counts = category_counts().await.unwrap();
        println!("category counts: {} ({} -> {})", counts.as_object().unwrap().len(), gid, counts[&gid]);
        let found = search_categories("minecraft").await.unwrap();
        println!("search minecraft: {} (first {})", found.len(), found[0]["name"]);
        let ids: Vec<String> = top.iter().take(3).map(|s| s["user_id"].as_str().unwrap().to_string()).collect();
        let us = users(&ids).await.unwrap();
        println!("users: {} (first {} {})", us.len(), us[0]["login"], us[0]["profile_image_url"]);
        assert!(top.len() >= 90 && !games.is_empty() && !gs.is_empty() && !found.is_empty() && us.len() == 3);
    }

    #[test]
    fn box_art_becomes_a_template() {
        assert_eq!(
            box_art_template("https://static-cdn.jtvnw.net/ttv-boxart/27471_IGDB-285x380.jpg", 285, 380),
            "https://static-cdn.jtvnw.net/ttv-boxart/27471_IGDB-{width}x{height}.jpg"
        );
    }
}
