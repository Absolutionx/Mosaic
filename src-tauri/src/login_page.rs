// The page the browser shows at the end of a Twitch or Kick login (oauth.rs, kick_oauth.rs). One design for
// both, in login_page.html: a card with Mosaic's mark and the state of the login ("wait" while the Twitch
// bridge hands the token over, "ok", "err"). Everything is inline (the page may load nothing: see its CSP)

const TEMPLATE: &str = include_str!("login_page.html");
pub const ICON_OK: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>"#;
pub const ICON_ERR: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>"#;
const ICON_WAIT: &str = r#"<div class="spinner" aria-hidden="true"></div>"#;
pub const CLOSE_HINT: &str = "You can close this tab &nbsp;<kbd>Ctrl</kbd>+<kbd>W</kbd>";

#[derive(Clone, Copy)]
pub enum State {
    Wait,
    Ok,
    Err,
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// title and body are plain text; script is added as it is (the Twitch bridge's)
pub fn render(state: State, title: &str, body: &str, script: &str) -> String {
    let (class, icon, foot, tab) = match state {
        State::Wait => ("wait", ICON_WAIT, "Don't close this tab yet", "Signing in - Mosaic"),
        State::Ok => ("ok", ICON_OK, CLOSE_HINT, "Signed in - Mosaic"),
        State::Err => ("err", ICON_ERR, CLOSE_HINT, "Sign-in didn't finish - Mosaic"),
    };
    TEMPLATE
        .replace("{{TAB_TITLE}}", tab)
        .replace("{{STATE}}", class)
        .replace("{{ICON}}", icon)
        .replace("{{TITLE}}", &escape(title))
        .replace("{{BODY}}", &escape(body))
        .replace("{{FOOT}}", foot)
        .replace("{{SCRIPT}}", script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_every_placeholder() {
        for state in [State::Wait, State::Ok, State::Err] {
            let page = render(state, "A <b> & \"c\"", "Body", "");
            assert!(!page.contains("{{"), "a placeholder was left in the page");
            assert!(page.contains("A &lt;b&gt; &amp; &quot;c&quot;"));
            assert!(page.contains("Content-Security-Policy"));
        }
    }
}
