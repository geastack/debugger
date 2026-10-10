#pragma once
#import <AppKit/AppKit.h>

@protocol GeaDebugPickerDelegate <NSObject>
- (void)pickerHover:(NSPoint)point inView:(NSView *)view;
- (void)pickerSelect:(NSPoint)point inView:(NSView *)view;
- (void)pickerCanceled;
@end

// Included by the native endpoint and its AppKit input regression harness.
@interface GeaDebugPicker : NSObject
@property(nonatomic, weak) id<GeaDebugPickerDelegate> delegate;
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, strong) id monitor;
@property(nonatomic, strong) NSCursor *previousCursor;
@property(nonatomic) BOOL active;
@property(nonatomic) BOOL capturedPress;
@property(nonatomic) BOOL previousMouseMoved;
- (void)startInWindow:(NSWindow *)window delegate:(id<GeaDebugPickerDelegate>)delegate;
- (void)stop;
- (NSEvent *)handleEvent:(NSEvent *)event;
@end

@implementation GeaDebugPicker
- (void)startInWindow:(NSWindow *)window delegate:(id<GeaDebugPickerDelegate>)delegate {
    if (self.active && self.delegate != delegate) [self.delegate pickerCanceled];
    [self stop];
    self.capturedPress = NO;
    self.window = window;
    self.delegate = delegate;
    self.previousMouseMoved = window.acceptsMouseMovedEvents;
    self.previousCursor = NSCursor.currentCursor;
    window.acceptsMouseMovedEvents = YES;
    self.active = YES;
    if (!self.monitor) {
        __weak GeaDebugPicker *weak = self;
        self.monitor = [NSEvent addLocalMonitorForEventsMatchingMask:
            NSEventMaskMouseMoved | NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp |
            NSEventMaskLeftMouseDragged | NSEventMaskKeyDown
            handler:^NSEvent *(NSEvent *event) {
                return weak ? [weak handleEvent:event] : event;
            }];
    }
}
- (void)stop {
    if (self.active) {
        self.window.acceptsMouseMovedEvents = self.previousMouseMoved;
        [self.previousCursor set];
    }
    self.active = NO;
    self.delegate = nil;
    // A successful pick ends inspection on mouse-down. Consume its matching
    // drag/up too, even if Chrome immediately sends mode=none.
    if (!self.capturedPress && self.monitor) {
        [NSEvent removeMonitor:self.monitor];
        self.monitor = nil;
    }
}
- (NSEvent *)handleEvent:(NSEvent *)event {
    if (self.capturedPress) {
        if (event.type == NSEventTypeLeftMouseUp) {
            self.capturedPress = NO;
            if (!self.active) [self stop];
            return nil;
        }
        if (event.type == NSEventTypeLeftMouseDragged) return nil;
        // Recover if the release happened outside this application.
        if (event.type == NSEventTypeLeftMouseDown) self.capturedPress = NO;
    }
    if (!self.active) { [self stop]; return event; }
    if (!self.delegate) { [self stop]; return event; }
    if (event.type == NSEventTypeKeyDown && event.keyCode == 53) {
        id<GeaDebugPickerDelegate> delegate = self.delegate;
        [self stop];
        [delegate pickerCanceled];
        return nil;
    }
    if (event.window != self.window) return event;
    NSView *view = self.window.contentView;
    NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
    if (!NSPointInRect(point, view.bounds)) return event;
    if (event.type == NSEventTypeMouseMoved) {
        [NSCursor.crosshairCursor set];
        [self.delegate pickerHover:point inView:view];
    } else if (event.type == NSEventTypeLeftMouseDown) {
        self.capturedPress = YES;
        id<GeaDebugPickerDelegate> delegate = self.delegate;
        [self stop];
        [delegate pickerSelect:point inView:view];
        return nil;
    }
    return event;
}
- (void)dealloc {
    if (_monitor) [NSEvent removeMonitor:_monitor];
}
@end
