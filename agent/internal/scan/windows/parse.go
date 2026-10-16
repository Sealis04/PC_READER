// Package windows turns PowerShell CIM output (see contracts/fixtures/raw/windows) into a scan payload.
// Parsing is pure so it is tested on any OS; collect.go runs the commands.
package windows

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// Classes lists the CIM classes read, with the properties selected for each.
var Classes = []struct {
	Name      string
	Namespace string
	Props     string
}{
	{"Win32_ComputerSystem", "", "Manufacturer,Model,Name,TotalPhysicalMemory,PCSystemType"},
	{"Win32_BIOS", "", "SerialNumber,SMBIOSBIOSVersion,Manufacturer"},
	{"Win32_ComputerSystemProduct", "", "UUID,IdentifyingNumber"},
	{"Win32_OperatingSystem", "", "Caption,Version,BuildNumber,OSArchitecture"},
	{"Win32_Processor", "", "Manufacturer,Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed"},
	{"Win32_PhysicalMemory", "", "DeviceLocator,BankLabel,Manufacturer,Capacity,Speed,ConfiguredClockSpeed,PartNumber,SerialNumber"},
	{"Win32_DiskDrive", "", "Index,Model,SerialNumber,Size,InterfaceType,MediaType"},
	{"MSFT_PhysicalDisk", `root\Microsoft\Windows\Storage`, "DeviceId,FriendlyName,SerialNumber,MediaType,BusType,Size"},
	{"Win32_LogicalDisk", "", "DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType"},
	{"Win32_BaseBoard", "", "Manufacturer,Product,SerialNumber"},
	{"Win32_VideoController", "", "Name,AdapterRAM,DriverVersion,VideoProcessor"},
	{"Win32_NetworkAdapter", "", "Index,Name,NetConnectionID,MACAddress,PhysicalAdapter,AdapterTypeId,NetConnectionStatus"},
	{"Win32_NetworkAdapterConfiguration", "", "Index,IPEnabled,IPAddress,DefaultIPGateway,DNSServerSearchOrder,DHCPEnabled,MACAddress"},
}

const NetshFile = "netsh-wlan.txt"

// MSFT_PhysicalDisk enums.
var busTypes = map[int64]string{1: "SCSI", 3: "ATA", 6: "Fibre Channel", 7: "USB", 8: "RAID", 9: "iSCSI", 10: "SAS", 11: "SATA", 12: "SD", 13: "MMC", 15: "File Backed Virtual", 16: "Storage Spaces", 17: "NVMe"}

func mediaType(code *int64) *string {
	if code == nil {
		return nil
	}
	switch *code {
	case 3:
		return rd.StrPtr("hdd")
	case 4:
		return rd.StrPtr("ssd")
	}
	return rd.StrPtr("unknown")
}

var integratedGPU = regexp.MustCompile(`(?i)\bintel\b|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|microsoft basic display`)

func Parse(raw rd.Set, agentVersion string) (*payload.Scan, error) {
	get := func(class string) ([]map[string]any, error) { return raw.JSONList(class + ".json") }

	cs, err := raw.JSONObject("Win32_ComputerSystem.json")
	if err != nil {
		return nil, err
	}
	if cs == nil {
		return nil, fmt.Errorf("Win32_ComputerSystem.json is missing")
	}
	bios, err := raw.JSONObject("Win32_BIOS.json")
	if err != nil {
		return nil, err
	}
	product, err := raw.JSONObject("Win32_ComputerSystemProduct.json")
	if err != nil {
		return nil, err
	}
	osInfo, err := raw.JSONObject("Win32_OperatingSystem.json")
	if err != nil {
		return nil, err
	}
	procs, err := get("Win32_Processor")
	if err != nil {
		return nil, err
	}
	mems, err := get("Win32_PhysicalMemory")
	if err != nil {
		return nil, err
	}
	drives, err := get("Win32_DiskDrive")
	if err != nil {
		return nil, err
	}
	physical, err := get("MSFT_PhysicalDisk")
	if err != nil {
		return nil, err
	}
	logical, err := get("Win32_LogicalDisk")
	if err != nil {
		return nil, err
	}
	board, err := raw.JSONObject("Win32_BaseBoard.json")
	if err != nil {
		return nil, err
	}
	video, err := get("Win32_VideoController")
	if err != nil {
		return nil, err
	}
	adapters, err := get("Win32_NetworkAdapter")
	if err != nil {
		return nil, err
	}
	configs, err := get("Win32_NetworkAdapterConfiguration")
	if err != nil {
		return nil, err
	}

	hostname := rd.Deref(rd.Str(cs, "Name"))
	if hostname == "" {
		return nil, fmt.Errorf("Win32_ComputerSystem.Name is empty")
	}

	s := &payload.Scan{
		SchemaVersion: payload.SchemaVersion,
		OSType:        "windows",
		AgentVersion:  agentVersion,
		System: payload.System{
			Manufacturer:    rd.Str(cs, "Manufacturer"),
			Model:           rd.Str(cs, "Model"),
			SerialNumber:    rd.Str(bios, "SerialNumber"),
			HardwareUUID:    rd.Str(product, "UUID"),
			Hostname:        hostname,
			OSName:          rd.Str(osInfo, "Caption"),
			OSVersion:       rd.Str(osInfo, "Version"),
			OSBuild:         rd.Str(osInfo, "BuildNumber"),
			FirmwareVersion: rd.Str(bios, "SMBIOSBIOSVersion"),
			ChipName:        nil,
		},
	}

	for _, p := range procs {
		s.CPUs = append(s.CPUs, payload.CPU{
			Manufacturer: rd.Str(p, "Manufacturer"),
			Model:        rd.Str(p, "Name"),
			Cores:        rd.Int(p, "NumberOfCores"),
			Threads:      rd.Int(p, "NumberOfLogicalProcessors"),
			BaseSpeedMHz: rd.Int(p, "MaxClockSpeed"),
		})
	}

	// Spec: total memory is the sum of module capacities (TotalPhysicalMemory excludes reserved RAM).
	var total int64
	s.Memory.Modules = []payload.MemModule{}
	for _, m := range mems {
		size := rd.Int(m, "Capacity")
		if size != nil {
			total += *size
		}
		speed := rd.Int(m, "ConfiguredClockSpeed")
		if speed == nil || *speed == 0 {
			speed = rd.Int(m, "Speed")
		}
		s.Memory.Modules = append(s.Memory.Modules, payload.MemModule{
			Slot:         rd.Str(m, "DeviceLocator"),
			Manufacturer: rd.Str(m, "Manufacturer"),
			SizeBytes:    size,
			SpeedMHz:     speed,
			PartNumber:   rd.Str(m, "PartNumber"),
			SerialNumber: rd.Str(m, "SerialNumber"),
		})
	}
	if total > 0 {
		s.Memory.TotalBytes = &total
	} else {
		s.Memory.TotalBytes = rd.Int(cs, "TotalPhysicalMemory")
	}

	physByID := map[string]map[string]any{}
	for _, p := range physical {
		physByID[rd.Deref(rd.Str(p, "DeviceId"))] = p
	}
	for _, d := range drives {
		phys := physByID[rd.Deref(rd.Str(d, "Index"))]
		bus := rd.Str(d, "InterfaceType")
		if code := rd.Int(phys, "BusType"); code != nil {
			if name, ok := busTypes[*code]; ok {
				bus = &name
			}
		}
		internal := !strings.EqualFold(rd.Deref(bus), "USB") && !strings.Contains(strings.ToLower(rd.Deref(rd.Str(d, "MediaType"))), "removable")
		var media *string
		if phys != nil {
			media = mediaType(rd.Int(phys, "MediaType"))
		}
		s.Storage = append(s.Storage, payload.Disk{
			Model:        rd.Str(d, "Model"),
			SerialNumber: rd.Str(d, "SerialNumber"),
			SizeBytes:    rd.Int(d, "Size"),
			MediaType:    media,
			BusType:      bus,
			IsInternal:   rd.BoolPtr(internal),
		})
	}

	for _, l := range logical {
		if t := rd.Int(l, "DriveType"); t == nil || *t != 3 { // 3 = local disk
			continue
		}
		s.Volumes = append(s.Volumes, payload.Volume{
			MountPoint: rd.Deref(rd.Str(l, "DeviceID")),
			Label:      rd.Str(l, "VolumeName"),
			Filesystem: rd.Str(l, "FileSystem"),
			SizeBytes:  rd.Int(l, "Size"),
			FreeBytes:  rd.Int(l, "FreeSpace"),
		})
	}

	if board != nil {
		s.Motherboard = &payload.Board{
			Manufacturer: rd.Str(board, "Manufacturer"),
			Product:      rd.Str(board, "Product"),
			SerialNumber: rd.Str(board, "SerialNumber"),
		}
	}

	for _, v := range video {
		name := rd.Str(v, "Name")
		s.GPUs = append(s.GPUs, payload.GPU{
			Name:          name,
			MemoryBytes:   rd.Int(v, "AdapterRAM"),
			DriverVersion: rd.Str(v, "DriverVersion"),
			IsIntegrated:  integratedGPU.MatchString(rd.Deref(name)),
		})
	}

	cfgByIndex := map[string]map[string]any{}
	for _, c := range configs {
		cfgByIndex[rd.Deref(rd.Str(c, "Index"))] = c
	}
	for _, a := range adapters {
		if p := rd.Bool(a, "PhysicalAdapter"); p == nil || !*p {
			continue
		}
		mac := rd.NormalizeMAC(rd.Deref(rd.Str(a, "MACAddress")))
		if mac == nil {
			continue
		}
		cfg := cfgByIndex[rd.Deref(rd.Str(a, "Index"))]
		ips := []string{}
		for _, ip := range rd.Strings(cfg, "IPAddress") {
			if !rd.IsLinkLocal(ip) {
				ips = append(ips, ip)
			}
		}
		var gateway *string
		if gws := rd.Strings(cfg, "DefaultIPGateway"); len(gws) > 0 {
			gateway = &gws[0]
		}
		s.Network.Adapters = append(s.Network.Adapters, payload.Adapter{
			Name:        rd.Deref(rd.Str(a, "Name")),
			MACAddress:  mac,
			Type:        adapterType(a),
			IsPhysical:  true,
			IPAddresses: ips,
			Gateway:     gateway,
			DNSServers:  rd.Strings(cfg, "DNSServerSearchOrder"),
			DHCPEnabled: rd.Bool(cfg, "DHCPEnabled"),
		})
	}
	s.Network.WifiSSID = ParseNetshSSID(raw.Text(NetshFile))

	s.Normalize()
	return s, nil
}

func adapterType(a map[string]any) string {
	name := strings.ToLower(rd.Deref(rd.Str(a, "Name")) + " " + rd.Deref(rd.Str(a, "NetConnectionID")))
	if t := rd.Int(a, "AdapterTypeId"); t != nil && *t == 9 || strings.Contains(name, "wi-fi") || strings.Contains(name, "wireless") || strings.Contains(name, "wlan") {
		return "wifi"
	}
	if t := rd.Int(a, "AdapterTypeId"); t != nil && *t == 0 || strings.Contains(name, "ethernet") {
		return "ethernet"
	}
	return "other"
}

var netshField = regexp.MustCompile(`(?m)^\s*(\S[^:]*?)\s*:\s*(.*?)\s*$`)

// ParseNetshSSID returns the SSID of the first connected interface in
// `netsh wlan show interfaces` output (English locale), or nil.
func ParseNetshSSID(text string) *string {
	state, ssid := "", ""
	for _, m := range netshField.FindAllStringSubmatch(text, -1) {
		switch m[1] {
		case "Name":
			if state == "connected" && ssid != "" {
				return &ssid
			}
			state, ssid = "", ""
		case "State":
			state = strings.ToLower(m[2])
		case "SSID":
			ssid = m[2]
		}
	}
	if state == "connected" && ssid != "" {
		return &ssid
	}
	return nil
}
