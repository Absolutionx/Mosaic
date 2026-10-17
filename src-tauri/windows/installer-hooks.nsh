; Mosaic's additions to Tauri's NSIS installer (tauri.conf.json > bundle > windows > nsis > installerHooks).

; After installing or updating: tell Explorer that icons changed (SHChangeNotify(SHCNE_ASSOCCHANGED,
; SHCNF_IDLIST | SHCNF_FLUSH)). Mosaic updates in place, and Windows otherwise keeps showing the previous
; version's icon on a pinned taskbar button. The app repeats this, plus a refresh of each Mosaic shortcut, the
; first time a new version starts (src-tauri/src/icon_refresh.rs).
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
