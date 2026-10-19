// Command pcreader registers this computer with the PC_READER server and uploads hardware scans.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/app"
	"github.com/sealis04/pc_reader/agent/internal/background"
	"github.com/sealis04/pc_reader/agent/internal/events"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan"
	rd "github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

// svc is the shared service layer (also used by the desktop app).
var svc = app.New(version)

const usage = `pcreader — PC_READER device agent

Usage:
  pcreader register --server URL --key KEY --name NAME --employee-id ID --department DEPT --accept-policy [options]
  pcreader scan [--upload] [--out FILE] [--type manual|startup|scheduled|on_demand]
  pcreader capture-raw --out DIR
  pcreader listen [--from-raw DIR]
  pcreader status
  pcreader version

Run "pcreader <command> -h" for a command's options.
`

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
	case "listen":
		err = cmdListen(ctx, args[1:], stdout, stderr)
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

func checkServerURL(s string) (string, error) {
	u, err := app.NormalizeServerURL(s)
	if err != nil {
		return "", fmt.Errorf("--server %w", err)
	}
	return u, nil
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
		fmt.Fprintln(stderr, app.Notice)
		return errors.New("the user must accept the data-use notice: add --accept-policy")
	}

	fmt.Fprintln(stdout, "Scanning this computer...")
	res, err := svc.Register(ctx, app.RegisterInput{
		ServerURL: serverURL,
		Key:       *key,
		User: payload.UserDetails{
			FullName:   *name,
			EmployeeID: *employeeID,
			Email:      rd.StrPtr(*email),
			Department: *department,
			Position:   rd.StrPtr(*position),
			Phone:      rd.StrPtr(*phone),
		},
		FromRaw: *fromRaw,
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Registered %s as device %s.\nNext: pcreader scan --upload\n", res.Hostname, res.DeviceID)
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
	s, err := svc.Collect(ctx, *fromRaw)
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

	id, dup, err := svc.Upload(ctx, s, collectedAt, app.UploadOptions{ScanType: *scanType, ServerURL: *server})
	if err != nil {
		return err
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
	st, err := svc.Status()
	if err != nil {
		return err
	}
	fmt.Fprintln(stdout, "pcreader", version)
	fmt.Fprintln(stdout, "Data folder:", st.Dir)
	if !st.Registered {
		fmt.Fprintln(stdout, "Not registered.")
		return nil
	}
	fmt.Fprintln(stdout, "Server:     ", st.ServerURL)
	fmt.Fprintln(stdout, "Device ID:  ", st.DeviceID)
	fmt.Fprintln(stdout, "Device UUID:", st.DeviceUUID)
	fmt.Fprintln(stdout, "Registered: ", st.RegisteredAt)
	if st.TokenErr != nil {
		fmt.Fprintln(stdout, "Token:       missing —", st.TokenErr)
	} else {
		fmt.Fprintln(stdout, "Token:       stored")
	}
	return nil
}

// cmdListen runs what the desktop app runs in the background, in the foreground: it holds the
// events connection and acts on dashboard requests until interrupted. For testing on Linux/CI
// and for debugging; --from-raw answers scan_now from a saved raw folder instead of scanning.
func cmdListen(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("listen", stderr)
	fromRaw := fs.String("from-raw", "", "answer scan_now from this raw-data folder instead of scanning (testing)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	store, err := background.OpenLog()
	if err != nil {
		return fmt.Errorf("local log: %w", err)
	}
	defer store.Close()
	svc.Log = func(level, category, msg string) { _ = store.Add(level, category, msg) }
	if *fromRaw != "" {
		svc.Scan = func(context.Context) (rd.Set, error) { return rd.Load(*fromRaw) }
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	r := &background.Runner{
		Svc: svc, Log: store, Version: version,
		OnStatus: func(s background.Status) { fmt.Fprintln(stdout, "status:", s.Label()) },
		OnPrompt: func() { fmt.Fprintln(stdout, "IT asked you to confirm your details (open the PC_READER app)") },
	}
	fmt.Fprintln(stdout, "Listening for requests from the server. Press Ctrl+C to stop.")
	err = r.Run(ctx)
	switch {
	case errors.Is(err, context.Canceled):
		return nil
	case errors.Is(err, events.ErrReregister):
		return errors.New("the server no longer recognises this computer; register again")
	}
	return err
}
