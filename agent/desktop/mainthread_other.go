//go:build !darwin

package main

// runOnMainThread: only macOS needs the main thread (Windows' tray runs its own pinned thread).
func runOnMainThread(f func()) { f() }
