; electron-builder の NSIS インストーラーに差し込むカスタム処理。
; 本体は app\HF Runner App.exe に置かれ (scripts/after-pack.js)、ユーザーが起動するのはランチャー HF Runner.exe。
; electron-builder が本体の exe を前提に作るショートカット・「完了後に起動」・「アプリと機能」のアイコンをランチャーに向け直す。
!macro customInstall
  ${If} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$INSTDIR\HF Runner.exe"
  ${EndIf}
  ${If} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$INSTDIR\HF Runner.exe"
  ${EndIf}
  StrCpy $launchLink "$INSTDIR\HF Runner.exe"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\HF Runner.exe,0"
!macroend
