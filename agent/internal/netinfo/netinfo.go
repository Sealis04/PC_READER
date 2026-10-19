// Package netinfo collects the PC's network snapshot (IP, MAC, gateway, DNS, connection type,
// Wi-Fi name) and notices when it changes. The snapshot is built from the same parsers as the
// full scan, fed by a light collection of just the network commands.
package netinfo

import (
	"context"
	"net"
	"runtime"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan"
	"github.com/sealis04/pc_reader/agent/internal/scan/darwin"
	"github.com/sealis04/pc_reader/agent/internal/scan/windows"
)

// FromNetwork reduces a scan's network section to a snapshot: the addresses of every adapter
// that has one; the gateway, DNS servers and connection type of the adapter that carries the
// default route (else the first adapter with an address). The SSID is kept only on Wi-Fi.
func FromNetwork(n payload.Network, collectedAt time.Time) payload.NetworkSnapshot {
	snap := payload.NetworkSnapshot{
		CollectedAt:    collectedAt.UTC().Format(time.RFC3339),
		IPAddresses:    []string{},
		MACAddresses:   []string{},
		DNSServers:     []string{},
		ConnectionType: "other",
	}
	var primary *payload.Adapter
	for i := range n.Adapters {
		a := &n.Adapters[i]
		if len(a.IPAddresses) == 0 {
			continue
		}
		snap.IPAddresses = append(snap.IPAddresses, a.IPAddresses...)
		if a.MACAddress != nil {
			snap.MACAddresses = append(snap.MACAddresses, *a.MACAddress)
		}
		if primary == nil || (primary.Gateway == nil && a.Gateway != nil) {
			primary = a
		}
	}
	if primary != nil {
		snap.Gateway = primary.Gateway
		snap.ConnectionType = primary.Type
		if primary.DNSServers != nil {
			snap.DNSServers = primary.DNSServers
		}
		if primary.Type == "wifi" {
			snap.SSID = n.WifiSSID
		}
	}
	return snap
}

// Same reports whether two snapshots describe the same network (collected_at is ignored; the
// order of addresses is too).
func Same(a, b payload.NetworkSnapshot) bool {
	return slices.Equal(sorted(a.IPAddresses), sorted(b.IPAddresses)) &&
		slices.Equal(sorted(a.MACAddresses), sorted(b.MACAddresses)) &&
		slices.Equal(a.DNSServers, b.DNSServers) &&
		deref(a.Gateway) == deref(b.Gateway) && deref(a.SSID) == deref(b.SSID) &&
		(a.Gateway == nil) == (b.Gateway == nil) && (a.SSID == nil) == (b.SSID == nil) &&
		a.ConnectionType == b.ConnectionType
}

func sorted(s []string) []string {
	c := slices.Clone(s)
	sort.Strings(c)
	return c
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Collect reads this computer's network (the real collectors run on Windows and macOS).
func Collect(ctx context.Context) (payload.NetworkSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	now := time.Now()
	switch runtime.GOOS {
	case "windows":
		raw, err := windows.CollectNetwork(ctx, scan.Exec)
		if err != nil {
			return payload.NetworkSnapshot{}, err
		}
		n, err := windows.ParseNetwork(raw)
		if err != nil {
			return payload.NetworkSnapshot{}, err
		}
		return FromNetwork(n, now), nil
	case "darwin":
		raw, err := darwin.CollectNetwork(ctx, scan.Exec)
		if err != nil {
			return payload.NetworkSnapshot{}, err
		}
		return FromNetwork(darwin.ParseNetwork(raw), now), nil
	}
	return collectBasic(now)
}

// collectBasic is the fallback for other systems (Linux CI and test machines): addresses and
// MACs from the network interfaces, no gateway, DNS or SSID.
func collectBasic(now time.Time) (payload.NetworkSnapshot, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return payload.NetworkSnapshot{}, err
	}
	n := payload.Network{}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || len(ifc.HardwareAddr) == 0 {
			continue
		}
		a := payload.Adapter{Name: ifc.Name, Type: "other", IsPhysical: true, IPAddresses: []string{}}
		mac := strings.ToUpper(ifc.HardwareAddr.String())
		a.MACAddress = &mac
		addrs, _ := ifc.Addrs()
		for _, addr := range addrs {
			if ip, _, err := net.ParseCIDR(addr.String()); err == nil && !ip.IsLinkLocalUnicast() {
				a.IPAddresses = append(a.IPAddresses, ip.String())
			}
		}
		n.Adapters = append(n.Adapters, a)
	}
	return FromNetwork(n, now), nil
}

// Fingerprint is a cheap local check for "did the network change": the interfaces that are up
// with their addresses. It does no network traffic and starts no commands.
func Fingerprint() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var parts []string
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		var as []string
		for _, a := range addrs {
			if ip, _, err := net.ParseCIDR(a.String()); err == nil && ip.IsLinkLocalUnicast() {
				continue
			}
			as = append(as, a.String())
		}
		sort.Strings(as)
		parts = append(parts, ifc.Name+"="+strings.Join(as, ","))
	}
	sort.Strings(parts)
	return strings.Join(parts, ";")
}

// Watcher polls Fingerprint (cheap, local) and, when it changes, collects a snapshot and calls
// OnChange if it really differs from the last one sent. Nothing leaves the PC otherwise.
type Watcher struct {
	Interval    time.Duration // default 30 s
	Fingerprint func() string // default Fingerprint
	Collect     func(context.Context) (payload.NetworkSnapshot, error)
	OnChange    func(payload.NetworkSnapshot)
	OnError     func(error)

	last payload.NetworkSnapshot
	have bool
}

// Prime records snap as already reported (the one sent when the connection opened).
func (w *Watcher) Prime(snap payload.NetworkSnapshot) { w.last, w.have = snap, true }

// Run blocks until ctx ends.
func (w *Watcher) Run(ctx context.Context) {
	interval := w.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	fp := w.Fingerprint
	if fp == nil {
		fp = Fingerprint
	}
	prev := fp()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		cur := fp()
		if cur == prev {
			continue
		}
		prev = cur
		snap, err := w.Collect(ctx)
		if err != nil {
			if w.OnError != nil && ctx.Err() == nil {
				w.OnError(err)
			}
			continue
		}
		if w.have && Same(w.last, snap) {
			continue
		}
		w.last, w.have = snap, true
		w.OnChange(snap)
	}
}
