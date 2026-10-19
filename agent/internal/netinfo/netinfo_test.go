package netinfo

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sealis04/pc_reader/agent/internal/contract"
	"github.com/sealis04/pc_reader/agent/internal/payload"
	"github.com/sealis04/pc_reader/agent/internal/scan/darwin"
	"github.com/sealis04/pc_reader/agent/internal/scan/rawdata"
	"github.com/sealis04/pc_reader/agent/internal/scan/windows"
)

var at = time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)

func TestSnapshotFromWindowsFixture(t *testing.T) {
	raw, err := rawdata.Load(contract.Fixture("raw/windows"))
	if err != nil {
		t.Fatal(err)
	}
	n, err := windows.ParseNetwork(raw)
	if err != nil {
		t.Fatal(err)
	}
	snap := FromNetwork(n, at)
	if err := contract.Validate("network", snap); err != nil {
		t.Fatalf("snapshot does not match the contract: %v", err)
	}
	if snap.ConnectionType != "ethernet" || len(snap.IPAddresses) == 0 || snap.Gateway == nil || snap.SSID != nil {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
}

func TestSnapshotFromMacFixture(t *testing.T) {
	raw, err := rawdata.Load(contract.Fixture("raw/macos"))
	if err != nil {
		t.Fatal(err)
	}
	snap := FromNetwork(darwin.ParseNetwork(raw), at)
	if err := contract.Validate("network", snap); err != nil {
		t.Fatalf("snapshot does not match the contract: %v", err)
	}
	if len(snap.IPAddresses) == 0 || len(snap.MACAddresses) == 0 {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
}

func sp(s string) *string { return &s }

func TestFromNetworkPicksDefaultRouteAdapterAndKeepsSSIDOnlyOnWifi(t *testing.T) {
	n := payload.Network{WifiSSID: sp("OFFICE")}
	n.Adapters = []payload.Adapter{
		{Name: "Ethernet", MACAddress: sp("AA:AA:AA:AA:AA:01"), Type: "ethernet", IPAddresses: []string{"10.0.0.5"}},
		{Name: "Wi-Fi", MACAddress: sp("AA:AA:AA:AA:AA:02"), Type: "wifi", IPAddresses: []string{"192.168.1.9"}, Gateway: sp("192.168.1.1"), DNSServers: []string{"1.1.1.1"}},
		{Name: "Down", MACAddress: sp("AA:AA:AA:AA:AA:03"), Type: "other"},
	}
	snap := FromNetwork(n, at)
	if snap.ConnectionType != "wifi" || deref(snap.SSID) != "OFFICE" || deref(snap.Gateway) != "192.168.1.1" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if len(snap.MACAddresses) != 2 || len(snap.IPAddresses) != 2 || snap.DNSServers[0] != "1.1.1.1" {
		t.Fatalf("addresses = %+v", snap)
	}

	n.Adapters = n.Adapters[:1]
	n.Adapters[0].Gateway = sp("10.0.0.1")
	snap = FromNetwork(n, at)
	if snap.ConnectionType != "ethernet" || snap.SSID != nil {
		t.Fatalf("ethernet snapshot = %+v", snap)
	}

	empty := FromNetwork(payload.Network{}, at)
	if err := contract.Validate("network", empty); err != nil || empty.ConnectionType != "other" {
		t.Fatalf("offline snapshot invalid: %v %+v", err, empty)
	}
}

func TestSame(t *testing.T) {
	a := payload.NetworkSnapshot{IPAddresses: []string{"1.1.1.1", "2.2.2.2"}, ConnectionType: "wifi", SSID: sp("x"), Gateway: sp("g"), CollectedAt: "a"}
	b := a
	b.IPAddresses = []string{"2.2.2.2", "1.1.1.1"}
	b.CollectedAt = "b"
	if !Same(a, b) {
		t.Fatal("order and collected_at must not matter")
	}
	for name, mod := range map[string]func(*payload.NetworkSnapshot){
		"ip":      func(s *payload.NetworkSnapshot) { s.IPAddresses = []string{"3.3.3.3"} },
		"ssid":    func(s *payload.NetworkSnapshot) { s.SSID = sp("y") },
		"no ssid": func(s *payload.NetworkSnapshot) { s.SSID = nil },
		"gateway": func(s *payload.NetworkSnapshot) { s.Gateway = nil },
		"type":    func(s *payload.NetworkSnapshot) { s.ConnectionType = "ethernet" },
		"dns":     func(s *payload.NetworkSnapshot) { s.DNSServers = []string{"8.8.8.8"} },
	} {
		c := a
		mod(&c)
		if Same(a, c) {
			t.Fatalf("%s change not detected", name)
		}
	}
}

func TestWatcherReportsOnlyRealChanges(t *testing.T) {
	var fp atomic.Value
	fp.Store("one")
	snaps := make(chan payload.NetworkSnapshot, 4)
	first := payload.NetworkSnapshot{IPAddresses: []string{"1.1.1.1"}, ConnectionType: "ethernet"}
	var cur atomic.Pointer[payload.NetworkSnapshot]
	cur.Store(&first)
	var collects atomic.Int32
	w := &Watcher{
		Interval:    5 * time.Millisecond,
		Fingerprint: func() string { return fp.Load().(string) },
		Collect: func(context.Context) (payload.NetworkSnapshot, error) {
			collects.Add(1)
			return *cur.Load(), nil
		},
		OnChange: func(s payload.NetworkSnapshot) { snaps <- s },
	}
	w.Prime(first)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)
	time.Sleep(30 * time.Millisecond) // let Run read the starting fingerprint

	// Fingerprint changes but the snapshot is the same as the primed one: no report.
	fp.Store("two")
	time.Sleep(60 * time.Millisecond)
	if len(snaps) != 0 || collects.Load() != 1 {
		t.Fatalf("reported %d, collected %d; want 0 reports after 1 collect", len(snaps), collects.Load())
	}
	// A real change is reported once; an unchanged fingerprint triggers no more collects.
	changed := payload.NetworkSnapshot{IPAddresses: []string{"9.9.9.9"}, ConnectionType: "wifi"}
	cur.Store(&changed)
	fp.Store("three")
	select {
	case s := <-snaps:
		if s.IPAddresses[0] != "9.9.9.9" {
			t.Fatalf("snapshot = %+v", s)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("change not reported")
	}
	time.Sleep(40 * time.Millisecond)
	if collects.Load() != 2 || len(snaps) != 0 {
		t.Fatalf("collects = %d, extra reports = %d", collects.Load(), len(snaps))
	}
}

func TestWatcherReportsCollectErrors(t *testing.T) {
	var fp atomic.Value
	fp.Store("a")
	errs := make(chan error, 1)
	w := &Watcher{Interval: 5 * time.Millisecond, Fingerprint: func() string { return fp.Load().(string) },
		Collect: func(context.Context) (payload.NetworkSnapshot, error) {
			return payload.NetworkSnapshot{}, errors.New("boom")
		},
		OnChange: func(payload.NetworkSnapshot) { t.Error("must not report on error") },
		OnError:  func(err error) { errs <- err }}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)
	time.Sleep(30 * time.Millisecond) // let Run read the starting fingerprint
	fp.Store("b")
	select {
	case <-errs:
	case <-time.After(2 * time.Second):
		t.Fatal("error not reported")
	}
}
