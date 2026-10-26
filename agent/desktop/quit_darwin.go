//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

static IMP wailsShouldTerminate;
static BOOL powerOffSeen;

// isSystemQuit reports whether this quit comes from log out, restart or shut down (loginwindow's
// quit Apple event names the reason) rather than from the user quitting the app (Cmd+Q, Dock).
static BOOL isSystemQuit(void) {
	if (powerOffSeen) {
		return YES;
	}
	NSAppleEventDescriptor *ev = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
	if (ev == nil || [ev eventClass] != kCoreEventClass || [ev eventID] != kAEQuitApplication) {
		return NO;
	}
	NSAppleEventDescriptor *why = [ev attributeDescriptorForKeyword:kAEQuitReason];
	if (why == nil) {
		return NO;
	}
	switch ([why enumCodeValue]) {
	case kAELogOut:
	case kAEReallyLogOut:
	case kAERestart:
	case kAEShutDown:
		return YES;
	}
	return NO;
}

static NSApplicationTerminateReply shouldTerminate(id self, SEL _cmd, NSApplication *sender) {
	if (isSystemQuit()) {
		return NSTerminateNow;
	}
	return ((NSApplicationTerminateReply (*)(id, SEL, NSApplication *))wailsShouldTerminate)(self, _cmd, sender);
}

static void installQuitHook(void) {
	if (wailsShouldTerminate != NULL) {
		return;
	}
	id delegate = [NSApp delegate];
	if (delegate == nil) {
		return;
	}
	Method m = class_getInstanceMethod([delegate class], @selector(applicationShouldTerminate:));
	if (m == NULL) {
		return;
	}
	wailsShouldTerminate = method_setImplementation(m, (IMP)shouldTerminate);
	// Posted when the user confirms log out, restart or shut down, before the apps are asked to quit.
	[[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:NSWorkspaceWillPowerOffNotification
	                                                                object:nil
	                                                                 queue:nil
	                                                            usingBlock:^(NSNotification *note) {
		powerOffSeen = YES;
	}];
}
*/
import "C"

// allowSystemQuit lets macOS log out, restart and shut down while the app runs (issue #19).
//
// Wails v2 answers every applicationShouldTerminate with NSTerminateCancel and then asks OnBeforeClose,
// which keeps the app in the tray. For the system's quit that cancel aborts the log out / shut down
// ("PC_READER interrupted shutdown"). This replaces Wails' AppDelegate method so a system quit is
// answered with NSTerminateNow; Cmd+Q and the Dock's Quit still go to OnBeforeClose and only hide the
// window. Call it once Wails' run loop is up (OnStartup); it must run on the main thread.
func allowSystemQuit() {
	runOnMainThread(func() { C.installQuitHook() })
}
