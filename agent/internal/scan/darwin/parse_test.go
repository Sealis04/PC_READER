package darwin

import (
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

func loadRaw(t *testing.T) rd.Set {
	t.Helper()
	raw, err := rd.Load(contract.Fixture("raw/macos"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// An Intel iMac built from the Apple Silicon sample: chip_type removed, Intel sysctl and DIMMs added.
func intelRaw(t *testing.T) rd.Set {
	raw := loadRaw(t)
	raw["SPHardwareDataType.json"] = []byte(`{"SPHardwareDataType":[{"_name":"hardware_overview","boot_rom_version":"2069.0.0.0.0","cpu_type":"6-Core Intel Core i5","machine_model":"iMac20,1","machine_name":"iMac","platform_UUID":"1F2E3D4C-5B6A-5978-8796-A5B4C3D2E1F0","serial_number":"SAMPLEIMAC20"}]}`)
	raw[SysctlFile] = []byte("machdep.cpu.brand_string: Intel(R) Core(TM) i5-10500 CPU @ 3.10GHz\nmachdep.cpu.vendor: GenuineIntel\nhw.physicalcpu: 6\nhw.logicalcpu: 12\nhw.memsize: 17179869184\nhw.cpufrequency: 3100000000\n")
	raw["SPMemoryDataType.json"] = []byte(`{"SPMemoryDataType":[{"_name":"memory","_items":[
		{"_name":"DIMM0/BANK 0","dimm_manufacturer":"Micron","dimm_part_number":"8ATF1G64HZ-2G6E1","dimm_serial_number":"SAMPLE11","dimm_size":"8 GB","dimm_speed":"2667 MHz"},
		{"_name":"DIMM1/BANK 1","dimm_manufacturer":"Micron","dimm_part_number":"8ATF1G64HZ-2G6E1","dimm_serial_number":"SAMPLE12","dimm_size":"8 GB","dimm_speed":"2667 MHz"},
		{"_name":"DIMM2/BANK 0","dimm_size":"empty"}]}]}`)
	raw["SPDisplaysDataType.json"] = []byte(`{"SPDisplaysDataType":[{"_name":"AMD Radeon Pro 5300","sppci_model":"AMD Radeon Pro 5300","sppci_bus":"spdisplays_pcie_device","spdisplays_vram":"4 GB"}]}`)
	return raw
}

func TestIntelMac(t *testing.T) {
	s, err := Parse(intelRaw(t), "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := contract.Validate("payload", s); err != nil {
		t.Fatal(err)
	}
	cpu := s.CPUs[0]
	if cpu.IsIntegrated || rd.Deref(cpu.Manufacturer) != "GenuineIntel" || cpu.BaseSpeedMHz == nil || *cpu.BaseSpeedMHz != 3100 {
		t.Fatalf("unexpected CPU %+v", cpu)
	}
	if s.System.ChipName != nil || rd.Deref(s.System.Model) != "iMac (iMac20,1)" {
		t.Fatalf("unexpected system %+v", s.System)
	}
	if s.Memory.IsIntegrated || len(s.Memory.Modules) != 2 || *s.Memory.Modules[0].SpeedMHz != 2667 || *s.Memory.Modules[0].SizeBytes != 8<<30 {
		t.Fatalf("unexpected memory %+v", s.Memory)
	}
	if s.Storage[0].IsIntegrated {
		t.Fatal("Intel Mac SSD must not be integrated")
	}
	if s.GPUs[0].IsIntegrated || s.GPUs[0].MemoryBytes == nil || *s.GPUs[0].MemoryBytes != 4<<30 {
		t.Fatalf("unexpected GPU %+v", s.GPUs[0])
	}
}

func TestBridgePortsAreSkipped(t *testing.T) {
	s, err := Parse(loadRaw(t), "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Network.Adapters) != 1 || s.Network.Adapters[0].Name != "Wi-Fi" {
		t.Fatalf("unexpected adapters %+v", s.Network.Adapters)
	}
}

func TestRedactedSSIDIsNull(t *testing.T) {
	raw := loadRaw(t)
	raw[SummaryFile("en0")] = []byte("<dictionary> {\n  SSID : <redacted>\n}\n")
	s, err := Parse(raw, "test")
	if err != nil {
		t.Fatal(err)
	}
	if s.Network.WifiSSID != nil {
		t.Fatalf("expected nil SSID, got %q", *s.Network.WifiSSID)
	}
}

func TestSATAHardDisk(t *testing.T) {
	raw := intelRaw(t)
	raw["SPSerialATADataType.json"] = []byte(`{"SPSerialATADataType":[{"_name":"Intel 400 Series Chipset","_items":[{"_name":"ST1000DM003","device_model":"ST1000DM003-1SB102","device_serial":"SAMPLE-HDD-MAC","size_in_bytes":1000204886016,"spsata_medium_type":"Rotational","detachable_drive":"no","removable_media":"no"}]}]}`)
	s, err := Parse(raw, "test")
	if err != nil {
		t.Fatal(err)
	}
	last := s.Storage[len(s.Storage)-1]
	if rd.Deref(last.MediaType) != "hdd" || rd.Deref(last.BusType) != "SATA" {
		t.Fatalf("unexpected disk %+v", last)
	}
}

func TestParseSize(t *testing.T) {
	for in, want := range map[string]int64{"8 GB": 8 << 30, "1536 MB": 1536 << 20, "1.5 TB": 3 << 39} {
		if got := parseSize(in); got == nil || *got != want {
			t.Errorf("parseSize(%q) = %v, want %d", in, got, want)
		}
	}
	if parseSize("empty") != nil {
		t.Error("expected nil for 'empty'")
	}
}

func TestVirtualDiskFallsBackToStorageDataType(t *testing.T) {
	raw := loadRaw(t)
	raw["SPNVMeDataType.json"] = []byte(`{"SPNVMeDataType":[]}`)
	raw["SPStorageDataType.json"] = []byte(`{"SPStorageDataType":[
		{"_name":"Macintosh HD","mount_point":"/","file_system":"APFS","size_in_bytes":100000000000,"free_space_in_bytes":50000000000,
		 "physical_drive":{"device_name":"Apple Virtio Block Device","is_internal_disk":"yes","medium_type":"ssd","protocol":"Virtio"}},
		{"_name":"Data","mount_point":"/System/Volumes/Data","physical_drive":{"device_name":"Apple Virtio Block Device","is_internal_disk":"yes"}}]}`)
	s, err := Parse(raw, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := contract.Validate("payload", s); err != nil {
		t.Fatal(err)
	}
	if len(s.Storage) != 1 || rd.Deref(s.Storage[0].Model) != "Apple Virtio Block Device" || rd.Deref(s.Storage[0].BusType) != "Virtio" || s.Storage[0].IsIntegrated {
		t.Fatalf("unexpected storage %+v", s.Storage)
	}
}
