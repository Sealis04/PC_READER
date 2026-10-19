package main

import (
	"testing"
	"time"
)

// runPinned must run the function on a goroutine of its own (so Wails' startup is not blocked
// by the tray's message loop) and keep running until the function returns.
func TestRunPinnedRunsOnOwnGoroutine(t *testing.T) {
	done := make(chan struct{})
	started := make(chan struct{})
	runPinned(func() {
		close(started)
		<-done
	})
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("pinned function did not start")
	}
	close(done)
}

func TestNewTrayKeepsCallbacks(t *testing.T) {
	opened, reported := 0, 0
	tr := newTray(func() { opened++ }, func() { reported++ })
	tr.open()
	tr.report()
	if opened != 1 || reported != 1 {
		t.Fatalf("callbacks not wired: open=%d report=%d", opened, reported)
	}
	tr.SetStatus("Connected") // safe before Start
	if tr.text != "Connected" {
		t.Fatalf("status = %q", tr.text)
	}
}
