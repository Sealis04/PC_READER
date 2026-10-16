# Fixtures

All values are **invented samples** (serial numbers contain `SAMPLE`, MAC addresses use made-up suffixes). Replace raw captures with real ones from `pcreader capture-raw` during the real-machine test, then update the matching payload fixture.

- `payload/` — complete scan payloads (schema v1). `windows-desktop.json` is the expected parser output for `raw/windows/`, `macos-apple-silicon.json` for `raw/macos/`.
- `register/` — sample `POST /api/agent/register` bodies.
- `raw/windows/` — output of `Get-CimInstance <Class> | Select-Object <props> | ConvertTo-Json`, one file per class, plus `netsh-wlan.txt`.
- `raw/macos/` — output of `system_profiler -json <DataType>` and plain-text command output (`sysctl`, `sw_vers`, `scutil`, `networksetup`, `df`, `route`).
