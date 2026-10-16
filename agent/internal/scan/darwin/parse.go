// Package darwin turns system_profiler and command-line output (see contracts/fixtures/raw/macos)
// into a scan payload. Parsing is pure so it is tested on any OS; collect.go runs the commands.
package darwin

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// DataTypes are the system_profiler data types read, each saved as "<DataType>.json".
var DataTypes = []string{"SPHardwareDataType", "SPMemoryDataType", "SPNVMeDataType", "SPSerialATADataType", "SPStorageDataType", "SPDisplaysDataType"}

const (
	SysctlFile       = "sysctl.txt"
	SwVersFile       = "sw_vers.txt"
	ComputerNameFile = "scutil-computername.txt"
	PortsFile        = "networksetup-listallhardwareports.txt"
	IfconfigFile     = "ifconfig.txt"
	RouteFile        = "route-get-default.txt"
	DNSFile          = "scutil-dns.txt"
	DFFile           = "df-k.txt"
)

// SummaryFile is the `ipconfig getsummary <device>` output for one interface.
func SummaryFile(device string) string { return "ipconfig-getsummary-" + device + ".txt" }

// SysctlKeys are read with `sysctl <keys>`; missing keys (e.g. hw.cpufrequency on Apple Silicon) are fine.
var SysctlKeys = []string{"machdep.cpu.brand_string", "machdep.cpu.vendor", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize", "hw.cpufrequency"}

// spItems returns the top-level entries of a system_profiler data type.
func spItems(raw rd.Set, dataType string) ([]map[string]any, error) {
	obj, err := raw.JSONObject(dataType + ".json")
	if err != nil || obj == nil {
		return nil, err
	}
	list, _ := obj[dataType].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// children returns an entry's "_items" (e.g. drives under an NVMe controller).
func children(m map[string]any) []map[string]any {
	list, _ := m["_items"].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		if c, ok := e.(map[string]any); ok {
			out = append(out, c)
		}
	}
	return out
}

var colonLine = regexp.MustCompile(`(?m)^\s*([^:\n]+?)\s*:\s*(.*?)\s*$`)

// keyValues parses "key: value" lines (sysctl, sw_vers, route, ipconfig getsummary).
func keyValues(text string) map[string]string {
	out := map[string]string{}
	for _, m := range colonLine.FindAllStringSubmatch(text, -1) {
		if _, seen := out[m[1]]; !seen {
			out[m[1]] = m[2]
		}
	}
	return out
}

var sizeRe = regexp.MustCompile(`(?i)^\s*([\d.]+)\s*(KB|MB|GB|TB)\s*$`)

// parseSize converts "8 GB" (binary units, as system_profiler reports memory and VRAM) to bytes.
func parseSize(s string) *int64 {
	m := sizeRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return nil
	}
	mult := map[string]float64{"KB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40}[strings.ToUpper(m[2])]
	n := int64(v * mult)
	return &n
}

func parseIntPtr(s string) *int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func Parse(raw rd.Set, agentVersion string) (*payload.Scan, error) {
	hwItems, err := spItems(raw, "SPHardwareDataType")
	if err != nil {
		return nil, err
	}
	if len(hwItems) == 0 {
		return nil, fmt.Errorf("SPHardwareDataType.json is missing or empty")
	}
	hw := hwItems[0]
	sysctl := keyValues(raw.Text(SysctlFile))
	swVers := keyValues(raw.Text(SwVersFile))

	chip := rd.Str(hw, "chip_type")
	appleSilicon := chip != nil && strings.HasPrefix(*chip, "Apple")
	if !appleSilicon {
		chip = nil
	}

	hostname := strings.TrimSpace(raw.Text(ComputerNameFile))
	if hostname == "" {
		return nil, fmt.Errorf("%s is empty", ComputerNameFile)
	}

	model := rd.Str(hw, "machine_name")
	if id := rd.Str(hw, "machine_model"); model != nil && id != nil {
		model = rd.StrPtr(*model + " (" + *id + ")")
	}

	s := &payload.Scan{
		SchemaVersion: payload.SchemaVersion,
		OSType:        "macos",
		AgentVersion:  agentVersion,
		System: payload.System{
			Manufacturer:    rd.StrPtr("Apple"),
			Model:           model,
			SerialNumber:    rd.Str(hw, "serial_number"),
			HardwareUUID:    rd.Str(hw, "platform_UUID"),
			Hostname:        hostname,
			OSName:          rd.StrPtr(swVers["ProductName"]),
			OSVersion:       rd.StrPtr(swVers["ProductVersion"]),
			OSBuild:         rd.StrPtr(swVers["BuildVersion"]),
			FirmwareVersion: rd.Str(hw, "boot_rom_version"),
			ChipName:        chip,
		},
	}

	// CPU
	cpu := payload.CPU{
		Cores:        parseIntPtr(sysctl["hw.physicalcpu"]),
		Threads:      parseIntPtr(sysctl["hw.logicalcpu"]),
		IsIntegrated: appleSilicon,
	}
	if appleSilicon {
		cpu.Manufacturer = rd.StrPtr("Apple")
		cpu.Model = chip
	} else {
		cpu.Manufacturer = rd.StrPtr(sysctl["machdep.cpu.vendor"])
		cpu.Model = rd.StrPtr(sysctl["machdep.cpu.brand_string"])
		if hz := parseIntPtr(sysctl["hw.cpufrequency"]); hz != nil {
			cpu.BaseSpeedMHz = rd.IntPtr(*hz / 1_000_000)
		}
	}
	s.CPUs = []payload.CPU{cpu}

	// Memory: Apple Silicon reports only a unified total; Intel Macs list DIMMs.
	s.Memory = payload.Memory{TotalBytes: parseIntPtr(sysctl["hw.memsize"]), IsIntegrated: appleSilicon}
	if !appleSilicon {
		memItems, err := spItems(raw, "SPMemoryDataType")
		if err != nil {
			return nil, err
		}
		s.Memory.Modules = []payload.MemModule{}
		for _, group := range memItems {
			for _, d := range children(group) {
				size := parseSize(rd.Deref(rd.Str(d, "dimm_size")))
				if size == nil { // "empty" slot
					continue
				}
				speed := rd.Deref(rd.Str(d, "dimm_speed"))
				s.Memory.Modules = append(s.Memory.Modules, payload.MemModule{
					Slot:         rd.Str(d, "_name"),
					Manufacturer: rd.Str(d, "dimm_manufacturer"),
					SizeBytes:    size,
					SpeedMHz:     parseIntPtr(strings.TrimSuffix(strings.ToUpper(speed), " MHZ")),
					PartNumber:   rd.Str(d, "dimm_part_number"),
					SerialNumber: rd.Str(d, "dimm_serial_number"),
				})
			}
		}
	}

	// Storage: physical drives from NVMe and SATA; the protocol (e.g. "Apple Fabric") comes from SPStorageDataType.
	storageItems, err := spItems(raw, "SPStorageDataType")
	if err != nil {
		return nil, err
	}
	protocols := map[string]string{}
	for _, v := range storageItems {
		if pd, ok := v["physical_drive"].(map[string]any); ok {
			if name := rd.Deref(rd.Str(pd, "device_name")); name != "" {
				protocols[name] = rd.Deref(rd.Str(pd, "protocol"))
			}
		}
	}
	addDrives := func(dataType, defaultBus string) error {
		groups, err := spItems(raw, dataType)
		if err != nil {
			return err
		}
		for _, g := range groups {
			for _, d := range children(g) {
				modelName := rd.Str(d, "device_model")
				if modelName == nil {
					modelName = rd.Str(d, "_name")
				}
				bus := defaultBus
				if p := protocols[rd.Deref(modelName)]; p != "" && p != "PCI-Express" {
					bus = p
				}
				media := "ssd"
				if dataType == "SPSerialATADataType" {
					switch rd.Deref(rd.Str(d, "spsata_medium_type")) {
					case "Rotational":
						media = "hdd"
					case "Solid State":
						media = "ssd"
					default:
						media = "unknown"
					}
				}
				internal := rd.Deref(rd.Str(d, "detachable_drive")) != "yes" && rd.Deref(rd.Str(d, "removable_media")) != "yes"
				s.Storage = append(s.Storage, payload.Disk{
					Model:        modelName,
					SerialNumber: rd.Str(d, "device_serial"),
					SizeBytes:    rd.Int(d, "size_in_bytes"),
					MediaType:    &media,
					BusType:      &bus,
					IsInternal:   rd.BoolPtr(internal),
					IsIntegrated: appleSilicon && internal,
				})
			}
		}
		return nil
	}
	if err := addDrives("SPNVMeDataType", "NVMe"); err != nil {
		return nil, err
	}
	if err := addDrives("SPSerialATADataType", "SATA"); err != nil {
		return nil, err
	}

	// Volumes: user-facing mounts only.
	for _, v := range storageItems {
		mount := rd.Deref(rd.Str(v, "mount_point"))
		if mount == "" || strings.HasPrefix(mount, "/System/Volumes/") || strings.HasPrefix(mount, "/dev") {
			continue
		}
		var fs *string
		if f := rd.Str(v, "file_system"); f != nil {
			fs = rd.StrPtr(strings.ToLower(*f))
		}
		s.Volumes = append(s.Volumes, payload.Volume{
			MountPoint: mount,
			Label:      rd.Str(v, "_name"),
			Filesystem: fs,
			SizeBytes:  rd.Int(v, "size_in_bytes"),
			FreeBytes:  rd.Int(v, "free_space_in_bytes"),
		})
	}

	// GPUs
	displays, err := spItems(raw, "SPDisplaysDataType")
	if err != nil {
		return nil, err
	}
	for _, g := range displays {
		name := rd.Str(g, "sppci_model")
		if name == nil {
			name = rd.Str(g, "_name")
		}
		vram := rd.Str(g, "spdisplays_vram")
		if vram == nil {
			vram = rd.Str(g, "spdisplays_vram_shared")
		}
		var mem *int64
		if vram != nil && !appleSilicon {
			mem = parseSize(*vram)
		}
		s.GPUs = append(s.GPUs, payload.GPU{
			Name:          name,
			MemoryBytes:   mem,
			DriverVersion: nil,
			IsIntegrated:  rd.Deref(rd.Str(g, "sppci_bus")) == "spdisplays_builtin",
		})
	}

	s.Network = parseNetwork(raw)
	s.Normalize()
	return s, nil
}

type port struct{ name, device, mac string }

// HardwarePorts parses `networksetup -listallhardwareports`.
func HardwarePorts(text string) []port {
	var ports []port
	var cur *port
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "Hardware Port:"):
			ports = append(ports, port{name: strings.TrimSpace(strings.TrimPrefix(line, "Hardware Port:"))})
			cur = &ports[len(ports)-1]
		case cur != nil && strings.HasPrefix(line, "Device:"):
			cur.device = strings.TrimSpace(strings.TrimPrefix(line, "Device:"))
		case cur != nil && strings.HasPrefix(line, "Ethernet Address:"):
			cur.mac = strings.TrimSpace(strings.TrimPrefix(line, "Ethernet Address:"))
		case strings.HasPrefix(line, "VLAN Configurations"):
			cur = nil
		}
	}
	return ports
}

// physicalPort excludes bridges, VPN and virtual ports.
func physicalPort(p port) bool {
	n := strings.ToLower(p.name)
	return !strings.HasPrefix(p.device, "bridge") && !strings.Contains(n, "bridge") && !strings.Contains(n, "vpn")
}

func portType(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "wi-fi") || strings.Contains(n, "airport"):
		return "wifi"
	case strings.Contains(n, "ethernet") || strings.Contains(n, "lan") || strings.Contains(n, "10/100"):
		return "ethernet"
	}
	return "other"
}

var ifHeader = regexp.MustCompile(`^([a-zA-Z0-9]+):\s+flags=`)

// interfaceIPs parses `ifconfig` output into non-link-local addresses per interface.
func interfaceIPs(text string) map[string][]string {
	out := map[string][]string{}
	cur := ""
	for _, line := range strings.Split(text, "\n") {
		if m := ifHeader.FindStringSubmatch(line); m != nil {
			cur = m[1]
			continue
		}
		f := strings.Fields(line)
		if cur == "" || len(f) < 2 || (f[0] != "inet" && f[0] != "inet6") {
			continue
		}
		ip := strings.SplitN(f[1], "%", 2)[0]
		if !rd.IsLinkLocal(ip) {
			out[cur] = append(out[cur], ip)
		}
	}
	return out
}

var nameserverRe = regexp.MustCompile(`^\s*nameserver\[\d+\]\s*:\s*(\S+)`)

// firstResolverDNS returns the nameservers of the first resolver in `scutil --dns` output.
func firstResolverDNS(text string) []string {
	out := []string{}
	inFirst := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "resolver #") {
			if inFirst {
				break
			}
			inFirst = true
			continue
		}
		if m := nameserverRe.FindStringSubmatch(line); inFirst && m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

func parseNetwork(raw rd.Set) payload.Network {
	ips := interfaceIPs(raw.Text(IfconfigFile))
	route := keyValues(raw.Text(RouteFile))
	defaultIf, gateway := route["interface"], route["gateway"]
	dns := firstResolverDNS(raw.Text(DNSFile))

	net := payload.Network{}
	for _, p := range HardwarePorts(raw.Text(PortsFile)) {
		mac := rd.NormalizeMAC(p.mac)
		if mac == nil || !physicalPort(p) {
			continue
		}
		a := payload.Adapter{
			Name:        p.name,
			MACAddress:  mac,
			Type:        portType(p.name),
			IsPhysical:  true,
			IPAddresses: ips[p.device],
		}
		if p.device == defaultIf {
			a.Gateway = rd.StrPtr(gateway)
			a.DNSServers = dns
		}
		if summary, ok := raw[SummaryFile(p.device)]; ok {
			kv := keyValues(string(summary))
			if method := kv["ConfigMethod"]; method != "" {
				a.DHCPEnabled = rd.BoolPtr(method == "DHCP")
			}
			if a.Type == "wifi" && net.WifiSSID == nil {
				if ssid := kv["SSID"]; ssid != "" && ssid != "<redacted>" {
					net.WifiSSID = &ssid
				}
			}
		}
		net.Adapters = append(net.Adapters, a)
	}
	return net
}
