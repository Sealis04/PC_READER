package bound

import (
	"fmt"
	"strings"

	"github.com/sealis04/pc_reader/agent/internal/payload"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// Field is one label/value row; Entry groups rows (one CPU, one disk, ...); Section is a
// titled list of entries in the "Full details" view.
type Field struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type Entry struct {
	Heading string  `json:"heading"`
	Fields  []Field `json:"fields"`
}

type Section struct {
	Title   string  `json:"title"`
	Entries []Entry `json:"entries"`
}

func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 4; m /= unit {
		div *= unit
		exp++
	}
	v := float64(n) / float64(div)
	suffix := "KMGT"[exp : exp+1]
	if v >= 100 || v == float64(int64(v)) {
		return fmt.Sprintf("%.0f %sB", v, suffix)
	}
	return fmt.Sprintf("%.1f %sB", v, suffix)
}

func bytesOrDash(n *int64) string {
	if n == nil {
		return "—"
	}
	return formatBytes(*n)
}

func text(s *string) string {
	if v := strings.TrimSpace(rd.Deref(s)); v != "" {
		return v
	}
	return "—"
}

func number(n *int64, unit string) string {
	if n == nil {
		return "—"
	}
	return fmt.Sprintf("%d%s", *n, unit)
}

func yesNo(b *bool) string {
	switch {
	case b == nil:
		return "—"
	case *b:
		return "Yes"
	}
	return "No"
}

func join(parts []string) string {
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, ", ")
}

func summarize(sc *payload.Scan) Summary {
	s := Summary{
		ComputerName: sc.System.Hostname,
		Model:        strings.TrimSpace(strings.Join(nonEmpty(rd.Deref(sc.System.Manufacturer), rd.Deref(sc.System.Model)), " ")),
		Serial:       text(sc.System.SerialNumber),
		OS:           strings.TrimSpace(strings.Join(nonEmpty(rd.Deref(sc.System.OSName), rd.Deref(sc.System.OSVersion)), " ")),
		Memory:       bytesOrDash(sc.Memory.TotalBytes),
		IPAddress:    primaryIP(sc),
		Disks:        []DiskView{},
	}
	if s.Model == "" {
		s.Model = "—"
	}
	if s.OS == "" {
		s.OS = "—"
	}
	s.CPU = "—"
	if len(sc.CPUs) > 0 {
		c := sc.CPUs[0]
		name := strings.TrimSpace(rd.Deref(c.Model))
		if name == "" {
			name = strings.TrimSpace(rd.Deref(sc.System.ChipName))
		}
		if name != "" {
			s.CPU = name
			if c.Cores != nil && c.Threads != nil {
				s.CPU += fmt.Sprintf(" (%d cores, %d threads)", *c.Cores, *c.Threads)
			} else if c.Cores != nil {
				s.CPU += fmt.Sprintf(" (%d cores)", *c.Cores)
			}
		}
	}
	for _, v := range sc.Volumes {
		d := DiskView{Name: v.MountPoint, Size: bytesOrDash(v.SizeBytes), Free: bytesOrDash(v.FreeBytes)}
		if l := strings.TrimSpace(rd.Deref(v.Label)); l != "" {
			d.Name += " (" + l + ")"
		}
		if v.SizeBytes != nil && v.FreeBytes != nil && *v.SizeBytes > 0 {
			d.HasUsage = true
			d.UsedPct = int(100 * (*v.SizeBytes - *v.FreeBytes) / *v.SizeBytes)
		}
		s.Disks = append(s.Disks, d)
	}
	return s
}

func nonEmpty(parts ...string) []string {
	var out []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// primaryIP prefers the IPv4 address of a physical adapter that has a gateway.
func primaryIP(sc *payload.Scan) string {
	best := ""
	for _, a := range sc.Network.Adapters {
		if !a.IsPhysical {
			continue
		}
		for _, ip := range a.IPAddresses {
			if strings.Contains(ip, ":") || rd.IsLinkLocal(ip) {
				continue
			}
			if a.Gateway != nil {
				return ip
			}
			if best == "" {
				best = ip
			}
		}
	}
	if best == "" {
		return "—"
	}
	return best
}

func sections(sc *payload.Scan) []Section {
	sys := sc.System
	out := []Section{{Title: "System", Entries: []Entry{{Fields: []Field{
		{"Manufacturer", text(sys.Manufacturer)}, {"Model", text(sys.Model)}, {"Serial number", text(sys.SerialNumber)},
		{"Hardware UUID", text(sys.HardwareUUID)}, {"Computer name", sys.Hostname},
		{"Operating system", text(sys.OSName)}, {"OS version", text(sys.OSVersion)}, {"OS build", text(sys.OSBuild)},
		{"Firmware", text(sys.FirmwareVersion)}, {"Chip", text(sys.ChipName)},
	}}}}}

	cpus := Section{Title: "Processor"}
	for i, c := range sc.CPUs {
		cpus.Entries = append(cpus.Entries, Entry{Heading: numbered("Processor", i, len(sc.CPUs)), Fields: []Field{
			{"Manufacturer", text(c.Manufacturer)}, {"Model", text(c.Model)}, {"Cores", number(c.Cores, "")},
			{"Threads", number(c.Threads, "")}, {"Base speed", number(c.BaseSpeedMHz, " MHz")},
		}})
	}
	out = appendIf(out, cpus)

	mem := Section{Title: "Memory", Entries: []Entry{{Fields: []Field{
		{"Total", bytesOrDash(sc.Memory.TotalBytes)}, {"Built into the chip", yesNo(&sc.Memory.IsIntegrated)},
	}}}}
	for _, m := range sc.Memory.Modules {
		mem.Entries = append(mem.Entries, Entry{Heading: text(m.Slot), Fields: []Field{
			{"Size", bytesOrDash(m.SizeBytes)}, {"Speed", number(m.SpeedMHz, " MHz")}, {"Manufacturer", text(m.Manufacturer)},
			{"Part number", text(m.PartNumber)}, {"Serial number", text(m.SerialNumber)},
		}})
	}
	out = append(out, mem)

	disks := Section{Title: "Storage devices"}
	for i, d := range sc.Storage {
		disks.Entries = append(disks.Entries, Entry{Heading: numbered("Disk", i, len(sc.Storage)), Fields: []Field{
			{"Model", text(d.Model)}, {"Serial number", text(d.SerialNumber)}, {"Size", bytesOrDash(d.SizeBytes)},
			{"Type", text(d.MediaType)}, {"Connection", text(d.BusType)}, {"Internal", yesNo(d.IsInternal)},
		}})
	}
	out = appendIf(out, disks)

	vols := Section{Title: "Drives and free space"}
	for _, v := range sc.Volumes {
		vols.Entries = append(vols.Entries, Entry{Heading: v.MountPoint, Fields: []Field{
			{"Label", text(v.Label)}, {"File system", text(v.Filesystem)}, {"Size", bytesOrDash(v.SizeBytes)}, {"Free", bytesOrDash(v.FreeBytes)},
		}})
	}
	out = appendIf(out, vols)

	if mb := sc.Motherboard; mb != nil {
		out = append(out, Section{Title: "Motherboard", Entries: []Entry{{Fields: []Field{
			{"Manufacturer", text(mb.Manufacturer)}, {"Product", text(mb.Product)}, {"Serial number", text(mb.SerialNumber)},
		}}}})
	}

	gpus := Section{Title: "Graphics"}
	for i, g := range sc.GPUs {
		gpus.Entries = append(gpus.Entries, Entry{Heading: numbered("Graphics", i, len(sc.GPUs)), Fields: []Field{
			{"Name", text(g.Name)}, {"Memory", bytesOrDash(g.MemoryBytes)}, {"Driver", text(g.DriverVersion)},
		}})
	}
	out = appendIf(out, gpus)

	net := Section{Title: "Network"}
	for _, a := range sc.Network.Adapters {
		net.Entries = append(net.Entries, Entry{Heading: a.Name, Fields: []Field{
			{"Type", a.Type}, {"MAC address", text(a.MACAddress)}, {"IP addresses", join(a.IPAddresses)},
			{"Gateway", text(a.Gateway)}, {"DNS servers", join(a.DNSServers)}, {"DHCP", yesNo(a.DHCPEnabled)},
		}})
	}
	net.Entries = append(net.Entries, Entry{Heading: "Wi-Fi", Fields: []Field{{"Network name", text(sc.Network.WifiSSID)}}})
	out = append(out, net)
	return out
}

func numbered(name string, i, n int) string {
	if n <= 1 {
		return name
	}
	return fmt.Sprintf("%s %d", name, i+1)
}

func appendIf(out []Section, s Section) []Section {
	if len(s.Entries) == 0 {
		return out
	}
	return append(out, s)
}
