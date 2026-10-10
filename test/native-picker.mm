@interface PickerDelegate : NSObject <GeaDebugPickerDelegate>
@property int hovers;
@property int selections;
@property int cancellations;
@property NSPoint point;
@end
@implementation PickerDelegate
- (void)pickerHover:(NSPoint)point inView:(NSView *)view { (void)view; self.hovers++; self.point = point; }
- (void)pickerSelect:(NSPoint)point inView:(NSView *)view { (void)view; self.selections++; self.point = point; }
- (void)pickerCanceled { self.cancellations++; }
@end

static void require(bool value, const char *message) {
    if (!value) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}

int main() {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp finishLaunching];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window orderBack:nil];
        PickerDelegate *delegate = [PickerDelegate new];
        GeaDebugPicker *picker = [GeaDebugPicker new];
        const BOOL originalMouseMoved = window.acceptsMouseMovedEvents;
        auto mouse = [&](NSEventType type, NSPoint point = NSMakePoint(37, 48)) {
            return [NSEvent mouseEventWithType:type location:point modifierFlags:0
                timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
                context:nil eventNumber:1 clickCount:1 pressure:1];
        };
        [picker startInWindow:window delegate:delegate];
        require(window.acceptsMouseMovedEvents, "inspection enables AppKit mouse movement");
        [picker handleEvent:mouse(NSEventTypeMouseMoved)];
        require(delegate.hovers == 1 && NSEqualPoints(delegate.point, NSMakePoint(37, 48)),
            "hover uses native content coordinates");
        require(![picker handleEvent:mouse(NSEventTypeLeftMouseDown)], "pick consumes mouse-down before native controls");
        require(delegate.selections == 1 && !picker.active, "one click selects once and ends inspection");
        require(window.acceptsMouseMovedEvents == originalMouseMoved, "selection restores window event settings");
        [picker stop];
        require(![picker handleEvent:mouse(NSEventTypeLeftMouseDragged)], "drag after selection cannot reach app handlers");
        require(![picker handleEvent:mouse(NSEventTypeLeftMouseUp)], "release after mode=none is still consumed");
        NSEvent *ordinary = mouse(NSEventTypeLeftMouseDown);
        require([picker handleEvent:ordinary] == ordinary, "next click reaches normal app interaction");
        require(!picker.monitor, "completed gesture removes its local monitor");

        [picker startInWindow:window delegate:delegate];
        [picker startInWindow:window delegate:delegate];
        require(delegate.cancellations == 0, "updating one inspector does not cancel its picker");
        NSEvent *escape = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
            modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil
            characters:@"\e" charactersIgnoringModifiers:@"\e" isARepeat:NO keyCode:53];
        require(![picker handleEvent:escape] && delegate.cancellations == 1 && !picker.active,
            "Escape cancels inspection without reaching the focused control");
        require(!picker.monitor && window.acceptsMouseMovedEvents == originalMouseMoved,
            "cancellation restores event routing");

        [picker startInWindow:window delegate:delegate];
        NSEvent *titlebar = mouse(NSEventTypeLeftMouseDown, NSMakePoint(20, 310));
        require([picker handleEvent:titlebar] == titlebar && picker.active,
            "window chrome is not inspected or intercepted");
        PickerDelegate *replacement = [PickerDelegate new];
        [picker startInWindow:window delegate:replacement];
        require(delegate.cancellations == 2, "new inspector cancels the previous owner");
        picker.delegate = nil;
        require([picker handleEvent:ordinary] == ordinary && !picker.active && !picker.monitor,
            "lost inspector never leaves input trapped");

        [picker startInWindow:window delegate:delegate];
        [picker handleEvent:mouse(NSEventTypeLeftMouseDown)];
        require([picker handleEvent:ordinary] == ordinary,
            "a release outside the app cannot swallow the next click");
        require(!picker.monitor, "missing release does not leave a monitor installed");
        [window orderOut:nil];
        std::puts("native picker input routing: ALL PASS");
    }
}
