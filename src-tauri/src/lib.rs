/// Drive the local Spotify desktop app via AppleScript (macOS only).
/// Other platforms return Err, which the frontend treats as "fall back to
/// the bundled track". The URI is validated to spotify:kind:base62id before
/// interpolation so no arbitrary text reaches osascript.
///
/// `async` so the blocking osascript call runs on the async runtime instead of
/// the main thread — a cold Spotify launch can take seconds and must not
/// freeze the UI.
#[tauri::command]
async fn spotify_control(action: String, uri: Option<String>) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    let script = match action.as_str() {
      "play" => {
        let uri = uri.ok_or("missing uri")?;
        let valid = uri.strip_prefix("spotify:").is_some_and(|rest| {
          let mut parts = rest.splitn(2, ':');
          matches!(parts.next(), Some("track" | "playlist" | "album"))
            && parts
              .next()
              .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric()))
        });
        if !valid {
          return Err("invalid spotify uri".into());
        }
        // `set repeating to true` keeps a single track looping for the session.
        format!(
          "tell application \"Spotify\"\nplay track \"{uri}\"\nset repeating to true\nend tell"
        )
      }
      // Guarded so pause/resume never *launch* Spotify, only control it.
      "pause" => {
        "if application \"Spotify\" is running then tell application \"Spotify\" to pause".into()
      }
      "resume" => {
        "if application \"Spotify\" is running then tell application \"Spotify\" to play".into()
      }
      _ => return Err("unknown action".into()),
    };
    let status = std::process::Command::new("osascript")
      .arg("-e")
      .arg(&script)
      .status()
      .map_err(|e| e.to_string())?;
    if status.success() {
      Ok(())
    } else {
      Err("osascript failed".into())
    }
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (action, uri);
    Err("spotify control is macos-only".into())
  }
}

/// Prevent macOS App Nap from suspending the process while a focus session is
/// running (or the completion alarm is ringing). App Nap freezes JS timers in
/// the webview, so a backgrounded session that produces no webview audio — the
/// Spotify case — would never reach completion. We hold an `NSProcessInfo`
/// activity for the session's lifetime; `UserInitiatedAllowingIdleSystemSleep`
/// blocks App Nap without forcing the whole Mac to stay awake.
#[cfg(target_os = "macos")]
mod keep_awake {
  use objc2::rc::Retained;
  use objc2::runtime::{NSObjectProtocol, ProtocolObject};
  use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
  use std::sync::Mutex;

  struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);
  // SAFETY: NSProcessInfo activity tokens are thread-safe per Apple's docs;
  // begin/endActivity may be called from any thread. We only ever touch the
  // token under the Mutex below.
  unsafe impl Send for Token {}

  static ACTIVITY: Mutex<Option<Token>> = Mutex::new(None);

  pub fn set(active: bool) {
    let mut guard = ACTIVITY.lock().unwrap();
    if active {
      if guard.is_none() {
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
          NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
          &NSString::from_str("Stint focus timer running"),
        );
        *guard = Some(Token(token));
      }
    } else if let Some(token) = guard.take() {
      // SAFETY: `token` came from beginActivityWithOptions on this same process.
      unsafe { NSProcessInfo::processInfo().endActivity(&token.0) };
    }
  }
}

#[tauri::command]
fn set_keep_awake(active: bool) {
  #[cfg(target_os = "macos")]
  keep_awake::set(active);
  #[cfg(not(target_os = "macos"))]
  let _ = active;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .invoke_handler(tauri::generate_handler![spotify_control, set_keep_awake])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
