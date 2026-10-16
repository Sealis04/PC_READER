// Command pcreader registers this computer with the PC_READER server and uploads hardware scans.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/api"
	"github.com/sealis04/pc_reader/agent/internal/config"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

const usage = `pcreader — PC_READER device agent

Usage:
  pcreader register --server URL --key KEY --name NAME --employee-id ID --department DEPT --accept-policy [options]
  pcreader scan [--upload] [--out FILE] [--type manual|startup|scheduled|on_demand]
  pcreader capture-raw --out DIR
  pcreader status
  pcreader version

Run "pcreader <command> -h" for a command's options.
`

const notice = `Data-use notice: PC_READER records your name, employee ID, department, position,
email and phone, plus this computer's hardware specs and basic network details
(IP and MAC addresses, gateway, DNS, Wi-Fi network name). It does not record
browsing, keystrokes, screenshots, files or location. IT uses this data only to
manage agency equipment.`

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "register":
		err = cmdRegister(ctx, args[1:], stdout, stderr)
	case "scan":
		err = cmdScan(ctx, args[1:], stdout, stderr)
	case "capture-raw":
		err = cmdCaptureRaw(ctx, args[1:], stdout, stderr)
	case "status":
		err = cmdStatus(stdout)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, "pcreader", version)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

func newFlags(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("pcreader "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

// collect scans this computer, or parses a folder saved by capture-raw (--from-raw).
func collect(ctx context.Context, fromRaw string) (*payload.Scan, error) {
	var raw rd.Set
	var err error
	if fromRaw != "" {
		raw, err = rd.Load(fromRaw)
	} else {
		raw, err = scan.CollectRaw(ctx)
	}
	if err != nil {
		return nil, err
	}
	return scan.Parse(raw, version)
}

func checkServerURL(s string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("--server must be a URL like http://192.168.1.10:3000 (got %q)", s)
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func cmdRegister(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("register", stderr)
	server := fs.String("server", "", "server URL, e.g. http://192.168.1.10:3000 (required)")
	key := fs.String("key", os.Getenv("PCREADER_ENROLLMENT_KEY"), "enrollment key from IT (or set PCREADER_ENROLLMENT_KEY)")
	name := fs.String("name", "", "user's full name (required)")
	employeeID := fs.String("employee-id", "", "employee ID (required)")
	department := fs.String("department", "", "department (required)")
	email := fs.String("email", "", "email")
	position := fs.String("position", "", "position")
	phone := fs.String("phone", "", "phone")
	accept := fs.Bool("accept-policy", false, "confirm the user has read and accepted the data-use notice (required)")
	fromRaw := fs.String("from-raw", "", "use a folder saved by capture-raw instead of scanning (testing)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	serverURL, err := checkServerURL(*server)
	if err != nil {
		return err
	}
	var missing []string
	for flagName, v := range map[string]string{"key": *key, "name": *name, "employee-id": *employeeID, "department": *department} {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, "--"+flagName)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required options: %s", strings.Join(missing, ", "))
	}
	if !*accept {
		fmt.Fprintln(stderr, notice)
		return errors.New("the user must accept the data-use notice: add --accept-policy")
	}

	fmt.Fprintln(stdout, "Scanning this computer...")
	s, err := collect(ctx, *fromRaw)
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	req := payload.RegisterRequest{
		EnrollmentKey: strings.TrimSpace(*key),
		DeviceUUID:    cfg.EnsureDeviceUUID(),
		OSType:        s.OSType,
		Hostname:      s.System.Hostname,
		HardwareSummary: payload.Summary{
			Manufacturer: s.System.Manufacturer,
			Model:        s.System.Model,
			SerialNumber: s.System.SerialNumber,
		},
		User: payload.User{
			FullName:           strings.TrimSpace(*name),
			EmployeeID:         strings.TrimSpace(*employeeID),
			Email:              rd.StrPtr(*email),
			Department:         strings.TrimSpace(*department),
			Position:           rd.StrPtr(*position),
			Phone:              rd.StrPtr(*phone),
			PolicyAcknowledged: true,
		},
	}
	res, err := api.New(serverURL).Register(ctx, req)
	if err != nil {
		return fmt.Errorf("registration failed: %w", err)
	}
	if err := config.NewTokenStore().Set(cfg.DeviceUUID, res.DeviceToken); err != nil {
		return fmt.Errorf("registered, but the token could not be saved to the credential store: %w", err)
	}
	cfg.ServerURL = serverURL
	cfg.DeviceID = res.DeviceID
	cfg.RegisteredAt = time.Now().UTC().Format(time.RFC3339)
	if err := cfg.Save(); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Registered %s as device %s.\nNext: pcreader scan --upload\n", s.System.Hostname, res.DeviceID)
	return nil
}

func cmdScan(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("scan", stderr)
	upload := fs.Bool("upload", false, "send the scan to the server")
	out := fs.String("out", "", "write the scan payload to this JSON file")
	scanType := fs.String("type", "manual", "scan type: manual, startup, scheduled or on_demand")
	server := fs.String("server", "", "override the registered server URL")
	fromRaw := fs.String("from-raw", "", "use a folder saved by capture-raw instead of scanning")
	if err := fs.Parse(args); err != nil {
		return err
	}
	switch *scanType {
	case "manual", "startup", "scheduled", "on_demand":
	default:
		return fmt.Errorf("--type must be manual, startup, scheduled or on_demand")
	}

	collectedAt := time.Now().UTC()
	s, err := collect(ctx, *fromRaw)
	if err != nil {
		return err
	}

	if *out != "" {
		b, _ := json.MarshalIndent(s, "", "  ")
		if err := os.WriteFile(*out, append(b, '\n'), 0o644); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "Wrote", *out)
	}
	if !*upload {
		if *out == "" {
			b, _ := json.MarshalIndent(s, "", "  ")
			fmt.Fprintln(stdout, string(b))
		}
		return nil
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.DeviceUUID == "" || cfg.ServerURL == "" {
		return errors.New("this computer is not registered yet; run `pcreader register` first")
	}
	serverURL := cfg.ServerURL
	if *server != "" {
		if serverURL, err = checkServerURL(*server); err != nil {
			return err
		}
	}
	token, err := config.NewTokenStore().Get(cfg.DeviceUUID)
	if err != nil {
		return err
	}
	id, dup, err := api.New(serverURL).UploadScan(ctx, token, payload.ScanRequest{
		ScanUUID:    config.NewUUID(),
		ScanType:    *scanType,
		CollectedAt: collectedAt.Format(time.RFC3339Nano),
		Payload:     s,
	})
	if err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}
	if dup {
		fmt.Fprintln(stdout, "Scan was already on the server:", id)
	} else {
		fmt.Fprintln(stdout, "Uploaded scan", id)
	}
	return nil
}

func cmdCaptureRaw(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("capture-raw", stderr)
	out := fs.String("out", "", "folder to save raw command output in (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *out == "" {
		return errors.New("--out is required")
	}
	raw, err := scan.CollectRaw(ctx)
	if err != nil {
		return err
	}
	if err := raw.Save(*out); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Saved %d files to %s\n", len(raw), *out)
	if _, err := scan.Parse(raw, version); err != nil {
		fmt.Fprintln(stderr, "warning: the capture could not be parsed:", err)
	}
	return nil
}

func cmdStatus(stdout io.Writer) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	dir, _ := config.Dir()
	fmt.Fprintln(stdout, "pcreader", version)
	fmt.Fprintln(stdout, "Data folder:", dir)
	if cfg.DeviceID == "" {
		fmt.Fprintln(stdout, "Not registered.")
		return nil
	}
	_, tokenErr := config.NewTokenStore().Get(cfg.DeviceUUID)
	fmt.Fprintln(stdout, "Server:     ", cfg.ServerURL)
	fmt.Fprintln(stdout, "Device ID:  ", cfg.DeviceID)
	fmt.Fprintln(stdout, "Device UUID:", cfg.DeviceUUID)
	fmt.Fprintln(stdout, "Registered: ", cfg.RegisteredAt)
	if tokenErr != nil {
		fmt.Fprintln(stdout, "Token:       missing —", tokenErr)
	} else {
		fmt.Fprintln(stdout, "Token:       stored")
	}
	return nil
}
