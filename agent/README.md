# pcreader — device agent

Go agent for PC_READER: a command-line tool (`pcreader`) and a desktop app (`pcreader-desktop`, Milestone 2). Both register a computer with the PC_READER server and upload hardware scans, share one service layer (`internal/app`), one config folder and one token store, so a computer registered with either opens straight to "My computer" in the app. From Milestone 3 the desktop app also runs in the background (see *Background app* below); there is still no separate Windows Service or LaunchAgent daemon.

## Get a build

Download the `pcreader-binaries` artifact from the latest successful **agent** workflow run on GitHub (Actions → agent → run → Artifacts). It contains:

| File | For |
| --- | --- |
| `pcreader-windows-amd64.exe` | Windows 10/11 (64-bit) |
| `pcreader-darwin-arm64` | Apple Silicon Macs (M1 and later) |
| `pcreader-darwin-amd64` | Intel Macs |
| `SHA256SUMS` | Checksums |

Builds are unsigned:
- **Windows:** SmartScreen may warn. Choose *More info → Run anyway*.
- **macOS:** after downloading, run `chmod +x pcreader-darwin-*` first. The first run is blocked; open *System Settings → Privacy & Security* and choose *Open Anyway*, or run `xattr -d com.apple.quarantine pcreader-darwin-*`.

## Desktop app

Download the `pcreader-desktop` artifact from the latest successful **agent** workflow run (Actions → agent → run → Artifacts). CI runs only after a merge into `main`; to build a PR branch, start it by hand (Actions → agent → *Run workflow* → pick the branch). The artifact contains: `PC_READER-setup.exe` (Windows installer), `pcreader-desktop.exe` (plain Windows exe, for testing) and `pcreader-desktop-macos.zip` (universal `.app`, Intel and Apple Silicon).

### Install on Windows

1. Run `PC_READER-setup.exe` (needs administrator rights). It installs to `C:\Program Files\PC_READER`, adds a Start menu and a desktop shortcut and an uninstall entry (*Settings → Apps*), then offers to start PC_READER. Installing over an older version closes the running app first.
2. The setup is unsigned, so SmartScreen may warn: *More info → Run anyway*.
3. Start at login points at the installed exe (the app rewrites the entry on every launch, so it follows the install folder). Do not run the app from Downloads on a real PC: use the setup, otherwise start-at-login points at Downloads.
4. **Uninstall** closes the app, removes the program files, shortcuts and the start-at-login entry. It leaves `%AppData%\PCReader` (`config.json`, `log.db`) and the device token in Credential Manager (service `PCReader`, the `token-…` entries) so a reinstall keeps the registration. To remove them as well: delete the `%AppData%\PCReader` folder and the `PCReader` entries in *Credential Manager → Windows Credentials*. If the start-at-login entry is still there afterwards, run `pcreader-desktop.exe --remove-autostart` before uninstalling or delete the `PC_READER` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

### Install on Mac

First launch on a Mac: unzip `pcreader-desktop-macos.zip` (the download may be zipped twice, unzip again), move `PC_READER.app` to `/Applications`, run `xattr -cr /Applications/PC_READER.app`, then open it and, if macOS still blocks it, choose *Open Anyway* in *System Settings → Privacy & Security*. To see errors, start the binary from Terminal: `/Applications/PC_READER.app/Contents/MacOS/pcreader-desktop`.

Unzip `pcreader-desktop-macos.zip` and drag `PC_READER.app` into `/Applications`, then open it (first launch: see Gatekeeper below). Start at login writes a LaunchAgent that points at the app where it is running from, so install it in `/Applications` *before* the first launch. If the app is moved later, open it once and the entry is rewritten. Uninstall: delete the app and `~/Library/LaunchAgents/ph.gov.intramuros.pcreader.plist`; `~/Library/Application Support/PCReader` and the Keychain item `PCReader` stay unless you delete them.

### First-time setup (IT)

**First-time setup (IT):**
1. Open the app. The first screen is *IT setup*: enter the server address (e.g. `http://192.168.1.10:3000`) and the enrollment key, then *Check connection and continue*. There is no PIN to choose. The check only confirms the server answers; a wrong key is reported when the user signs up. The key is kept in memory only; once registration works, a salted PBKDF2-SHA256 hash of it (600,000 iterations) is saved in `config.json` as `enrollment_key_hash` (see the offline fallback below).
   IT setup shows on a computer that is not registered yet, and again after *Register this computer again*. A computer that is already registered (also one registered with the CLI, or by an older app version) opens straight to My computer.
2. The user fills in the signup form (required: full name, employee ID, department; optional: email, position, phone), ticks the data-use notice, **IT types the current IT PIN** (the 6 digits on the dashboard's IT PIN page) and presses *Sign up*. The app scans the computer, registers it and uploads the first scan; the device then appears in the dashboard with that user.
3. From then on the app opens to **My computer**: a summary (computer name, model, serial, OS, processor, memory, drives with free space, IP address, assigned user, last report time), an expandable *Full details* view of the whole scan, **Report now**, and **Update my details**.

**Without the IT PIN the app is view-only**: anyone can look at *My computer* and *Full details*, but **Report now** (window and tray), **signup**, **Update my details** and **Settings** need the current PIN. The server enforces it for manual scans, `register` and `PUT /user`. One exception carries IT's approval instead: when staff press *Ask user to confirm details* on the dashboard, the request arrives with a one-time approval code, the window opens on *Confirm my details*, and the user can save once without the PIN (employee ID read-only; within 24 hours; the server checks all of it and closes the request). The code is kept in memory only. If it was already used or has expired, the window falls back to the normal form with the PIN field. A correct PIN unlocks the app for 10 minutes (shown as "Unlocked for IT · Lock") or until the window is hidden, so one PIN covers several actions; the PIN is kept in memory only for that time. Wrong tries share one lockout (5 in a row lock every PIN prompt for 60 seconds). Scans the dashboard asks for (*Scan now*) and *Send logs* need no PIN. There is no enrollment-key fallback for these actions: with the server unreachable the app says "Can't reach the server. Try again when this computer is online."

**Update my details** saves to the server and asks for the PIN (unless the session is already unlocked). **Settings** (small link at the bottom of My computer) asks for the **IT PIN**: the 6-digit PIN on the dashboard's **IT PIN** page (`/it-pin`), the same for every PC and changed every hour (at the top of the hour in `DISPLAY_TIMEZONE`, or at once with *Change now*). The app sends the typed PIN to the server, which checks it against the current PIN only (no grace for the previous hour); the PC clock does not matter and no PIN is stored on the PC. 5 wrong tries in a row lock Settings for 60 seconds, and the server also refuses a PC after 5 wrong PINs within a minute. Unlocked, Settings shows only the server address, which is checked before saving. Users see neither the key nor the address without the PIN. The server records every attempt (time, success or not) and the device page lists the recent ones.

**If the server cannot be reached** (no reply, a timeout or a server error) Settings says "Can't reach the server. Enter the enrollment key to change the server address." and checks the typed key against the saved hash, so IT can fix a wrong server address. Wrong keys count towards the same 5-tries lockout. An unlock this way is written to the PC's local log ("IT settings were opened with the enrollment key") and reaches the server with the next *Send logs*. When the server answers but no longer recognises the computer (HTTP 401, e.g. after the server database was wiped) the saved hash is not used at all: the typed key is kept in memory and goes straight to re-registration (the signup form, prefilled with the saved details, plus the IT PIN field), and the server checks the key and the PIN. A wrong key counts towards the same 5-tries lockout and returns to the key field. After success the new token and the key hash are saved. This works on PCs that have no saved hash too. After wiping the server database, every PC shows *Re-registration needed*: enter the enrollment key and the current IT PIN. A computer with no saved hash (registered with the CLI or by an older app version; older per-PC PIN hashes are dropped when the app starts) cannot unlock this way: the app says so, and it gets the hash the next time IT runs *Register this computer again* on it. If IT rotates the enrollment key on the server, PCs keep the hash of the old key until they are registered again. To reset a PC completely, delete `config.json` in the app data folder and run IT setup again.

The PIN protects against casual changes by the person at the keyboard, not against someone who can read `config.json` and the file system. **There is no dashboard login yet, so anyone on the network who can open the dashboard can read the current PIN**; that is accepted until staff login arrives.

Changing the employee ID hands the computer to that person (the dashboard records it as `self-service`). If the server stops recognising the computer (HTTP 401, e.g. after it was re-registered elsewhere), the app says so and offers *Register this computer again* (it asks for the enrollment key, since the server cannot check the PIN); IT enters the key again and the saved details are prefilled.

A computer registered with the CLI (which stores no user details locally) opens to My computer too; "Assigned to" reads "Not known on this computer" until the user presses *Update my details* once.

Builds are unsigned:
- **Windows:** SmartScreen may warn: *More info → Run anyway*. The app needs the WebView2 runtime (included in current Windows 10/11; older machines need the Evergreen runtime from Microsoft).
- **macOS:** unzip, then the first launch is blocked by Gatekeeper: open *System Settings → Privacy & Security* and choose *Open Anyway* (needed on each Mac), or run `xattr -dr com.apple.quarantine PC_READER.app`.

**Build locally** (Windows or macOS only; needs Go, bun and the Wails CLI `go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2`, plus WebView2 on Windows or Xcode command-line tools on macOS):

```sh
cd agent/desktop
wails dev                                # live-reload window
wails build -platform windows/amd64   # or darwin/universal; output in build/bin
```

`agent/desktop` is its own Go module (no build tag, which Wails' bindings generator cannot see through), so `go vet ./...` and `go test ./...` in `agent/` still pass on Linux without GTK/WebKit. The methods the window calls live in `internal/bound` (no Wails import) and are unit-tested; the UI is plain HTML/CSS/JS in `desktop/frontend` (Vite, built with bun; the `wailsjs` bindings are generated by `wails`, not committed).

## Background app (Milestone 3)

After IT setup or signup the desktop app keeps running quietly:

- **Start at login.** Turned on automatically once the computer is set up, and re-checked on every launch. Windows: a per-user entry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (value `PC_READER`). macOS: the LaunchAgent `~/Library/LaunchAgents/ph.gov.intramuros.pcreader.plist`. Both start the app with `--background`: hidden, tray only. Starting the app yourself shows the window. It reports only while a user is logged in.
- **Tray / menu bar icon.** Left-click (or double-click) opens the window; right-click shows a menu with "Open PC_READER", "Report now" and a status line (*Connected*, *Offline*, *Re-registration needed*). There is deliberately no Quit item: the app runs until the user logs out. Closing the window only hides it. Launching the app again shows the running window (single instance).
- **One quiet connection, no polling.** The app opens one outbound Server-Sent Events connection (`GET /api/agent/events`). The server pushes a request the moment staff queue it; the PC acts within seconds. There is no periodic check-in, daily scan or timed log upload. After sleep, network loss or a server restart the app reconnects (waits 1 s, 5 s, 15 s, then 60 s; starts over after a connection stayed up for a minute). PCs never accept incoming connections. If the server rejects the token (401) the app stops and shows *Re-registration needed*.
- **What is sent, and when.**

  | What | When |
  | --- | --- |
  | Connection open (agent version, device token) | Login, and after every reconnect |
  | Network snapshot (IPs, MACs, gateway, DNS, connection type, Wi-Fi name) | When the connection opens and when the network changes (checked every 30 s from local interface data only; nothing is sent unless it changed) |
  | Full scan | Only when staff press *Scan now*, or the user presses *Report now* |
  | Local log | Only when staff press *Send logs* |
  | "Confirm your details" prompt | Only when staff press *Ask user to confirm details*: the window opens on *Confirm my details* (one save without the PIN, same employee ID). The agent does not close this request; the user's save does, or it expires after 24 hours |

- **Local log.** `log.db` (SQLite, pure Go, no CGO) in the data folder, capped at 5,000 entries (the oldest are dropped and a warning is recorded). It holds app events only (scan, sync, signup, update, system) and never tokens or personal details. *Send logs* uploads batches of up to 500 and deletes only the entries the server confirms; a 413 halves the batch.
- **Turn start-at-login off for testing.** Set `PCREADER_NO_AUTOSTART=1` before launching so the app does not (re)create the entry, and remove an existing one with `pcreader-desktop --remove-autostart` (Windows: or delete the `PC_READER` value; macOS: or delete the plist).
- **`pcreader listen`** runs the same connection in the foreground (Ctrl+C to stop): for testing on Linux/CI and for debugging on a real PC. `--from-raw DIR` answers `scan_now` from a `capture-raw` folder instead of scanning. On Linux the network snapshot lists interface addresses only.
- **Users can still end the app** (Task Manager, removing the login item). The computer then shows as Offline, and as Stale after 48 hours.

The tray uses [`fyne.io/systray`](https://github.com/fyne-io/systray) next to Wails v2. On macOS it joins Wails' main thread (`RunWithExternalLoop`); because `OnStartup` runs on a goroutine and AppKit only allows the status item to be created on the main thread, the start is dispatched there with GCD (`agent/desktop/mainthread_darwin.go`; other platforms call it directly). CI launches the built app for 15 s on both OSes to catch such crashes. On Windows it runs on its own goroutine locked to one OS thread with the library's own message loop (`systray.Run`): the tray's hidden window and its message loop must share a thread, and Wails' `OnStartup` goroutine has no loop, which is why clicks were ignored before. Wails v3 was not used because it is still alpha.

## Use (command line)

Run these in PowerShell (Windows) or Terminal (macOS), from the folder holding the binary. Replace `pcreader` with the file name, e.g. `.\pcreader-windows-amd64.exe` or `./pcreader-darwin-arm64`.

```sh
# 1. Save the raw command output (send this folder to the developer)
pcreader capture-raw --out pcreader-raw

# 2. Register this computer and its user
pcreader register --server http://192.168.1.10:3000 --key <ENROLLMENT_KEY> --pin <IT_PIN> \
  --name "Juan Dela Cruz" --employee-id EMP-0001 --department Finance \
  --position "Accountant II" --email juan@example.gov.ph --phone "+63 917 000 0001" \
  --accept-policy

# 3. Scan and upload
pcreader scan --upload --pin <IT_PIN>

# Other commands
pcreader scan --out scan.json   # scan and save the payload without uploading
pcreader status                 # show registration and token state
pcreader listen                 # hold the server connection and act on dashboard requests (testing/debugging)
pcreader version
```

`--accept-policy` confirms the user has read the data-use notice (printed when the flag is missing). The enrollment key can also be set with the `PCREADER_ENROLLMENT_KEY` environment variable, so it doesn't end up in shell history.

Wi-Fi network names may show as empty on recent Windows 11 and macOS versions unless Location access is granted. This is expected.

## Where things are stored

- Local log (`log.db`, SQLite, capped at 5,000 entries) in the same folder.
- Config (`config.json`: server URL, device ID, install UUID, and for the desktop app the user's details as last sent, the last report time and the last scan; none of it is logged): `%AppData%\PCReader` on Windows, `~/Library/Application Support/PCReader` on macOS. `PCREADER_HOME` overrides it.
- Device token: Windows Credential Manager or macOS Keychain (service `PCReader`). `PCREADER_TOKEN_STORE=file` keeps it in a `0600` file in the config folder instead (tests).

## Develop

```sh
cd agent
go test -count=1 ./...          # parsers run against contracts/fixtures/raw on any OS
go vet ./... && gofmt -l .
```

- `internal/scan/windows`, `internal/scan/darwin`: `collect.go` runs the commands, `parse.go` turns raw output into the payload. Parsers are pure functions; `contracts/fixtures/payload/windows-desktop.json` and `macos-apple-silicon.json` are their expected output.
- Background pieces (all unit-tested on Linux with fake servers): `internal/locallog` (SQLite log), `internal/events` (SSE client, reconnect/backoff, 401), `internal/netinfo` (network snapshot and change detector, built from the scan parsers), `internal/background` (the runner: request handlers, confirm-then-clear log upload), `internal/autostart` (login entry).
- `internal/app` is the service layer both front ends call (register, scan, upload, update details, status); `internal/bound` is the desktop app's UI-facing API.
- `cmd/pcreader/e2e_test.go` runs `register` and `scan --upload`, and `pcreader listen` receiving `scan_now`/`send_logs`/`prompt_details_update` queued after it connected (the first two complete; the prompt stays open for the user's save), against a live server when `PCREADER_E2E_SERVER` and `PCREADER_E2E_KEY` are set.
- `internal/scan/live_test.go` scans the current machine when `PCREADER_LIVE_SCAN=1` (CI runs it on Windows and macOS runners and uploads the raw output as an artifact).
- `pcreader scan --from-raw DIR` parses a `capture-raw` folder, which is how real-machine captures become new fixtures.
