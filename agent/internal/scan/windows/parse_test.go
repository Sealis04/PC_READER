package windows

import (
	"testing"

	"github.com/sealis04/pc_reader/agent/internal/contract"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

func loadRaw(t *testing.T) rd.Set {
	t.Helper()
	raw, err := rd.Load(contract.Fixture("raw/windows"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestNetshSSID(t *testing.T) {
	connected := `
There is 1 interface on the system:

    Name                   : Wi-Fi
    State                  : connected
    SSID                   : AGY-STAFF
    BSSID                  : 00:11:22:33:44:55
`
	if got := ParseNetshSSID(connected); got == nil || *got != "AGY-STAFF" {
		t.Fatalf("got %v", got)
	}
	if got := ParseNetshSSID(loadRaw(t).Text(NetshFile)); got != nil {
		t.Fatalf("disconnected interface should give nil, got %q", *got)
	}
	if got := ParseNetshSSID("The Wireless AutoConfig Service (wlansvc) is not running."); got != nil {
		t.Fatalf("no WLAN service should give nil, got %q", *got)
	}
}

func TestSingleObjectAndArrayOutputs(t *testing.T) {
	raw := loadRaw(t)
	// Win32_VideoController is a bare object in the fixture; make it an array of two.
	raw["Win32_VideoController.json"] = []byte(`[{"Name":"Intel(R) UHD Graphics 770","AdapterRAM":1073741824,"DriverVersion":"1"},{"Name":"NVIDIA GeForce RTX 3060","AdapterRAM":4293918720,"DriverVersion":"2"}]`)
	s, err := Parse(raw, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.GPUs) != 2 || !s.GPUs[0].IsIntegrated || s.GPUs[1].IsIntegrated {
		t.Fatalf("unexpected GPUs: %+v", s.GPUs)
	}
}

func TestMissingStorageNamespaceStillParses(t *testing.T) {
	raw := loadRaw(t)
	raw["MSFT_PhysicalDisk.json"] = []byte("null")
	s, err := Parse(raw, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := contract.Validate("payload", s); err != nil {
		t.Fatal(err)
	}
	if s.Storage[0].MediaType != nil || rd.Deref(s.Storage[0].BusType) != "SCSI" {
		t.Fatalf("expected unknown media and WMI interface type, got %+v", s.Storage[0])
	}
}

func TestUSBDriveIsExternal(t *testing.T) {
	raw := loadRaw(t)
	raw["MSFT_PhysicalDisk.json"] = []byte(`[{"DeviceId":"0","MediaType":4,"BusType":17},{"DeviceId":"1","MediaType":0,"BusType":7}]`)
	s, err := Parse(raw, "test")
	if err != nil {
		t.Fatal(err)
	}
	if *s.Storage[1].IsInternal || rd.Deref(s.Storage[1].MediaType) != "unknown" {
		t.Fatalf("USB drive should be external with unknown media: %+v", s.Storage[1])
	}
}

func TestMissingComputerSystemIsAnError(t *testing.T) {
	raw := loadRaw(t)
	delete(raw, "Win32_ComputerSystem.json")
	if _, err := Parse(raw, "test"); err == nil {
		t.Fatal("expected an error")
	}
}
