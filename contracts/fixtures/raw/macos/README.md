# macOS raw samples (Apple Silicon, MacBook Air M2)

Captured (in a real run) with:

```sh
system_profiler -json -detailLevel full SPHardwareDataType SPMemoryDataType SPNVMeDataType SPSerialATADataType SPStorageDataType SPDisplaysDataType
sysctl <key>                 # one call per key: brand_string, vendor, physicalcpu, logicalcpu, memsize, cpufrequency
sw_vers
scutil --get ComputerName
networksetup -listallhardwareports
ifconfig                     # all interfaces (the sample shows en0 only)
route -n get default
scutil --dns
ipconfig getsummary <device>  # per hardware port: DHCP and SSID; macOS 14+ may redact the SSID
df -k
```

Notes for parsers:
- Apple Silicon is detected from `SPHardwareDataType.chip_type` starting with "Apple". CPU, memory and the internal SSD are then `is_integrated: true`, and memory `modules` is `null`.
- Bridge and virtual ports from `networksetup` (e.g. "Thunderbolt Bridge") are not physical adapters.
- Volumes: report `/` from `SPStorageDataType`; skip `/System/Volumes/*` and `devfs`.
- `system.model` is `"<machine_name> (<machine_model>)"`, e.g. "MacBook Air (Mac14,2)".
