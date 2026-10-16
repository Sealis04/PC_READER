# macOS raw samples (Apple Silicon, MacBook Air M2)

Captured (in a real run) with:

```sh
system_profiler -json SPHardwareDataType SPMemoryDataType SPNVMeDataType SPSerialATADataType SPStorageDataType SPDisplaysDataType
sysctl machdep.cpu.brand_string hw.physicalcpu hw.logicalcpu hw.memsize
sw_vers
scutil --get ComputerName
networksetup -listallhardwareports
ifconfig en0
route -n get default
scutil --dns
ipconfig getsummary en0      # SSID; macOS 14+ may redact it without Location permission
df -k
```

Notes for parsers:
- Apple Silicon is detected from `SPHardwareDataType.chip_type` starting with "Apple". CPU, memory and the internal SSD are then `is_integrated: true`, and memory `modules` is `null`.
- Bridge and virtual ports from `networksetup` (e.g. "Thunderbolt Bridge") are not physical adapters.
- Volumes: report `/` from `SPStorageDataType`; skip `/System/Volumes/*` and `devfs`.
- `system.model` is `"<machine_name> (<machine_model>)"`, e.g. "MacBook Air (Mac14,2)".
