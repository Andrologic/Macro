LangString MacroCloseCancelled ${LANG_ENGLISH} "Macro is still running. The installation was cancelled."
LangString MacroCloseCancelled ${LANG_FRENCH} "Macro est toujours ouvert. L’installation a été annulée."
LangString MacroCloseCancelled ${LANG_GERMAN} "Macro ist noch geöffnet. Die Installation wurde abgebrochen."
LangString MacroCloseCancelled ${LANG_SPANISH} "Macro sigue abierto. La instalación se ha cancelado."
LangString MacroCloseCancelled ${LANG_JAPANESE} "Macro がまだ実行中です。インストールを中止しました。"
LangString MacroCloseCancelled ${LANG_KOREAN} "Macro가 아직 실행 중입니다. 설치가 취소되었습니다."

LangString MacroCloseTimeout ${LANG_ENGLISH} "Macro could not close. Close it manually, then try the installation again."
LangString MacroCloseTimeout ${LANG_FRENCH} "Macro n’a pas pu se fermer. Fermez-le manuellement, puis relancez l’installation."
LangString MacroCloseTimeout ${LANG_GERMAN} "Macro konnte nicht geschlossen werden. Schließen Sie es manuell und starten Sie die Installation erneut."
LangString MacroCloseTimeout ${LANG_SPANISH} "Macro no se ha podido cerrar. Ciérrelo manualmente y vuelva a iniciar la instalación."
LangString MacroCloseTimeout ${LANG_JAPANESE} "Macro を終了できませんでした。手動で終了してから、インストールを再試行してください。"
LangString MacroCloseTimeout ${LANG_KOREAN} "Macro를 종료할 수 없습니다. 수동으로 종료한 후 설치를 다시 시도하세요."

LangString MacroClosePrompt ${LANG_ENGLISH} "Macro is open. Continuing will close it. Any work still running may be interrupted. Continue?"
LangString MacroClosePrompt ${LANG_FRENCH} "Macro est ouvert. Continuer va le fermer. Tout travail encore en cours risque d’être interrompu. Continuer ?"
LangString MacroClosePrompt ${LANG_GERMAN} "Macro ist geöffnet. Wenn Sie fortfahren, wird die Anwendung geschlossen. Laufende Arbeiten können unterbrochen werden. Fortfahren?"
LangString MacroClosePrompt ${LANG_SPANISH} "Macro está abierto. Si continúa, se cerrará y cualquier trabajo en curso podría interrumpirse. ¿Continuar?"
LangString MacroClosePrompt ${LANG_JAPANESE} "Macro が開いています。続行すると Macro が終了し、実行中の作業が中断される可能性があります。続行しますか？"
LangString MacroClosePrompt ${LANG_KOREAN} "Macro가 열려 있습니다. 계속하면 Macro가 종료되며 진행 중인 작업이 중단될 수 있습니다. 계속하시겠습니까?"

!macro NSIS_HOOK_PREINSTALL
  ; The built-in Tauri check terminates a running process. Ask Macro to close
  ; itself first so it can protect active work and flush local data.
  nsis_tauri_utils::FindProcessCurrentUser "macro.exe"
  Pop $R0
  ${If} $R0 = 0
    ; An update activated by Macro starts while the short-lived bootstrap
    ; process is still exiting. Wait for it without showing the manual-install
    ; confirmation and without sending WM_CLOSE.
    ${GetParameters} $R3
    ClearErrors
    ${GetOptions} $R3 "/UPDATE" $R4
    ${IfNot} ${Errors}
      StrCpy $R2 0
      Goto macro_internal_update_wait
    ${EndIf}

    ; Older Macro versions do not understand the close-request handshake. Get
    ; explicit consent before sending WM_CLOSE so they cannot lose active work.
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(MacroClosePrompt)" IDOK macro_close_confirmed IDCANCEL macro_close_cancelled

    macro_close_confirmed:
    Delete "$TEMP\macro-installer-close.request"
    Delete "$TEMP\macro-installer-close.accepted"
    Delete "$TEMP\macro-installer-close.cancelled"
    FileOpen $R1 "$TEMP\macro-installer-close.request" w
    FileWrite $R1 "close"
    FileClose $R1

    StrCpy $R2 0
    macro_close_wait:
      IfFileExists "$TEMP\macro-installer-close.cancelled" macro_close_cancelled 0
      nsis_tauri_utils::FindProcessCurrentUser "macro.exe"
      Pop $R0
      ${If} $R0 != 0
        Goto macro_close_done
      ${EndIf}
      ; Close every visible Macro instance in turn. New builds also enforce a
      ; single instance, but this handles older versions during migration.
      FindWindow $R1 "" "Macro"
      ${If} $R1 P<> 0
        SendMessage $R1 0x0010 0 0 /TIMEOUT=5000
      ${EndIf}
      IntOp $R2 $R2 + 1
      ${If} $R2 >= 300
        Goto macro_close_timeout
      ${EndIf}
      Sleep 1000
      Goto macro_close_wait

    macro_internal_update_wait:
      nsis_tauri_utils::FindProcessCurrentUser "macro.exe"
      Pop $R0
      ${If} $R0 != 0
        Goto macro_close_done
      ${EndIf}
      IntOp $R2 $R2 + 1
      ${If} $R2 >= 300
        Goto macro_close_timeout
      ${EndIf}
      Sleep 250
      Goto macro_internal_update_wait

    macro_close_cancelled:
      Delete "$TEMP\macro-installer-close.request"
      Delete "$TEMP\macro-installer-close.accepted"
      Delete "$TEMP\macro-installer-close.cancelled"
      Abort "$(MacroCloseCancelled)"

    macro_close_timeout:
      Delete "$TEMP\macro-installer-close.request"
      Delete "$TEMP\macro-installer-close.accepted"
      Delete "$TEMP\macro-installer-close.cancelled"
      Abort "$(MacroCloseTimeout)"
  ${EndIf}

  macro_close_done:
    Delete "$TEMP\macro-installer-close.request"
    Delete "$TEMP\macro-installer-close.accepted"
    Delete "$TEMP\macro-installer-close.cancelled"
!macroend
