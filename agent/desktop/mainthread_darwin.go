//go:build darwin

package main

/*
#include <stdint.h>
#include <dispatch/dispatch.h>

extern void goMainThreadCallback(uintptr_t handle);

static void mainThreadTrampoline(void *ctx) { goMainThreadCallback((uintptr_t)ctx); }

static void dispatchToMain(uintptr_t handle) {
	dispatch_async_f(dispatch_get_main_queue(), (void *)handle, mainThreadTrampoline);
}
*/
import "C"

import "runtime/cgo"

//export goMainThreadCallback
func goMainThreadCallback(handle C.uintptr_t) {
	h := cgo.Handle(handle)
	f := h.Value().(func())
	h.Delete()
	f()
}

// runOnMainThread schedules f on the macOS main (Cocoa) thread and returns at once. AppKit objects
// (the menu-bar status item) may only be created there; Wails' OnStartup runs on a goroutine.
func runOnMainThread(f func()) {
	C.dispatchToMain(C.uintptr_t(cgo.NewHandle(f)))
}
