# Windows raw samples

Captured (in a real run) with, per class:

```powershell
Get-CimInstance -ClassName <Class> | Select-Object <properties> | ConvertTo-Json -Depth 3
Get-CimInstance -Namespace root\Microsoft\Windows\Storage -ClassName MSFT_PhysicalDisk | ...
netsh wlan show interfaces
```

`ConvertTo-Json` emits a single object (not an array) when a class has one instance; parsers must accept both.

`MSFT_PhysicalDisk.MediaType`: 3 = HDD, 4 = SSD, 0 = unspecified. `BusType`: 11 = SATA, 17 = NVMe, 7 = USB.
`Win32_NetworkAdapter.AdapterTypeId`: 0 = Ethernet 802.3, 9 = Wireless. Only `PhysicalAdapter = true` adapters go into the payload.
`Win32_DiskDrive.SerialNumber` and `Win32_PhysicalMemory.PartNumber` may carry padding spaces; parsers trim them.
