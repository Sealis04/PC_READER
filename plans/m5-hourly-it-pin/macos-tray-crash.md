# Handoff: [branch-name]

> Written 2026-10-20. Start here if picking up this work.

## Summary
The PC_READER macOS desktop app (`agent/desktop`, Wails v2.10.2 + `fyne.io/systray` v1.12.2, Go 1.24, arm64) crashes immediately on launch with `NSInternalInconsistencyException: 'NSWindow should only be instantiated on the main thread!'`. The cause has been diagnosed from the crash trace: the system tray is started from Wails' startup callback, which runs on a background goroutine, and AppKit refuses to create the menu-bar status item off the main thread. A fix has been designed (dispatch the tray start onto the main thread via GCD) but has not yet been applied or tested.

## Status
- **Completed:**
  - Root cause identified from the crash trace (see "Root cause" below).
  - Fix designed: two small platform files plus a one-line change in `main.go`.
- **In Progress:**
  - Nothing currently mid-edit.
- **Not Started:**
  - Adding `mainthread_darwin.go` and `mainthread_other.go`.
  - Wrapping the tray start in `runOnMainThread` in `main.go` (~line 197).
  - Rebuilding and verifying on macOS.
  - Checking Windows/Linux builds still work.

## Root cause
Call chain from the trace:

1. `main.go:168` calls `wails.Run(...)`; Wails takes the main thread for the Cocoa run loop.
2. Wails invokes the startup callback (`main.go:197`) on goroutine 37, not the main thread.
3. That calls `tray.Start()` (`tray.go:62`), which calls `systray.nativeStart()`.
4. `nativeStart` creates an `NSStatusItem` → `NSStatusBarWindow` → `NSWindow` off the main thread.
5. AppKit throws, the process gets `SIGABRT`.

This only fails on macOS; Windows and Linux don't enforce main-thread UI creation, so the bug can hide on those platforms.

## Key Decisions
- **Dispatch to main thread via GCD rather than migrate frameworks.** Wails already runs the main Cocoa run loop, so `dispatch_async_f(dispatch_get_main_queue(), ...)` will execute the tray start safely. Migrating to Wails v3 (which has a built-in tray) was considered but is a much larger change.
- **Only the initial start is dispatched.** `fyne.io/systray` already marshals later menu-item updates to the main thread internally.

## How to Continue
1. Create `agent/desktop/mainthread_darwin.go`:

   ```go
   //go:build darwin

   package main

   /*
   #include <dispatch/dispatch.h>
   extern void goMainThreadCallback(void);
   static void callback_trampoline(void *ctx) { goMainThreadCallback(); }
   static void dispatchToMain(void) {
       dispatch_async_f(dispatch_get_main_queue(), NULL, callback_trampoline);
   }
   */
   import "C"

   var mainThreadFn func()

   //export goMainThreadCallback
   func goMainThreadCallback() {
   	if f := mainThreadFn; f != nil {
   		mainThreadFn = nil
   		f()
   	}
   }

   // runOnMainThread schedules f on the macOS main (Cocoa) thread.
   func runOnMainThread(f func()) {
   	mainThreadFn = f
   	C.dispatchToMain()
   }
   ```

2. Create `agent/desktop/mainthread_other.go`:

   ```go
   //go:build !darwin

   package main

   func runOnMainThread(f func()) { f() }
   ```

3. In `main.go` around line 197, replace the direct tray start (e.g. `t.Start()`) with `runOnMainThread(t.Start)`. If `tray.Start()` uses `systray.RunWithExternalLoop(...)`, make sure the returned `start()` call ends up inside the dispatched function.
4. Rebuild and run the binary directly so errors are visible:

   ```bash
   wails build -platform darwin/arm64
   ./build/bin/PC_READER.app/Contents/MacOS/pcreader-desktop
   ```

5. Test: app window opens, tray icon appears in the menu bar, tray menu items work, quitting from the tray exits cleanly.
6. Build for Windows/Linux to confirm the `!darwin` stub compiles and the tray still works there.

## Known Risks / Tech Debt
- `mainThreadFn` is a single global slot. Fine for one call at startup; if `runOnMainThread` is reused for multiple concurrent calls, replace it with a queue or a `cgo.Handle`-based approach.
- Adds cgo + Objective-C runtime dependency in the desktop agent (already present via Wails/systray, so build requirements don't change).
- If the crash persists after the fix, capture the new trace and inspect `tray.go`; another Cocoa call might be happening off-thread in `onReady`.

## Files Reference
- `agent/desktop/main.go` — Wails app setup (line 168) and startup callback that starts the tray (line 197).
- `agent/desktop/tray.go` — tray wrapper; `Start()` at line 62 calls into `fyne.io/systray`.
- `agent/desktop/mainthread_darwin.go` — *(new)* GCD main-thread dispatch helper.
- `agent/desktop/mainthread_other.go` — *(new)* no-op passthrough for non-macOS.


## Appendix: Full Crash Output

Verbatim terminal output from launching `pcreader-desktop` directly on macOS (arm64). The first and last register dumps are from repeated launches; the key lines are the `NSInternalInconsistencyException` and the goroutine 37 stack.

```text
r10     0x2
r11     0xfffffffd
r12     0x0
r13     0x0
r14     0x0
r15     0x0
r16     0x148
r17     0x1f8597358
r18     0x0
r19     0x6
r20     0x1503
r21     0x16e0770e0
r22     0x1f447c000
r23     0x2
r24     0x400100000
r25     0x16e076b40
r26     0x1055fad08
r27     0x820
r28     0x1f0169000
r29     0x16e0758f0
lr      0x18a5178d8
sp      0x16e0758d0
pc      0x18a4dc5e8
fault   0x18a4dc5e8
KertIA@admins-MacBook-Pro Applications % cls
zsh: command not found: cls
KertIA@admins-MacBook-Pro Applications % clr
zsh: command not found: clr
KertIA@admins-MacBook-Pro Applications % clear

KertIA@admins-MacBook-Pro Applications % "/Users/KertIA/DOwnloads/PC_READER.app/Contents/MacOS/pcreader-desktop"
*** Terminating app due to uncaught exception 'NSInternalInconsistencyException', reason: 'NSWindow should only be instantiated on the main thread!'
*** First throw call stack:
(
	0   CoreFoundation                      0x000000018a6431f0 __exceptionPreprocess + 176
	1   libobjc.A.dylib                     0x000000018a0be91c objc_exception_throw + 88
	2   CoreFoundation                      0x000000018a666bc8 _CFBundleGetValueForInfoKey + 0
	3   AppKit                              0x000000018ea1b2c4 -[NSWindow _initContent:styleMask:backing:defer:contentView:] + 260
	4   AppKit                              0x000000018ea1b1b4 -[NSWindow initWithContentRect:styleMask:backing:defer:] + 48
	5   AppKit                              0x000000018f593ed4 -[NSStatusBarWindow initForStatusItem:] + 236
	6   AppKit                              0x000000018f5977fc -[NSStatusItem _initWithStatusBar:length:priority:systemInsertOrder:activeItem:] + 396
	7   AppKit                              0x000000018f466adc -[NSSceneStatusItem _initWithStatusBar:length:priority:systemInsertOrder:activeItem:] + 44
	8   AppKit                              0x000000018ec16278 -[NSStatusBar _statusItemWithLength:withPriority:] + 108
	9   pcreader-desktop                    0x0000000102c13024 _cgo_e5b7842d7657_Cfunc_show_menu_item + 956
	10  pcreader-desktop                    0x0000000102c14970 nativeStart + 200
	11  pcreader-desktop                    0x0000000102c12a34 _cgo_e5b7842d7657_Cfunc_nativeStart + 28
	12  pcreader-desktop                    0x00000001026cec3c pcreader-desktop + 502844
)
libc++abi: terminating due to uncaught exception of type NSException
SIGABRT: abort
PC=0x18a4dc5e8 m=9 sigcode=0
signal arrived during cgo execution

goroutine 37 gp=0x14000582700 m=9 mp=0x14000680008 [syscall]:
runtime.cgocall(0x102c12a18, 0x140004acf38)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/cgocall.go:167 +0x44 fp=0x140004acf00 sp=0x140004acec0 pc=0x1026c3c24
fyne.io/systray._Cfunc_nativeStart()
	_cgo_gotypes.go:160 +0x30 fp=0x140004acf30 sp=0x140004acf00 pc=0x102bcbb50
fyne.io/systray.nativeStart()
	/Users/runner/go/pkg/mod/fyne.io/systray@v1.12.2/systray_darwin.go:77 +0x1c fp=0x140004acf40 sp=0x140004acf30 pc=0x102bcbe3c
main.(*tray).Start(0x1400014d540)
	/Users/runner/work/PC_READER/PC_READER/agent/desktop/tray.go:62 +0xd4 fp=0x140004acf70 sp=0x140004acf40 pc=0x102bcdbf4
main.main.func4({0x102e98848, 0x140001eb7a0})
	/Users/runner/work/PC_READER/PC_READER/agent/desktop/main.go:197 +0x164 fp=0x140004acfb0 sp=0x140004acf70 pc=0x102bcd904
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).Run.func1()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:212 +0x38 fp=0x140004acfd0 sp=0x140004acfb0 pc=0x10299d528
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x140004acfd0 sp=0x140004acfd0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).Run in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:210 +0x1b0

goroutine 1 gp=0x140000021c0 m=0 mp=0x1033692e0 [syscall, locked to thread]:
runtime.cgocall(0x102c16a74, 0x14000033d68)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/cgocall.go:167 +0x44 fp=0x14000033d30 sp=0x14000033cf0 pc=0x1026c3c24
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin._Cfunc_Run(0xa2683c120, 0xa26a7c370)
	_cgo_gotypes.go:553 +0x30 fp=0x14000033d60 sp=0x14000033d30 pc=0x102999700
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Window).Run.func1(...)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/window.go:167
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Window).Run(0x140004ba000, {0x14000284000?, 0x102e92d00?})
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/window.go:167 +0x68 fp=0x14000033da0 sp=0x14000033d60 pc=0x1029a0498
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).Run(0x140001a4ea0, {0x102e98848, 0x140001eb7a0})
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:215 +0x1cc fp=0x14000033de0 sp=0x14000033da0 pc=0x10299d48c
github.com/wailsapp/wails/v2/internal/app.(*App).Run(0x14000195590)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/app/app_production.go:18 +0x38 fp=0x14000033e20 sp=0x14000033de0 pc=0x1029a5e88
github.com/wailsapp/wails/v2/pkg/application.(*Application).Run(0x140003cac00)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/pkg/application/application.go:73 +0xac fp=0x14000033e50 sp=0x14000033e20 pc=0x1029a728c
github.com/wailsapp/wails/v2.Run(0x14000022480?)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/wails.go:14 +0xa8 fp=0x14000033e80 sp=0x14000033e50 pc=0x1029a7448
main.main()
	/Users/runner/work/PC_READER/PC_READER/agent/desktop/main.go:168 +0x7c4 fp=0x14000033f40 sp=0x14000033e80 pc=0x102bcd5e4
runtime.main()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:283 +0x284 fp=0x14000033fd0 sp=0x14000033f40 pc=0x102693a24
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x14000033fd0 sp=0x14000033fd0 pc=0x1026cee44

goroutine 2 gp=0x14000002c40 m=nil [force gc (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005cf90 sp=0x1400005cf70 pc=0x1026c6dc8
runtime.goparkunlock(...)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:441
runtime.forcegchelper()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:348 +0xb8 fp=0x1400005cfd0 sp=0x1400005cf90 pc=0x102693d78
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005cfd0 sp=0x1400005cfd0 pc=0x1026cee44
created by runtime.init.7 in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:336 +0x24

goroutine 3 gp=0x14000003180 m=nil [GC sweep wait]:
runtime.gopark(0x1?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005d760 sp=0x1400005d740 pc=0x1026c6dc8
runtime.goparkunlock(...)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:441
runtime.bgsweep(0x14000088000)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgcsweep.go:316 +0x108 fp=0x1400005d7b0 sp=0x1400005d760 pc=0x10267ee78
runtime.gcenable.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:204 +0x28 fp=0x1400005d7d0 sp=0x1400005d7b0 pc=0x102672c88
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005d7d0 sp=0x1400005d7d0 pc=0x1026cee44
created by runtime.gcenable in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:204 +0x6c

goroutine 4 gp=0x14000003340 m=nil [GC scavenge wait]:
runtime.gopark(0x10000?, 0x102d83cb8?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005df60 sp=0x1400005df40 pc=0x1026c6dc8
runtime.goparkunlock(...)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:441
runtime.(*scavengerState).park(0x103367dc0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgcscavenge.go:425 +0x5c fp=0x1400005df90 sp=0x1400005df60 pc=0x10267c91c
runtime.bgscavenge(0x14000088000)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgcscavenge.go:658 +0xac fp=0x1400005dfb0 sp=0x1400005df90 pc=0x10267cebc
runtime.gcenable.gowrap2()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:205 +0x28 fp=0x1400005dfd0 sp=0x1400005dfb0 pc=0x102672c28
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005dfd0 sp=0x1400005dfd0 pc=0x1026cee44
created by runtime.gcenable in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:205 +0xac

goroutine 5 gp=0x14000003c00 m=nil [finalizer wait]:
runtime.gopark(0x1400005c5b8?, 0x1026c7a04?, 0x1?, 0xc5?, 0x1027077b4?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005c590 sp=0x1400005c570 pc=0x1026c6dc8
runtime.runfinq()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mfinal.go:196 +0x108 fp=0x1400005c7d0 sp=0x1400005c590 pc=0x102671c88
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005c7d0 sp=0x1400005c7d0 pc=0x1026cee44
created by runtime.createfing in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mfinal.go:166 +0x80

goroutine 6 gp=0x14000003dc0 m=nil [GC worker (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005e710 sp=0x1400005e6f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400005e7b0 sp=0x1400005e710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400005e7d0 sp=0x1400005e7b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005e7d0 sp=0x1400005e7d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 18 gp=0x14000102380 m=nil [GC worker (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x14000058710 sp=0x140000586f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x140000587b0 sp=0x14000058710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x140000587d0 sp=0x140000587b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x140000587d0 sp=0x140000587d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 34 gp=0x14000504000 m=nil [GC worker (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050a710 sp=0x1400050a6f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400050a7b0 sp=0x1400050a710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400050a7d0 sp=0x1400050a7b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050a7d0 sp=0x1400050a7d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 7 gp=0x14000490000 m=nil [GC worker (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005ef10 sp=0x1400005eef0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400005efb0 sp=0x1400005ef10 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400005efd0 sp=0x1400005efb0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005efd0 sp=0x1400005efd0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 19 gp=0x14000102540 m=nil [GC worker (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x14000058f10 sp=0x14000058ef0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x14000058fb0 sp=0x14000058f10 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x14000058fd0 sp=0x14000058fb0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x14000058fd0 sp=0x14000058fd0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 20 gp=0x14000102700 m=nil [GC worker (idle)]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x14000059710 sp=0x140000596f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x140000597b0 sp=0x14000059710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x140000597d0 sp=0x140000597b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x140000597d0 sp=0x140000597d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 35 gp=0x140005041c0 m=nil [GC worker (idle)]:
runtime.gopark(0x84d6cbea48b?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400006cf10 sp=0x1400006cef0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400006cfb0 sp=0x1400006cf10 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400006cfd0 sp=0x1400006cfb0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400006cfd0 sp=0x1400006cfd0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 21 gp=0x140001028c0 m=nil [GC worker (idle)]:
runtime.gopark(0x84d6cbd91a4?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x14000059f10 sp=0x14000059ef0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x14000059fb0 sp=0x14000059f10 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x14000059fd0 sp=0x14000059fb0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x14000059fd0 sp=0x14000059fd0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 8 gp=0x140004901c0 m=nil [GC worker (idle)]:
runtime.gopark(0x84d6cbd90aa?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005f710 sp=0x1400005f6f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400005f7b0 sp=0x1400005f710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400005f7d0 sp=0x1400005f7b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005f7d0 sp=0x1400005f7d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 36 gp=0x14000504380 m=nil [GC worker (idle)]:
runtime.gopark(0x84d6cbd91ce?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050b710 sp=0x1400050b6f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400050b7b0 sp=0x1400050b710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400050b7d0 sp=0x1400050b7b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050b7d0 sp=0x1400050b7d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 22 gp=0x14000102a80 m=nil [GC worker (idle)]:
runtime.gopark(0x84d6cbd902d?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005a710 sp=0x1400005a6f0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400005a7b0 sp=0x1400005a710 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400005a7d0 sp=0x1400005a7b0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005a7d0 sp=0x1400005a7d0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 9 gp=0x14000490380 m=nil [GC worker (idle)]:
runtime.gopark(0x84d6cbd8f87?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005ff10 sp=0x1400005fef0 pc=0x1026c6dc8
runtime.gcBgMarkWorker(0x140000940e0)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1423 +0xdc fp=0x1400005ffb0 sp=0x1400005ff10 pc=0x10267511c
runtime.gcBgMarkStartWorkers.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x28 fp=0x1400005ffd0 sp=0x1400005ffb0 pc=0x102675008
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005ffd0 sp=0x1400005ffd0 pc=0x1026cee44
created by runtime.gcBgMarkStartWorkers in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1339 +0x140

goroutine 23 gp=0x14000490540 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050c6f0 sp=0x1400050c6d0 pc=0x1026c6dc8
runtime.chanrecv(0x140000942a0, 0x0, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400050c770 sp=0x1400050c6f0 pc=0x102664b0c
runtime.chanrecv1(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:506 +0x14 fp=0x1400050c7a0 sp=0x1400050c770 pc=0x1026646a4
runtime.unique_runtime_registerUniqueMapCleanup.func2(...)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1797
runtime.unique_runtime_registerUniqueMapCleanup.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1800 +0x3c fp=0x1400050c7d0 sp=0x1400050c7a0 pc=0x102675eac
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050c7d0 sp=0x1400050c7d0 pc=0x1026cee44
created by unique.runtime_registerUniqueMapCleanup in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/mgc.go:1795 +0x78

goroutine 24 gp=0x14000490700 m=nil [select]:
runtime.gopark(0x1400050cf78?, 0x2?, 0x30?, 0xf?, 0x1400050cf74?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050ce00 sp=0x1400050cde0 pc=0x1026c6dc8
runtime.selectgo(0x1400050cf78, 0x1400050cf70, 0x0?, 0x0, 0x0?, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/select.go:351 +0x6c4 fp=0x1400050cf30 sp=0x1400050ce00 pc=0x1026a7114
database/sql.(*DB).connectionOpener(0x1400016b6c0, {0x102e98880, 0x140001947d0})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/database/sql/sql.go:1261 +0x80 fp=0x1400050cfa0 sp=0x1400050cf30 pc=0x1029c0f90
database/sql.OpenDB.gowrap1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/database/sql/sql.go:841 +0x30 fp=0x1400050cfd0 sp=0x1400050cfa0 pc=0x1029bf1f0
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050cfd0 sp=0x1400050cfd0 pc=0x1026cee44
created by database/sql.OpenDB in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/database/sql/sql.go:841 +0x124

goroutine 25 gp=0x140004908c0 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050d6d0 sp=0x1400050d6b0 pc=0x1026c6dc8
runtime.chanrecv(0x140001678f0, 0x1400050d7b0, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400050d750 sp=0x1400050d6d0 pc=0x102664b0c
runtime.chanrecv2(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:511 +0x14 fp=0x1400050d780 sp=0x1400050d750 pc=0x1026646c4
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).startRequestProcessor(...)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:158
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend.gowrap1()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:118 +0x60 fp=0x1400050d7d0 sp=0x1400050d780 pc=0x10299cdb0
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050d7d0 sp=0x1400050d7d0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:118 +0x5d0

goroutine 26 gp=0x14000490a80 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050ded0 sp=0x1400050deb0 pc=0x1026c6dc8
runtime.chanrecv(0x14000167880, 0x1400050dfb0, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400050df50 sp=0x1400050ded0 pc=0x102664b0c
runtime.chanrecv2(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:511 +0x14 fp=0x1400050df80 sp=0x1400050df50 pc=0x1026646c4
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).startMessageProcessor(...)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:152
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend.gowrap2()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:121 +0x5c fp=0x1400050dfd0 sp=0x1400050df80 pc=0x10299cd0c
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050dfd0 sp=0x1400050dfd0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:121 +0x3b0

goroutine 27 gp=0x14000490c40 m=nil [chan receive]:
runtime.gopark(0x1029c209f?, 0x14000680008?, 0x8?, 0xaf?, 0x102675290?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400050aec0 sp=0x1400050aea0 pc=0x1026c6dc8
runtime.chanrecv(0x1400017e000, 0x1400050af88, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400050af40 sp=0x1400050aec0 pc=0x102664b0c
runtime.chanrecv2(0x14000110060?, 0x140005041c0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:511 +0x14 fp=0x1400050af70 sp=0x1400050af40 pc=0x1026646c4
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).startCallbackProcessor(0x140001a4ea0)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:164 +0x3c fp=0x1400050afb0 sp=0x1400050af70 pc=0x10299d13c
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend.gowrap3()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:122 +0x28 fp=0x1400050afd0 sp=0x1400050afb0 pc=0x10299cc78
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400050afd0 sp=0x1400050afd0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:122 +0x3f0

goroutine 28 gp=0x14000490e00 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005aec0 sp=0x1400005aea0 pc=0x1026c6dc8
runtime.chanrecv(0x14000167960, 0x1400005af90, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400005af40 sp=0x1400005aec0 pc=0x102664b0c
runtime.chanrecv2(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:511 +0x14 fp=0x1400005af70 sp=0x1400005af40 pc=0x1026646c4
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).startFileOpenProcessor(0x140001a4ea0)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:131 +0x40 fp=0x1400005afb0 sp=0x1400005af70 pc=0x10299ce30
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend.gowrap4()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:123 +0x28 fp=0x1400005afd0 sp=0x1400005afb0 pc=0x10299cc18
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005afd0 sp=0x1400005afd0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:123 +0x430

goroutine 29 gp=0x14000490fc0 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005b6c0 sp=0x1400005b6a0 pc=0x1026c6dc8
runtime.chanrecv(0x140001679d0, 0x1400005b790, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400005b740 sp=0x1400005b6c0 pc=0x102664b0c
runtime.chanrecv2(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:511 +0x14 fp=0x1400005b770 sp=0x1400005b740 pc=0x1026646c4
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).startUrlOpenProcessor(0x140001a4ea0)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:137 +0x40 fp=0x1400005b7b0 sp=0x1400005b770 pc=0x10299ced0
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend.gowrap5()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:124 +0x28 fp=0x1400005b7d0 sp=0x1400005b7b0 pc=0x10299cbb8
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005b7d0 sp=0x1400005b7d0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:124 +0x470

goroutine 30 gp=0x14000491180 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x1400005be70 sp=0x1400005be50 pc=0x1026c6dc8
runtime.chanrecv(0x14000167a40, 0x1400005bf80, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x1400005bef0 sp=0x1400005be70 pc=0x102664b0c
runtime.chanrecv2(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:511 +0x14 fp=0x1400005bf20 sp=0x1400005bef0 pc=0x1026646c4
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.(*Frontend).startSecondInstanceProcessor(0x140001a4ea0)
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:143 +0x4c fp=0x1400005bfb0 sp=0x1400005bf20 pc=0x10299cf7c
github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend.gowrap6()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:125 +0x28 fp=0x1400005bfd0 sp=0x1400005bfb0 pc=0x10299cb58
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x1400005bfd0 sp=0x1400005bfd0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/frontend/desktop/darwin.NewFrontend in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/frontend/desktop/darwin/frontend.go:125 +0x4b0

goroutine 31 gp=0x14000491340 m=nil [select, locked to thread]:
runtime.gopark(0x14000506fa0?, 0x2?, 0xa8?, 0x6e?, 0x14000506f90?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x14000506e20 sp=0x14000506e00 pc=0x1026c6dc8
runtime.selectgo(0x14000506fa0, 0x14000506f8c, 0x0?, 0x0, 0x0?, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/select.go:351 +0x6c4 fp=0x14000506f50 sp=0x14000506e20 pc=0x1026a7114
runtime.ensureSigM.func1()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/signal_unix.go:1085 +0x160 fp=0x14000506fd0 sp=0x14000506f50 pc=0x1026c16e0
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x14000506fd0 sp=0x14000506fd0 pc=0x1026cee44
created by runtime.ensureSigM in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/signal_unix.go:1068 +0xd8

goroutine 32 gp=0x14000491500 m=4 mp=0x14000063808 [syscall]:
runtime.sigNoteSleep(0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/os_darwin.go:133 +0x20 fp=0x14000507790 sp=0x14000507750 pc=0x10268dfa0
os/signal.signal_recv()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/sigqueue.go:149 +0x2c fp=0x140005077b0 sp=0x14000507790 pc=0x1026c8f2c
os/signal.loop()
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/os/signal/signal_unix.go:23 +0x1c fp=0x140005077d0 sp=0x140005077b0 pc=0x1029a6d0c
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x140005077d0 sp=0x140005077d0 pc=0x1026cee44
created by os/signal.Notify.func1.1 in goroutine 1
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/os/signal/signal.go:152 +0x28

goroutine 10 gp=0x14000504540 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x140004b0ee0 sp=0x140004b0ec0 pc=0x1026c6dc8
runtime.chanrecv(0x140000ac000, 0x0, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x140004b0f60 sp=0x140004b0ee0 pc=0x102664b0c
runtime.chanrecv1(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:506 +0x14 fp=0x140004b0f90 sp=0x140004b0f60 pc=0x1026646a4
github.com/wailsapp/wails/v2/internal/signal.Start.func1()
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/signal/signal.go:31 +0x28 fp=0x140004b0fd0 sp=0x140004b0f90 pc=0x1029a7158
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x140004b0fd0 sp=0x140004b0fd0 pc=0x1026cee44
created by github.com/wailsapp/wails/v2/internal/signal.Start in goroutine 1
	/Users/runner/go/pkg/mod/github.com/wailsapp/wails/v2@v2.10.2/internal/signal/signal.go:30 +0x88

goroutine 33 gp=0x140004916c0 m=nil [chan receive]:
runtime.gopark(0x0?, 0x0?, 0x0?, 0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/proc.go:435 +0xc8 fp=0x14000507ef0 sp=0x14000507ed0 pc=0x1026c6dc8
runtime.chanrecv(0x140000949a0, 0x0, 0x1)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:664 +0x42c fp=0x14000507f70 sp=0x14000507ef0 pc=0x102664b0c
runtime.chanrecv1(0x0?, 0x0?)
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/chan.go:506 +0x14 fp=0x14000507fa0 sp=0x14000507f70 pc=0x1026646a4
fyne.io/systray.Register.func2()
	/Users/runner/go/pkg/mod/fyne.io/systray@v1.12.2/systray.go:122 +0x2c fp=0x14000507fd0 sp=0x14000507fa0 pc=0x102bcb4bc
runtime.goexit({})
	/Users/runner/hostedtoolcache/go/1.24.13/arm64/src/runtime/asm_arm64.s:1223 +0x4 fp=0x14000507fd0 sp=0x14000507fd0 pc=0x1026cee44
created by fyne.io/systray.Register in goroutine 37
	/Users/runner/go/pkg/mod/fyne.io/systray@v1.12.2/systray.go:121 +0xc8

r0      0x0
r1      0x0
r2      0x0
r3      0x0
r4      0x18a4ced97
r5      0x1717f9980
r6      0x6e
r7      0xfffff0003ffff800
r8      0x70beea741d1c5df0
r9      0x70beea756c63edf0
r10     0x2
r11     0xfffffffd
r12     0x0
r13     0x0
r14     0x0
r15     0x0
r16     0x148
r17     0x1f8597358
r18     0x0
r19     0x6
r20     0x1603
r21     0x1717fb0e0
r22     0x1f447c000
r23     0x2
r24     0x400100000
r25     0x1717fab40
r26     0x102e8ed08
r27     0x820
r28     0x1f0169000
r29     0x1717f98f0
lr      0x18a5178d8
sp      0x1717f98d0
pc      0x18a4dc5e8
fault   0x18a4dc5e8
KertIA@admins-MacBook-Pro Applications % >....                                                                          
r5      0x1717f9980
r6      0x6e
r7      0xfffff0003ffff800
r8      0x70beea741d1c5df0
r9      0x70beea756c63edf0
r10     0x2
r11     0xfffffffd
r12     0x0
r13     0x0
r14     0x0
r15     0x0
r16     0x148
r17     0x1f8597358
r18     0x0
r19     0x6
r20     0x1603
r21     0x1717fb0e0
r22     0x1f447c000
r23     0x2
r24     0x400100000
r25     0x1717fab40
r26     0x102e8ed08
r27     0x820
r28     0x1f0169000
r29     0x1717f98f0
lr      0x18a5178d8
sp      0x1717f98d0
pc      0x18a4dc5e8
fault   0x18a4dc5e8/Users/KertIA/Downloads/PC_READER.app
```

---
*Full history: [PROJECT_STATE.md](./PROJECT_STATE.md) · [DECISIONS.md](./DECISIONS.md) · [RESEARCH.md](./RESEARCH.md)*
