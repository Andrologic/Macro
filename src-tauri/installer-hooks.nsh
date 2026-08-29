; Tauri stores the selected language under Software\macro\Macro. Keep the
; graphical selector visible even when that value exists. Silent packaging
; tests can seed the same isolated value to exercise every language table.
!define MUI_LANGDLL_ALWAYSSHOW

LangString MacroCloseCancelled 1033 "Macro is still running. The installation was cancelled."
LangString MacroCloseCancelled 1036 "Macro est toujours ouvert. L’installation a été annulée."
LangString MacroCloseCancelled 1031 "Macro ist noch geöffnet. Die Installation wurde abgebrochen."
LangString MacroCloseCancelled 1034 "Macro sigue abierto. La instalación se ha cancelado."
LangString MacroCloseCancelled 1041 "Macro がまだ実行中です。インストールを中止しました。"
LangString MacroCloseCancelled 1042 "Macro가 아직 실행 중입니다. 설치가 취소되었습니다."

LangString MacroCloseTimeout 1033 "Macro could not close. Close it manually, then try the installation again."
LangString MacroCloseTimeout 1036 "Macro n’a pas pu se fermer. Fermez-le manuellement, puis relancez l’installation."
LangString MacroCloseTimeout 1031 "Macro konnte nicht geschlossen werden. Schließen Sie es manuell und starten Sie die Installation erneut."
LangString MacroCloseTimeout 1034 "Macro no se ha podido cerrar. Ciérrelo manualmente y vuelva a iniciar la instalación."
LangString MacroCloseTimeout 1041 "Macro を終了できませんでした。手動で終了してから、インストールを再試行してください。"
LangString MacroCloseTimeout 1042 "Macro를 종료할 수 없습니다. 수동으로 종료한 후 설치를 다시 시도하세요."

LangString MacroClosePrompt 1033 "Macro is open. Continuing will close it. Any work still running may be interrupted. Continue?"
LangString MacroClosePrompt 1036 "Macro est ouvert. Continuer va le fermer. Tout travail encore en cours risque d’être interrompu. Continuer ?"
LangString MacroClosePrompt 1031 "Macro ist geöffnet. Wenn Sie fortfahren, wird die Anwendung geschlossen. Laufende Arbeiten können unterbrochen werden. Fortfahren?"
LangString MacroClosePrompt 1034 "Macro está abierto. Si continúa, se cerrará y cualquier trabajo en curso podría interrumpirse. ¿Continuar?"
LangString MacroClosePrompt 1041 "Macro が開いています。続行すると Macro が終了し、実行中の作業が中断される可能性があります。続行しますか？"
LangString MacroClosePrompt 1042 "Macro가 열려 있습니다. 계속하면 Macro가 종료되며 진행 중인 작업이 중단될 수 있습니다. 계속하시겠습니까?"

Function MacroResolveInstallLocation
  ; Tauri 2.10 initializes $INSTDIR to $LOCALAPPDATA\Macro and then trusts the
  ; saved manufacturer key without checking whether that installation remains.
  ; NSIS removes /D from $CMDLINE after applying it. Read the operating-system
  ; command line so Tauri's initialization cannot hide an explicit destination.
  System::Call 'kernel32::GetCommandLineW() w .R6'
  ClearErrors
  ${GetOptions} $R6 "/D=" $R7
  ${IfNot} ${Errors}
    StrCpy $INSTDIR $R7
    Return
  ${EndIf}

  ; Without /D, retain only a saved location that still contains Macro or its
  ; uninstaller. A different value may have been selected on the directory page.
  ReadRegStr $R8 SHCTX "Software\macro\Macro" ""
  ${If} $R8 != ""
    IfFileExists "$R8\macro.exe" macro_install_location_found 0
    IfFileExists "$R8\uninstall.exe" macro_install_location_found 0
    ; Tauri copied the stale registry value into $INSTDIR. A different value
    ; was selected after initialization and remains authoritative.
    ${If} $INSTDIR != $R8
      Return
    ${EndIf}
  ${Else}
    ; $LOCALAPPDATA\Macro is Tauri 2.10's clean-install default. Preserve a
    ; different value selected after initialization.
    ${If} $INSTDIR != "$LOCALAPPDATA\Macro"
      Return
    ${EndIf}
  ${EndIf}

  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Macro"
  SetOutPath $INSTDIR
  ; SetOutPath in Tauri's template may already have recreated a stale saved
  ; directory. Remove it only when it is empty; never delete user files.
  ${If} $R8 != ""
    RMDir "$R8"
  ${EndIf}
  Return

  macro_install_location_found:
    StrCpy $INSTDIR $R8
FunctionEnd

; .onInit belongs to Tauri's generated template. MUI2 owns .onGUIInit when the
; language selector is enabled, so use its supported callback to update the
; directory before any page is shown. The preinstall hook below covers silent
; executions, where the GUI callback does not always run.
!define MUI_CUSTOMFUNCTION_GUIINIT MacroResolveInstallLocation

!macro NSIS_HOOK_PREINSTALL
  Call MacroResolveInstallLocation
  ; Tauri calls SetOutPath immediately before this hook. Repeat it after
  ; resolving $INSTDIR so silent installs copy files to the corrected path.
  SetOutPath $INSTDIR

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
