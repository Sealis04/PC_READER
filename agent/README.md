# pcreader — device agent

Go command-line agent for Milestone 1. It registers a computer with the PC_READER server and uploads hardware scans. There is no window or background service yet (Milestone 2).

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

## Use

Run these in PowerShell (Windows) or Terminal (macOS), from the folder holding the binary. Replace `pcreader` with the file name, e.g. `.\pcreader-windows-amd64.exe` or `./pcreader-darwin-arm64`.

```sh
# 1. Save the raw command output (send this folder to the developer)
pcreader capture-raw --out pcreader-raw

# 2. Register this computer and its user
pcreader register --server http://192.168.1.10:3000 --key <ENROLLMENT_KEY> \
  --name "Juan Dela Cruz" --employee-id EMP-0001 --department Finance \
  --position "Accountant II" --email juan@example.gov.ph --phone "+63 917 000 0001" \
  --accept-policy

# 3. Scan and upload
pcreader scan --upload

# Other commands
pcreader scan --out scan.json   # scan and save the payload without uploading
pcreader status                 # show registration and token state
pcreader version
```

`--accept-policy` confirms the user has read the data-use notice (printed when the flag is missing). The enrollment key can also be set with the `PCREADER_ENROLLMENT_KEY` environment variable, so it doesn't end up in shell history.

Wi-Fi network names may show as empty on recent Windows 11 and macOS versions unless Location access is granted. This is expected.

## Where things are stored

- Config (`config.json`: server URL, device ID, install UUID): `%AppData%\PCReader` on Windows, `~/Library/Application Support/PCReader` on macOS. `PCREADER_HOME` overrides it.
- Device token: Windows Credential Manager or macOS Keychain (service `PCReader`). `PCREADER_TOKEN_STORE=file` keeps it in a `0600` file in the config folder instead (tests).

## Develop

```sh
cd agent
go test -count=1 ./...          # parsers run against contracts/fixtures/raw on any OS
go vet ./... && gofmt -l .
```

- `internal/scan/windows`, `internal/scan/darwin`: `collect.go` runs the commands, `parse.go` turns raw output into the payload. Parsers are pure functions; `contracts/fixtures/payload/windows-desktop.json` and `macos-apple-silicon.json` are their expected output.
- `cmd/pcreader/e2e_test.go` runs `register` and `scan --upload` against a live server when `PCREADER_E2E_SERVER` and `PCREADER_E2E_KEY` are set.
- `internal/scan/live_test.go` scans the current machine when `PCREADER_LIVE_SCAN=1` (CI runs it on Windows and macOS runners and uploads the raw output as an artifact).
- `pcreader scan --from-raw DIR` parses a `capture-raw` folder, which is how real-machine captures become new fixtures.
