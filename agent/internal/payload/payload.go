// Package payload mirrors contracts/scan-payload.v1.schema.json and the agent API bodies.
// Nullable schema fields are pointers; no field uses omitempty, because the contract
// requires every property to be present (null instead of omitted).
package payload

const SchemaVersion = 1

type Scan struct {
	SchemaVersion int      `json:"schema_version"`
	OSType        string   `json:"os_type"`
	AgentVersion  string   `json:"agent_version"`
	System        System   `json:"system"`
	CPUs          []CPU    `json:"cpus"`
	Memory        Memory   `json:"memory"`
	Storage       []Disk   `json:"storage"`
	Volumes       []Volume `json:"volumes"`
	Motherboard   *Board   `json:"motherboard"`
	GPUs          []GPU    `json:"gpus"`
	Network       Network  `json:"network"`
}

type System struct {
	Manufacturer    *string `json:"manufacturer"`
	Model           *string `json:"model"`
	SerialNumber    *string `json:"serial_number"`
	HardwareUUID    *string `json:"hardware_uuid"`
	Hostname        string  `json:"hostname"`
	OSName          *string `json:"os_name"`
	OSVersion       *string `json:"os_version"`
	OSBuild         *string `json:"os_build"`
	FirmwareVersion *string `json:"firmware_version"`
	ChipName        *string `json:"chip_name"`
}

type CPU struct {
	Manufacturer *string `json:"manufacturer"`
	Model        *string `json:"model"`
	Cores        *int64  `json:"cores"`
	Threads      *int64  `json:"threads"`
	BaseSpeedMHz *int64  `json:"base_speed_mhz"`
	IsIntegrated bool    `json:"is_integrated"`
}

type Memory struct {
	TotalBytes   *int64      `json:"total_bytes"`
	IsIntegrated bool        `json:"is_integrated"`
	Modules      []MemModule `json:"modules"` // nil encodes as null (Apple Silicon)
}

type MemModule struct {
	Slot         *string `json:"slot"`
	Manufacturer *string `json:"manufacturer"`
	SizeBytes    *int64  `json:"size_bytes"`
	SpeedMHz     *int64  `json:"speed_mhz"`
	PartNumber   *string `json:"part_number"`
	SerialNumber *string `json:"serial_number"`
}

type Disk struct {
	Model        *string `json:"model"`
	SerialNumber *string `json:"serial_number"`
	SizeBytes    *int64  `json:"size_bytes"`
	MediaType    *string `json:"media_type"` // ssd, hdd, unknown or null
	BusType      *string `json:"bus_type"`
	IsInternal   *bool   `json:"is_internal"`
	IsIntegrated bool    `json:"is_integrated"`
}

type Volume struct {
	MountPoint string  `json:"mount_point"`
	Label      *string `json:"label"`
	Filesystem *string `json:"filesystem"`
	SizeBytes  *int64  `json:"size_bytes"`
	FreeBytes  *int64  `json:"free_bytes"`
}

type Board struct {
	Manufacturer *string `json:"manufacturer"`
	Product      *string `json:"product"`
	SerialNumber *string `json:"serial_number"`
}

type GPU struct {
	Name          *string `json:"name"`
	MemoryBytes   *int64  `json:"memory_bytes"`
	DriverVersion *string `json:"driver_version"`
	IsIntegrated  bool    `json:"is_integrated"`
}

type Network struct {
	Adapters []Adapter `json:"adapters"`
	WifiSSID *string   `json:"wifi_ssid"`
}

type Adapter struct {
	Name        string   `json:"name"`
	MACAddress  *string  `json:"mac_address"`
	Type        string   `json:"type"` // ethernet, wifi, other
	IsPhysical  bool     `json:"is_physical"`
	IPAddresses []string `json:"ip_addresses"`
	Gateway     *string  `json:"gateway"`
	DNSServers  []string `json:"dns_servers"`
	DHCPEnabled *bool    `json:"dhcp_enabled"`
}

// Normalize replaces nil slices that the schema requires as arrays with empty ones.
func (s *Scan) Normalize() {
	if s.CPUs == nil {
		s.CPUs = []CPU{}
	}
	if s.Storage == nil {
		s.Storage = []Disk{}
	}
	if s.Volumes == nil {
		s.Volumes = []Volume{}
	}
	if s.GPUs == nil {
		s.GPUs = []GPU{}
	}
	if s.Network.Adapters == nil {
		s.Network.Adapters = []Adapter{}
	}
	for i := range s.Network.Adapters {
		a := &s.Network.Adapters[i]
		if a.IPAddresses == nil {
			a.IPAddresses = []string{}
		}
		if a.DNSServers == nil {
			a.DNSServers = []string{}
		}
	}
}

// Summary is the hardware_summary sent with registration.
type Summary struct {
	Manufacturer *string `json:"manufacturer"`
	Model        *string `json:"model"`
	SerialNumber *string `json:"serial_number"`
}

// UserDetails is the body of PUT /api/agent/user and the user's details kept locally.
type UserDetails struct {
	FullName   string  `json:"full_name"`
	EmployeeID string  `json:"employee_id"`
	Email      *string `json:"email"`
	Department string  `json:"department"`
	Position   *string `json:"position"`
	Phone      *string `json:"phone"`
}

// UserRequest is the body of PUT /api/agent/user: the details plus the current hourly IT PIN.
type UserRequest struct {
	UserDetails
	ITPIN string `json:"it_pin"`
}

// User is the registration's user: their details plus the data-use notice acceptance.
type User struct {
	UserDetails
	PolicyAcknowledged bool `json:"policy_acknowledged"`
}

type RegisterRequest struct {
	EnrollmentKey   string  `json:"enrollment_key"`
	ITPIN           string  `json:"it_pin"`
	DeviceUUID      string  `json:"device_uuid"`
	OSType          string  `json:"os_type"`
	Hostname        string  `json:"hostname"`
	HardwareSummary Summary `json:"hardware_summary"`
	User            User    `json:"user"`
}

type RegisterResponse struct {
	DeviceID               string `json:"device_id"`
	DeviceToken            string `json:"device_token"`
	CheckinIntervalSeconds int    `json:"checkin_interval_seconds"`
}

type ScanRequest struct {
	ScanUUID    string `json:"scan_uuid"`
	ScanType    string `json:"scan_type"`
	CollectedAt string `json:"collected_at"`
	// ITPIN is the hourly IT PIN; the server requires it for scan_type "manual" only.
	ITPIN   string `json:"it_pin,omitempty"`
	Payload *Scan  `json:"payload"`
}

type ScanResponse struct {
	ScanID string `json:"scan_id"`
}

// NetworkSnapshot mirrors contracts/agent-api/network-snapshot.schema.json.
type NetworkSnapshot struct {
	CollectedAt    string   `json:"collected_at"`
	IPAddresses    []string `json:"ip_addresses"`
	MACAddresses   []string `json:"mac_addresses"`
	Gateway        *string  `json:"gateway"`
	DNSServers     []string `json:"dns_servers"`
	ConnectionType string   `json:"connection_type"` // ethernet, wifi, other
	SSID           *string  `json:"ssid"`
}

// LogEntry mirrors one entry of logs.request.
type LogEntry struct {
	LocalEntryID int64  `json:"local_entry_id"`
	LoggedAt     string `json:"logged_at"`
	Level        string `json:"level"`
	Category     string `json:"category"`
	Message      string `json:"message"`
}

type LogsRequest struct {
	Entries []LogEntry `json:"entries"`
}

type LogsResponse struct {
	ReceivedIDs []int64 `json:"received_ids"`
}

type SettingsUnlockRequest struct {
	PIN string `json:"pin"`
}

type SettingsUnlockResponse struct {
	OK bool `json:"ok"`
}

// Request types a dashboard can queue (events.message).
const (
	RequestScanNow             = "scan_now"
	RequestSendLogs            = "send_logs"
	RequestPromptDetailsUpdate = "prompt_details_update"
)

// PendingRequest is the data of a "request" event.
type PendingRequest struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	CreatedAt string `json:"created_at"`
}

// RequestComplete mirrors request-complete.request; the optional fields are omitted when empty.
type RequestComplete struct {
	Result  string `json:"result"` // done or failed
	ScanID  string `json:"scan_id,omitempty"`
	Message string `json:"message,omitempty"`
}
