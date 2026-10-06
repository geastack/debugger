// Debug-only native retained-tree endpoint. All tree/JSC work runs on the
// AppKit main run loop. The host relay supplies HTTP discovery and WebSockets.
#include "pixel.h"
#include "ui/document.h"
#include "ui/node.h"
#include "ui/tree_internal.h"
#include "ui/tree_state.h"
#import <Cocoa/Cocoa.h>
#import <JavaScriptCore/JavaScriptCore.h>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <string>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

extern "C" void gea_macos_fire_press_for_node(int nodeId);
using namespace gea::embedded::ui;

namespace {
// Objective-C exceptions must never unwind through JavaScriptCore's C++ VM.
// Translate native validation failures inside each host callback instead.
template <typename T, typename F> T scriptCall(JSContext *context, F &&action, T fallback) {
    @try {
        return action();
    } @catch (NSException *error) {
        context.exception =
            [JSValue valueWithNewErrorFromMessage:error.reason ?: @"Native inspector error"
                                        inContext:context];
        return fallback;
    }
}
template <typename F> void scriptCallVoid(JSContext *context, F &&action) {
    @try {
        action();
    } @catch (NSException *error) {
        context.exception =
            [JSValue valueWithNewErrorFromMessage:error.reason ?: @"Native inspector error"
                                        inContext:context];
    }
}
NSString *str(const char *value) { return [NSString stringWithUTF8String:value ?: ""] ?: @""; }
NSString *px(int value) { return [NSString stringWithFormat:@"%dpx", value]; }
NSNumber *nodeId(int slot) { return @(Tree::instance().node(slot).debugger_identity * 2 + 2); }
NSString *color(style_color_t value) {
#if GEA_EMBEDDED_PIXEL_FORMAT == GEA_PIXEL_RGBA8888
    int r = value & 255, g = (value >> 8) & 255, b = (value >> 16) & 255;
#elif GEA_EMBEDDED_PIXEL_FORMAT == GEA_PIXEL_ARGB8888
    int r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
#else
    auto v = gea::framework::graphics::pixel::toRgb565(value);
    int r = ((v >> 11) & 31) * 255 / 31, g = ((v >> 5) & 63) * 255 / 63, b = (v & 31) * 255 / 31;
#endif
    return [NSString stringWithFormat:@"rgb(%d, %d, %d)", r, g, b];
}
// Common computed properties come from the actual engine style and used box,
// never from the last debugger write. Unexported properties remain absent.
NSDictionary *computed(int slot) {
    const auto &n = Tree::instance().node(slot);
    const auto &s = n.computedStyle();
    NSMutableDictionary *d = [@{
        @"width" : px(n.layout.width),
        @"height" : px(n.layout.height),
        @"left" : px(GEA_CSS_POSITION_PX_3(s) == kUnset ? 0 : GEA_CSS_POSITION_PX_3(s)),
        @"top" : px(GEA_CSS_POSITION_PX_0(s) == kUnset ? 0 : GEA_CSS_POSITION_PX_0(s)),
        @"color" : color(s.text_color),
        @"background-color" : s.has_bg ? color(s.bg_color) : @"rgba(0, 0, 0, 0)",
        @"opacity" : [NSString stringWithFormat:@"%.4g", s.opacity / 255.0],
        @"font-size" : px(s.font_size),
        @"font-weight" : @(s.font_weight).stringValue,
        @"display" : s.display == kDisplayNone ? @"none"
        : s.display == kDisplayFlex            ? @"flex"
        : s.display == kDisplayGrid            ? @"grid"
                                               : @"block",
        @"position" : s.position == 1 ? @"absolute"
        : s.position == 2             ? @"relative"
        : s.position == 3             ? @"fixed"
                                      : @"static",
        @"border-top-width" : px(computedBorderWidth(s, 0)),
        @"border-right-width" : px(computedBorderWidth(s, 1)),
        @"border-bottom-width" : px(computedBorderWidth(s, 2)),
        @"border-left-width" : px(computedBorderWidth(s, 3))
    } mutableCopy];
    NSArray *sides = @[ @"top", @"right", @"bottom", @"left" ];
    for (int i = 0; i < 4; ++i) {
        d[[@"padding-" stringByAppendingString:sides[i]]] = px(s.padding[i]);
        d[[@"margin-" stringByAppendingString:sides[i]]] = px(s.margin[i]);
    }
    return d;
}
NSDictionary *attributes(int slot) {
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    const auto *rd = rareDataFor(slot);
#if GEA_UI_NODE_ATTRIBUTES
    if (rd)
        for (auto *entry = rd->attributes.values.get(); entry; entry = entry->next.get())
            d[str(entry->name())] = str(entry->value());
#endif
    std::string classes = Tree::instance().className(slot);
    if (!classes.empty())
        d[@"class"] = str(classes.c_str());
    return d;
}
NSArray *flatAttributes(NSDictionary *attrs) {
    NSMutableArray *a = [NSMutableArray array];
    for (NSString *key in [[attrs allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
        [a addObject:key];
        [a addObject:attrs[key]];
    }
    return a;
}
NSString *tag(int slot) {
    const char *name = Tree::instance().tagName(slot);
    if (name && *name)
        return str(name);
    return Tree::instance().node(slot).type == NodeType::Text ? @"span" : @"div";
}
NSDictionary *frameInfo() {
    NSString *title = NSBundle.mainBundle.infoDictionary[@"CFBundleName"] ?: @"Gea native app";
    return @{
        @"id" : @"gea",
        @"loaderId" : @"gea",
        @"url" : @"gea://native/",
        @"domainAndRegistry" : @"",
        @"securityOrigin" : @"gea://native",
        @"mimeType" : @"text/html",
        @"name" : title,
        @"secureContextType" : @"Secure",
        @"crossOriginIsolatedContextType" : @"NotIsolated",
        @"gatedAPIFeatures" : @[]
    };
}
} // namespace

@interface GeaDebugOverlay : NSView
@end
@implementation GeaDebugOverlay
- (NSView *)hitTest:(NSPoint)point {
    (void)point;
    return nil;
}
- (void)drawRect:(NSRect)rect {
    (void)rect;
    [NSColor.systemBlueColor setStroke];
    NSBezierPath *path = [NSBezierPath bezierPathWithRect:NSInsetRect(self.bounds, 1, 1)];
    path.lineWidth = 2;
    [path stroke];
}
@end
static GeaDebugOverlay *debugOverlay;

@interface GeaDebugSession : NSObject
@property int fd;
@property NSMutableData *input;
@property NSMutableData *output;
@property NSMutableDictionary<NSNumber *, NSNumber *> *slots;
@property NSMutableDictionary<NSNumber *, NSDictionary *> *previous;
@property NSMutableDictionary<NSString *, JSValue *> *objects;
@property NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *groups;
@property JSContext *context;
@property BOOL domEnabled;
@property BOOL cssEnabled;
@property BOOL runtimeEnabled;
@property unsigned objectSequence;
@property NSMutableSet<NSNumber *> *knownNodes;
@property NSMutableSet<NSNumber *> *publishedChildren;
@property NSMutableSet<NSString *> *announcedStyles;
- (void)poll;
- (NSDictionary *)snapshot;
- (int)slot:(NSNumber *)id;
- (NSDictionary *)node:(NSNumber *)id depth:(int)depth;
- (NSDictionary *)remote:(JSValue *)value byValue:(BOOL)byValue group:(NSString *)group;
- (NSDictionary *)evaluation:(JSValue *)value params:(NSDictionary *)params;
- (NSDictionary *)inlineStyle:(NSNumber *)id;
- (NSDictionary *)inlineValues:(NSNumber *)id;
- (void)setStyleText:(NSString *)text node:(NSNumber *)id;
- (void)publishChanges;
- (void)send:(NSDictionary *)value;
- (void)emit:(NSString *)method params:(NSDictionary *)params;
- (id)handle:(NSString *)method params:(NSDictionary *)params;
@end

// CSS declarations authored through DevTools are shared between connections.
// Actual computed values always come back from the engine's cascade.
static NSMutableDictionary<NSNumber *, NSMutableDictionary<NSString *, NSString *> *> *debugStyles;

@implementation GeaDebugSession
- (instancetype)init {
    if (!(self = [super init]))
        return nil;
    self.fd = -1;
    self.input = [NSMutableData data];
    self.output = [NSMutableData data];
    self.slots = [NSMutableDictionary dictionary];
    self.previous = [NSMutableDictionary dictionary];
    self.knownNodes = [NSMutableSet set];
    self.publishedChildren = [NSMutableSet set];
    self.announcedStyles = [NSMutableSet set];
    self.objects = [NSMutableDictionary dictionary];
    self.groups = [NSMutableDictionary dictionary];
    self.context = [[JSContext alloc] init];
    __weak GeaDebugSession *weak = self;
    self.context[@"__geaQuery"] = ^NSArray *(NSString *selector) {
      return scriptCall<NSArray *>(
          JSContext.currentContext,
          [&]() -> NSArray * {
              GeaDebugSession *session = weak;
              [session snapshot];
              NSMutableArray *ids = [NSMutableArray array];
              auto &tree = Tree::instance();
              std::vector<int> pending;
              if (tree.mountedRoot() >= 0)
                  pending.push_back(tree.mountedRoot());
              while (!pending.empty()) {
                  int slot = pending.back();
                  pending.pop_back();
                  NSNumber *id = nodeId(slot);
                  std::vector<int> children;
                  for (int child = tree.node(slot).first_child; child >= 0;
                       child = tree.node(child).next_sibling)
                      children.push_back(child);
                  for (auto child = children.rbegin(); child != children.rend(); ++child)
                      pending.push_back(*child);
                  BOOL matches = [selector isEqual:@"*"] ||
                                 ([selector isEqual:@"body"] && slot == tree.mountedRoot());
                  if ([selector hasPrefix:@"#"])
                      matches = [str(tree.getAttribute(slot, "id"))
                          isEqual:[selector substringFromIndex:1]];
                  else if ([selector hasPrefix:@"."])
                      matches = tree.hasClass(
                          slot, std::string([selector substringFromIndex:1].UTF8String));
                  else if (![selector isEqual:@"*"] && ![selector isEqual:@"body"])
                      matches = [tag(slot) isEqual:selector];
                  if (matches)
                      [ids addObject:id];
              }
              return ids;
          },
          @[]);
    };
    self.context[@"__geaCreate"] = ^NSNumber *(NSString *name) {
      return scriptCall<NSNumber *>(
          JSContext.currentContext,
          [&]() -> NSNumber * {
              auto &tree = Tree::instance();
              int slot = [name isEqual:@"button"] ? tree.createButton()
                         : [name isEqual:@"span"] ? tree.createText()
                                                  : tree.createView();
              if (slot < 0)
                  @throw [NSException exceptionWithName:@"CDP"
                                                 reason:@"Native tree capacity exhausted"
                                               userInfo:nil];
              tree.setTagName(slot, name.UTF8String);
              return nodeId(slot);
          },
          nil);
    };
    self.context[@"__geaParent"] = ^(NSNumber *parentId, NSNumber *childId, NSNumber *referenceId) {
      scriptCallVoid(JSContext.currentContext, [&]() {
          GeaDebugSession *session = weak;
          int parent = [session slot:parentId], child = [session slot:childId];
          auto &tree = Tree::instance();
          if (tree.containsNode(child, parent))
              @throw [NSException exceptionWithName:@"CDP"
                                             reason:@"Cannot create a native tree cycle"
                                           userInfo:nil];
          if (referenceId.longLongValue != 0)
              tree.insertBefore(child, parent, [session slot:referenceId]);
          else
              tree.setParent(child, parent);
      });
    };
    self.context[@"__geaRead"] = ^id(NSNumber *id, NSString *key) {
      return scriptCall<::id>(
          JSContext.currentContext,
          [&]() -> ::id {
              GeaDebugSession *session = weak;
              int slot = [session slot:id];
              auto &tree = Tree::instance();
              const auto &n = tree.node(slot);
              if ([key isEqual:@"ownText"])
                  return str(n.text.c_str());
              if ([key isEqual:@"textContent"]) {
                  std::string text;
                  std::vector<int> pending{slot};
                  while (!pending.empty()) {
                      int current = pending.back();
                      pending.pop_back();
                      text += tree.node(current).text.c_str();
                      std::vector<int> children;
                      for (int child = tree.node(current).first_child; child >= 0;
                           child = tree.node(child).next_sibling)
                          children.push_back(child);
                      for (auto child = children.rbegin(); child != children.rend(); ++child)
                          pending.push_back(*child);
                  }
                  return str(text.c_str());
              }
              if ([key isEqual:@"tagName"])
                  return tag(slot).uppercaseString;
              if ([key isEqual:@"attributes"])
                  return attributes(slot);
              if ([key isEqual:@"computed"])
                  return computed(slot);
              if ([key isEqual:@"inline"])
                  return [session inlineValues:id];
              if ([key isEqual:@"parent"])
                  return n.parent >= 0 && session.slots[nodeId(n.parent)] ? nodeId(n.parent)
                                                                          : NSNull.null;
              if ([key isEqual:@"children"]) {
                  NSMutableArray *ids = [NSMutableArray array];
                  for (int child = n.first_child; child >= 0; child = tree.node(child).next_sibling)
                      [ids addObject:nodeId(child)];
                  return ids;
              }
              if ([key isEqual:@"rect"])
                  return @{
                      @"x" : @(n.layout.x),
                      @"y" : @(n.layout.y),
                      @"width" : @(n.layout.width),
                      @"height" : @(n.layout.height)
                  };
              @throw [NSException exceptionWithName:@"CDP"
                                             reason:@"Unknown native node property"
                                           userInfo:nil];
          },
          NSNull.null);
    };
    self.context[@"__geaWrite"] = ^id(NSNumber *id, NSString *operation, NSString *key,
                                      NSString *value) {
      return scriptCall<::id>(
          JSContext.currentContext,
          [&]() -> ::id {
              GeaDebugSession *session = weak;
              int slot = [session slot:id];
              auto &tree = Tree::instance();
              if ([operation isEqual:@"style"]) {
                  if (!debugStyles[id])
                      debugStyles[id] = [NSMutableDictionary dictionary];
                  if (value.length) {
                      gea::embedded::ui::Style(slot).setProperty(std::string(key.UTF8String),
                                                                 std::string(value.UTF8String));
                      debugStyles[id][key] = value;
                  } else {
                      gea::embedded::ui::Style(slot).removeProperty(std::string(key.UTF8String));
                      [debugStyles[id] removeObjectForKey:key];
                  }
                  if (session.cssEnabled)
                      [session
                            emit:@"CSS.styleSheetChanged"
                          params:@{@"styleSheetId" : [NSString stringWithFormat:@"inline-%@", id]}];
              } else if ([operation isEqual:@"attribute"])
                  tree.setAttribute(slot, key.UTF8String, value.UTF8String);
              else if ([operation isEqual:@"removeAttribute"])
                  tree.removeAttribute(slot, key.UTF8String);
              else if ([operation isEqual:@"text"]) {
                  if (tree.node(slot).type == NodeType::Text)
                      tree.setText(slot, value.UTF8String);
                  else {
                      while (tree.node(slot).first_child >= 0)
                          tree.removeNode(tree.node(slot).first_child);
                      tree.setText(slot, "");
                      if (value.length) {
                          int text = tree.createText();
                          if (text < 0)
                              @throw
                                  [NSException exceptionWithName:@"CDP"
                                                          reason:@"Native tree capacity exhausted"
                                                        userInfo:nil];
                          tree.setText(text, value.UTF8String);
                          tree.setParent(text, slot);
                      }
                  }
              } else if ([operation isEqual:@"remove"])
                  tree.removeNode(slot);
              else if ([operation isEqual:@"click"])
                  gea_macos_fire_press_for_node(slot);
              else
                  @throw [NSException exceptionWithName:@"CDP"
                                                 reason:@"Unknown native mutation"
                                               userInfo:nil];
              return NSNull.null;
          },
          NSNull.null);
    };
    self.context[@"__geaLog"] = ^(NSString *type, JSValue *args) {
      scriptCallVoid(JSContext.currentContext, [&]() {
          GeaDebugSession *session = weak;
          if (!session.runtimeEnabled)
              return;
          NSMutableArray *values = [NSMutableArray array];
          int count = [args[@"length"] toInt32];
          for (int i = 0; i < count; i++)
              [values addObject:[session remote:args[i] byValue:NO group:@"console"]];
          [session emit:@"Runtime.consoleAPICalled"
                 params:@{
                     @"type" : type,
                     @"args" : values,
                     @"executionContextId" : @1,
                     @"timestamp" : @(NSDate.date.timeIntervalSince1970 * 1000)
                 }];
      });
    };
    [self.context evaluateScript:@R"JS(
const __geaNodes = new Map();
const __kebab = key => typeof key === 'string' ? key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) : key;
function __geaType(value) { return typeof value; }
function __geaNode(id) {
  if (id == null) return null;
  if (__geaNodes.has(id)) return __geaNodes.get(id);
  if (id & 1) {
    const node = {__geaNodeId:id,nodeType:3,nodeName:'#text',
      get textContent(){return __geaRead(id-1,'ownText')},
      set textContent(v){__geaWrite(id-1,'text','',String(v))},
      get data(){return this.textContent},set data(v){this.textContent=v},
      get parentNode(){return __geaNode(id-1)},remove(){this.textContent=''}
    };
    __geaNodes.set(id,node);return node;
  }
  const read = key => __geaRead(id, key);
  const write = (op, key = '', value = '') => __geaWrite(id, op, String(key), String(value));
  const style = new Proxy({
    setProperty: (key, value) => write('style', key, value),
    removeProperty: key => write('style', key),
    getPropertyValue: key => read('inline')[key] || ''
  }, {
    get(t, key) { if (key in t) return t[key]; if (key === 'cssText') return Object.entries(read('inline')).map(([k,v]) => k+': '+v+';').join(' '); return read('inline')[__kebab(key)] || ''; },
    set(t, key, value) { if (key === 'cssText') { for (const k of Object.keys(read('inline'))) write('style', k); for (const part of String(value).split(';')) { const i=part.indexOf(':'); if(i>0) write('style',part.slice(0,i).trim(),part.slice(i+1).trim()); } } else write('style', __kebab(key), value); return true; }
  });
  const node = {
    __geaNodeId: id, nodeType: 1, style,
    get tagName() { return read('tagName'); },
    get nodeName() { return read('tagName'); },
    get textContent() { return read('textContent'); }, set textContent(v) { write('text', '', v); },
    get id() { return this.getAttribute('id') || ''; }, set id(v) { this.setAttribute('id', v); },
    get className() { return this.getAttribute('class') || ''; }, set className(v) { this.setAttribute('class', v); },
    get children() { return read('children').map(__geaNode); },
    get childNodes() { return read('ownText') ? [__geaNode(id+1),...this.children] : this.children; },
    get firstChild() { return this.childNodes[0] || null; },
    get parentNode() { return __geaNode(read('parent')); },
    getAttribute(k) { return read('attributes')[k] ?? null; },
    setAttribute(k,v) { if(k==='style') style.cssText=v; else write('attribute', k,v); },
    removeAttribute(k) { if(k==='style') style.cssText=''; else write('removeAttribute',k); },
    getBoundingClientRect() { const r=read('rect'); return {...r,top:r.y,left:r.x,right:r.x+r.width,bottom:r.y+r.height}; },
    appendChild(child) { __geaParent(id,child.__geaNodeId,null); return child; },
    insertBefore(child,reference) { __geaParent(id,child.__geaNodeId,reference?.__geaNodeId ?? null); return child; },
    click() { write('click'); }, remove() { write('remove'); }
  };
  __geaNodes.set(id, node); return node;
}
const document = {
  createElement: name => __geaNode(__geaCreate(String(name).toLowerCase())),
  querySelectorAll: s => __geaQuery(s).map(__geaNode),
  querySelector: s => __geaNode(__geaQuery(s)[0]),
  getElementById: s => __geaNode(__geaQuery('#'+s)[0]),
  get body() { return __geaNode(__geaQuery('body')[0]); },
  get documentElement() { return this.body; }
};
const window = globalThis;
const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
let $0 = null;
const getComputedStyle = node => {
  const d = __geaRead(node.__geaNodeId,'computed');
  return new Proxy({...d,getPropertyValue:k=>d[k]||''}, {get:(t,k)=>t[k]??d[__kebab(k)]??''});
};
const console = Object.fromEntries(['log','info','warn','error','debug'].map(t=>[t,(...a)=>__geaLog(t==='warn'?'warning':t,a)]));
)JS"];
    return self;
}
- (void)dealloc {
    if (_fd >= 0)
        close(_fd);
}
- (void)send:(NSDictionary *)value {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                   options:NSJSONWritingFragmentsAllowed
                                                     error:nil];
    if (!data)
        return;
    [self.output appendData:data];
    [self.output appendBytes:"\n" length:1];
    if (self.output.length > 16 * 1024 * 1024) {
        close(self.fd);
        self.fd = -1;
    }
}
- (void)emit:(NSString *)method params:(NSDictionary *)params {
    [self send:@{@"method" : method, @"params" : params}];
}
- (NSDictionary *)snapshot {
    NSMutableDictionary *snapshot = [NSMutableDictionary dictionary];
    [self.slots removeAllObjects];
    auto &tree = Tree::instance();
    if (tree.mountedRoot() < 0)
        return snapshot;
    std::vector<int> pending{tree.mountedRoot()};
    while (!pending.empty()) {
        int slot = pending.back();
        pending.pop_back();
        const auto &node = tree.node(slot);
        NSNumber *id = nodeId(slot);
        self.slots[id] = @(slot);
        NSMutableArray *children = [NSMutableArray array];
        for (int child = node.first_child; child >= 0; child = tree.node(child).next_sibling) {
            [children addObject:nodeId(child)];
            pending.push_back(child);
        }
        snapshot[id] = @{
            @"attributes" : attributes(slot),
            @"text" : str(node.text.c_str()),
            @"children" : children,
            @"computed" : computed(slot),
            @"tag" : tag(slot)
        };
    }
    return snapshot;
}
- (int)slot:(NSNumber *)id {
    [self snapshot];
    NSNumber *slot = self.slots[id];
    // Detached nodes created from the console remain mutable until attached.
    if (!slot) {
        auto &state = treeState();
        for (int i = 0; i < state.nodeCount; ++i)
            if (state.nodeActive[i] && [nodeId(i) isEqual:id]) {
                slot = @(i);
                break;
            }
    }
    if (!slot)
        @throw [NSException exceptionWithName:@"CDP" reason:@"Node no longer exists" userInfo:nil];
    return slot.intValue;
}
- (NSDictionary *)node:(NSNumber *)id depth:(int)depth {
    [self.knownNodes addObject:id];
    if (id.intValue == 1) {
        return @{
            @"nodeId" : @1,
            @"backendNodeId" : @1,
            @"nodeType" : @9,
            @"nodeName" : @"#document",
            @"localName" : @"",
            @"nodeValue" : @"",
            @"documentURL" : @"gea://native/",
            @"baseURL" : @"gea://native/",
            @"compatibilityMode" : @"NoQuirksMode",
            @"childNodeCount" : @1,
            @"children" : depth == 0 ? @[] : @[ [self node:@2 depth:depth < 0 ? -1 : depth - 1] ]
        };
    }
    if (id.intValue == 2) {
        int root = Tree::instance().mountedRoot();
        NSMutableDictionary *node = [@{
            @"nodeId" : @2,
            @"backendNodeId" : @2,
            @"nodeType" : @1,
            @"nodeName" : @"HTML",
            @"localName" : @"html",
            @"nodeValue" : @"",
            @"attributes" : @[],
            @"childNodeCount" : @(root >= 0 ? 1 : 0)
        } mutableCopy];
        if (depth != 0)
            node[@"children"] = root < 0 ? @[] : @[ [self node:nodeId(root)
                                                         depth:depth < 0 ? -1 : depth - 1] ];
        return node;
    }
    BOOL text = id.intValue & 1;
    NSNumber *elementId = @(id.intValue & ~1);
    int slot = [self slot:elementId];
    const auto &n = Tree::instance().node(slot);
    if (text)
        return @{
            @"nodeId" : id,
            @"backendNodeId" : id,
            @"nodeType" : @3,
            @"nodeName" : @"#text",
            @"localName" : @"",
            @"nodeValue" : str(n.text.c_str())
        };
    NSMutableArray *children = [NSMutableArray array];
    if (depth != 0) {
        if (!n.text.empty())
            [children addObject:[self node:@(id.intValue + 1) depth:0]];
        for (int child = n.first_child; child >= 0;
             child = Tree::instance().node(child).next_sibling)
            [children addObject:[self node:nodeId(child) depth:depth < 0 ? -1 : depth - 1]];
    }
    int count = n.text.empty() ? 0 : 1;
    for (int child = n.first_child; child >= 0; child = Tree::instance().node(child).next_sibling)
        ++count;
    NSMutableDictionary *node = [@{
        @"nodeId" : id,
        @"backendNodeId" : id,
        @"nodeType" : @1,
        @"nodeName" : tag(slot).uppercaseString,
        @"localName" : tag(slot),
        @"nodeValue" : @"",
        @"attributes" : flatAttributes(attributes(slot)),
        @"childNodeCount" : @(count)
    } mutableCopy];
    if (depth != 0)
        node[@"children"] = children;
    return node;
}
- (NSDictionary *)publishNode:(NSDictionary *)node {
    if (node[@"children"]) {
        [self.publishedChildren addObject:node[@"nodeId"]];
        for (NSDictionary *child in node[@"children"])
            [self publishNode:child];
    }
    return node;
}
- (void)publishChildren:(NSNumber *)id depth:(int)depth {
    NSDictionary *node = [self node:id depth:1];
    if (!node[@"children"])
        return;
    if (![self.publishedChildren containsObject:id]) {
        [self publishNode:node];
        [self emit:@"DOM.setChildNodes" params:@{@"parentId" : id, @"nodes" : node[@"children"]}];
    }
    if (depth != 1)
        for (NSDictionary *child in node[@"children"])
            [self publishChildren:child[@"nodeId"] depth:depth < 0 ? -1 : depth - 1];
}
- (NSDictionary *)remote:(JSValue *)value byValue:(BOOL)byValue group:(NSString *)group {
    if (value.isUndefined)
        return @{@"type" : @"undefined"};
    if (value.isNull)
        return @{@"type" : @"object", @"subtype" : @"null", @"value" : NSNull.null};
    if (value.isBoolean)
        return @{@"type" : @"boolean", @"value" : @([value toBool])};
    if (value.isNumber) {
        double number = [value toDouble];
        if (number == 0 && std::signbit(number))
            return @{@"type" : @"number", @"unserializableValue" : @"-0"};
        if (!std::isfinite(number))
            return @{
                @"type" : @"number",
                @"unserializableValue" : std::isnan(number) ? @"NaN"
                : number > 0                                ? @"Infinity"
                                                            : @"-Infinity"
            };
        return @{@"type" : @"number", @"value" : @(number), @"description" : [value toString]};
    }
    if (value.isString)
        return @{@"type" : @"string", @"value" : [value toString] ?: @""};
    NSString *type = [[self.context[@"__geaType"] callWithArguments:@[ value ]] toString];
    if ([type isEqual:@"bigint"])
        return @{
            @"type" : @"bigint",
            @"unserializableValue" : [[value toString] stringByAppendingString:@"n"]
        };
    if (byValue) {
        JSValue *encoded = [self.context[@"JSON"] invokeMethod:@"stringify"
                                                 withArguments:@[ value ]];
        if (self.context.exception || encoded.isUndefined)
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"Value cannot be returned by value"
                                         userInfo:nil];
        NSData *data = [[encoded toString] dataUsingEncoding:NSUTF8StringEncoding];
        id object = [NSJSONSerialization JSONObjectWithData:data
                                                    options:NSJSONReadingFragmentsAllowed
                                                      error:nil];
        return @{@"type" : @"object", @"value" : object ?: NSNull.null};
    }
    NSString *id = [NSString stringWithFormat:@"object-%u", ++self.objectSequence];
    self.objects[id] = value;
    if (group.length) {
        if (!self.groups[group])
            self.groups[group] = [NSMutableSet set];
        [self.groups[group] addObject:id];
    }
    NSMutableDictionary *remote = [@{
        @"type" : type ?: @"object",
        @"objectId" : id,
        @"description" : [value toString] ?: @"Object",
        @"className" : @"Object"
    } mutableCopy];
    if (![value[@"__geaNodeId"] isUndefined]) {
        remote[@"subtype"] = @"node";
        remote[@"className"] = @"GeaElement";
    } else if (value.isArray) {
        remote[@"subtype"] = @"array";
        remote[@"className"] = @"Array";
    }
    return remote;
}
- (NSDictionary *)evaluation:(JSValue *)value params:(NSDictionary *)params {
    if (self.context.exception) {
        JSValue *exception = self.context.exception;
        self.context.exception = nil;
        return @{
            @"result" : [self remote:exception byValue:NO group:params[@"objectGroup"]],
            @"exceptionDetails" : @{
                @"exceptionId" : @1,
                @"text" : [exception toString] ?: @"Evaluation failed",
                @"lineNumber" : @0,
                @"columnNumber" : @0,
                @"executionContextId" : @1
            }
        };
    }
    if ([params[@"awaitPromise"] boolValue] && value.isObject && ![value[@"then"] isUndefined]) {
        @throw [NSException
            exceptionWithName:@"CDP"
                       reason:@"awaitPromise is not yet supported by the native console"
                     userInfo:nil];
    }
    return @{
        @"result" : [self remote:value
                         byValue:[params[@"returnByValue"] boolValue]
                           group:params[@"objectGroup"]]
    };
}
- (NSDictionary *)inlineValues:(NSNumber *)id {
    int slot = [self slot:id];
    NSMutableDictionary *values = [debugStyles[id] mutableCopy] ?: [NSMutableDictionary dictionary];
    const auto *rare = rareDataFor(slot);
    const NSDictionary *used = computed(slot);
    if (rare)
        for (std::size_t i = 0; i < rare->inlineStyles.size(); ++i) {
            const auto &entry = rare->inlineStyles.at(i);
            NSString *name = nil;
            BOOL length = YES, percent = NO;
            switch (entry.property) {
            case Property::Width:
                name = @"width";
                break;
            case Property::Height:
                name = @"height";
                break;
            case Property::WidthPercent:
                name = @"width";
                percent = YES;
                break;
            case Property::HeightPercent:
                name = @"height";
                percent = YES;
                break;
            case Property::Left:
                name = @"left";
                break;
            case Property::Top:
                name = @"top";
                break;
            case Property::Right:
                name = @"right";
                break;
            case Property::Bottom:
                name = @"bottom";
                break;
            case Property::PaddingTop:
                name = @"padding-top";
                break;
            case Property::PaddingRight:
                name = @"padding-right";
                break;
            case Property::PaddingBottom:
                name = @"padding-bottom";
                break;
            case Property::PaddingLeft:
                name = @"padding-left";
                break;
            case Property::MarginTop:
                name = @"margin-top";
                break;
            case Property::MarginRight:
                name = @"margin-right";
                break;
            case Property::MarginBottom:
                name = @"margin-bottom";
                break;
            case Property::MarginLeft:
                name = @"margin-left";
                break;
            case Property::BackgroundColor:
                name = @"background-color";
                length = NO;
                break;
            case Property::Color:
                name = @"color";
                length = NO;
                break;
            case Property::Opacity:
                name = @"opacity";
                length = NO;
                break;
            case Property::Display:
                name = @"display";
                length = NO;
                break;
            case Property::Position:
                name = @"position";
                length = NO;
                break;
            case Property::FontSize:
                name = @"font-size";
                break;
            default:
                break;
            }
            if (!name || entry.value == kUnset)
                continue;
            if (percent)
                values[name] = [NSString stringWithFormat:@"%.5g%%", entry.value / 10.0];
            else if (length) {
                float pixels;
                values[name] = rare->inlineStyles.getCssPixels(entry.property, pixels)
                                   ? [NSString stringWithFormat:@"%.5gpx", pixels]
                                   : px(entry.value);
            } else if (used[name])
                values[name] = used[name];
        }
    return values;
}
- (NSDictionary *)inlineStyle:(NSNumber *)id {
    [self slot:id];
    NSDictionary *values = [self inlineValues:id];
    NSMutableArray *properties = [NSMutableArray array];
    NSMutableString *text = [NSMutableString string];
    for (NSString *name in [[values allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
        NSUInteger start = text.length;
        NSString *declaration = [NSString stringWithFormat:@"%@: %@;", name, values[name]];
        [text appendString:declaration];
        [properties addObject:@{
            @"name" : name,
            @"value" : values[name],
            @"important" : @NO,
            @"implicit" : @NO,
            @"parsedOk" : @YES,
            @"disabled" : @NO,
            @"text" : declaration,
            @"range" : @{
                @"startLine" : @0,
                @"startColumn" : @(start),
                @"endLine" : @0,
                @"endColumn" : @(text.length)
            }
        }];
        [text appendString:@" "];
    }
    NSString *sheetId = [NSString stringWithFormat:@"inline-%@", id];
    if (self.cssEnabled && ![self.announcedStyles containsObject:sheetId]) {
        [self.announcedStyles addObject:sheetId];
        [self emit:@"CSS.styleSheetAdded"
            params:@{
                @"header" : @{
                    @"styleSheetId" : sheetId,
                    @"frameId" : @"gea",
                    @"sourceURL" : @"",
                    @"origin" : @"regular",
                    @"title" : @"",
                    @"ownerNode" : id,
                    @"disabled" : @NO,
                    @"isInline" : @YES,
                    @"isMutable" : @YES,
                    @"isConstructed" : @NO,
                    @"startLine" : @0,
                    @"startColumn" : @0,
                    @"length" : @(text.length),
                    @"endLine" : @0,
                    @"endColumn" : @(text.length)
                }
            }];
    }
    return @{
        @"styleSheetId" : sheetId,
        @"cssProperties" : properties,
        @"shorthandEntries" : @[],
        @"cssText" : text,
        @"range" : @{
            @"startLine" : @0,
            @"startColumn" : @0,
            @"endLine" : @0,
            @"endColumn" : @(text.length)
        }
    };
}
- (void)setStyleText:(NSString *)text node:(NSNumber *)id {
    [self slot:id];
    // Let the JS style wrapper handle mutation through the same engine parser.
    JSValue *node = [self.context[@"__geaNode"] callWithArguments:@[ id ]];
    node[@"style"][@"cssText"] = text;
}
- (id)handle:(NSString *)method params:(NSDictionary *)p {
    [self snapshot];
    if ([method isEqual:@"DOM.enable"]) {
        self.domEnabled = YES;
        return @{};
    }
    if ([method isEqual:@"DOM.disable"]) {
        self.domEnabled = NO;
        return @{};
    }
    if ([method isEqual:@"CSS.enable"]) {
        self.cssEnabled = YES;
        return @{};
    }
    if ([method isEqual:@"CSS.disable"]) {
        self.cssEnabled = NO;
        return @{};
    }
    if ([method isEqual:@"Runtime.enable"]) {
        self.runtimeEnabled = YES;
        [self emit:@"Runtime.executionContextCreated"
            params:@{
                @"context" : @{
                    @"id" : @1,
                    @"origin" : @"gea://native",
                    @"name" : @"Gea native inspector",
                    @"uniqueId" : @"gea-native-inspector",
                    @"auxData" : @{@"isDefault" : @YES, @"type" : @"default", @"frameId" : @"gea"}
                }
            }];
        return @{};
    }
    if ([method isEqual:@"Runtime.disable"]) {
        self.runtimeEnabled = NO;
        return @{};
    }
    if ([method isEqual:@"DOM.getDocument"]) {
        [self.publishedChildren removeAllObjects];
        return @{
            @"root" : [self publishNode:[self node:@1
                                             depth:p[@"depth"] ? [p[@"depth"] intValue] : 1]]
        };
    }
    if ([method isEqual:@"DOM.describeNode"])
        return @{
            @"node" : [self node:p[@"nodeId"] ?: p[@"backendNodeId"]
                           depth:p[@"depth"] ? [p[@"depth"] intValue] : 0]
        };
    if ([method isEqual:@"DOM.requestChildNodes"]) {
        [self publishChildren:p[@"nodeId"] depth:p[@"depth"] ? [p[@"depth"] intValue] : 1];
        return @{};
    }
    if ([method isEqual:@"DOM.getAttributes"])
        return @{@"attributes" : flatAttributes(attributes([self slot:p[@"nodeId"]]))};
    if ([method isEqual:@"DOM.setAttributeValue"]) {
        int slot = [self slot:p[@"nodeId"]];
        if ([p[@"name"] isEqual:@"style"])
            [self setStyleText:p[@"value"] node:p[@"nodeId"]];
        else
            Tree::instance().setAttribute(slot, [p[@"name"] UTF8String], [p[@"value"] UTF8String]);
        return @{};
    }
    if ([method isEqual:@"DOM.setAttributesAsText"]) {
        int slot = [self slot:p[@"nodeId"]];
        NSRegularExpression *parser =
            [NSRegularExpression regularExpressionWithPattern:
                                     @"([^\\s=]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s]+)))?"
                                                      options:0
                                                        error:nil];
        NSString *text = p[@"text"] ?: @"";
        NSMutableSet *names = [NSMutableSet set];
        for (NSTextCheckingResult *match in [parser matchesInString:text
                                                            options:0
                                                              range:NSMakeRange(0, text.length)]) {
            NSString *name = [text substringWithRange:[match rangeAtIndex:1]], *value = @"";
            for (NSUInteger i = 2; i < match.numberOfRanges; ++i)
                if ([match rangeAtIndex:i].location != NSNotFound) {
                    value = [text substringWithRange:[match rangeAtIndex:i]];
                    break;
                }
            [names addObject:name];
            if ([name isEqual:@"style"])
                [self setStyleText:value node:p[@"nodeId"]];
            else
                Tree::instance().setAttribute(slot, name.UTF8String, value.UTF8String);
        }
        if (p[@"name"] && ![names containsObject:p[@"name"]])
            Tree::instance().removeAttribute(slot, [p[@"name"] UTF8String]);
        return @{};
    }
    if ([method isEqual:@"DOM.removeAttribute"]) {
        Tree::instance().removeAttribute([self slot:p[@"nodeId"]], [p[@"name"] UTF8String]);
        return @{};
    }
    if ([method isEqual:@"DOM.setNodeValue"]) {
        Tree::instance().setText([self slot:@([p[@"nodeId"] intValue] & ~1)],
                                 [p[@"value"] UTF8String]);
        return @{};
    }
    if ([method isEqual:@"DOM.removeNode"]) {
        Tree::instance().removeNode([self slot:p[@"nodeId"]]);
        return @{};
    }
    if ([method isEqual:@"DOM.querySelector"] || [method isEqual:@"DOM.querySelectorAll"]) {
        int parent = [p[@"nodeId"] intValue] <= 2 ? -1 : [self slot:p[@"nodeId"]];
        NSArray *ids =
            [[self.context[@"__geaQuery"] callWithArguments:@[ p[@"selector"] ]] toArray];
        NSMutableArray *found = [NSMutableArray array];
        for (NSNumber *id in ids)
            if (parent < 0 || Tree::instance().containsNode(parent, [self slot:id]))
                [found addObject:id];
        return [method isEqual:@"DOM.querySelector"] ? @{@"nodeId" : found.firstObject ?: @0}
                                                     : @{@"nodeIds" : found};
    }
    if ([method isEqual:@"DOM.resolveNode"]) {
        NSNumber *id = p[@"nodeId"] ?: p[@"backendNodeId"];
        [self slot:@(id.intValue & ~1)];
        return @{
            @"object" : [self remote:[self.context[@"__geaNode"] callWithArguments:@[ id ]]
                             byValue:NO
                               group:p[@"objectGroup"]]
        };
    }
    if ([method isEqual:@"DOM.requestNode"]) {
        JSValue *object = self.objects[p[@"objectId"]];
        if (!object || [object[@"__geaNodeId"] isUndefined])
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"Object is not a native node"
                                         userInfo:nil];
        NSNumber *id = [object[@"__geaNodeId"] toNumber];
        [self slot:@(id.intValue & ~1)];
        return @{@"nodeId" : id};
    }
    if ([method isEqual:@"DOM.pushNodesByBackendIdsToFrontend"]) {
        NSMutableArray *ids = [NSMutableArray array];
        for (NSNumber *id in p[@"backendNodeIds"]) {
            [self slot:@(id.intValue & ~1)];
            [ids addObject:id];
        }
        return @{@"nodeIds" : ids};
    }
    if ([method isEqual:@"DOM.setInspectedNode"]) {
        [self slot:@([p[@"nodeId"] intValue] & ~1)];
        self.context[@"__geaSelectedId"] = p[@"nodeId"];
        [self.context evaluateScript:@"$0 = __geaNode(__geaSelectedId)"];
        return @{};
    }
    if ([method isEqual:@"DOM.getBoxModel"] || [method isEqual:@"DOM.getContentQuads"]) {
        int slot = [self slot:p[@"nodeId"] ?: p[@"backendNodeId"]];
        const auto &n = Tree::instance().node(slot);
        int x = n.layout.x, y = n.layout.y, w = n.layout.width, h = n.layout.height;
        NSArray *quad = @[ @(x), @(y), @(x + w), @(y), @(x + w), @(y + h), @(x), @(y + h) ];
        if ([method isEqual:@"DOM.getContentQuads"])
            return @{@"quads" : @[ quad ]};
        const auto &s = n.computedStyle();
        int bl = computedBorderWidth(s, 3), bt = computedBorderWidth(s, 0),
            br = computedBorderWidth(s, 1), bb = computedBorderWidth(s, 2);
        auto inset = [&](int l, int t, int r, int b) {
            return @[
                @(x + l), @(y + t), @(x + w - r), @(y + t), @(x + w - r), @(y + h - b), @(x + l),
                @(y + h - b)
            ];
        };
        return @{
            @"model" : @{
                @"content" : inset(bl + s.padding[3], bt + s.padding[0], br + s.padding[1],
                                   bb + s.padding[2]),
                @"padding" : inset(bl, bt, br, bb),
                @"border" : quad,
                @"margin" : inset(-s.margin[3], -s.margin[0], -s.margin[1], -s.margin[2]),
                @"width" : @(w),
                @"height" : @(h)
            }
        };
    }
    if ([method isEqual:@"Overlay.enable"] || [method isEqual:@"Overlay.disable"]) {
        if ([method isEqual:@"Overlay.disable"])
            [debugOverlay removeFromSuperview];
        return @{};
    }
    if ([method isEqual:@"Overlay.hideHighlight"] || [method isEqual:@"DOM.hideHighlight"]) {
        [debugOverlay removeFromSuperview];
        return @{};
    }
    if ([method isEqual:@"Overlay.highlightNode"] || [method isEqual:@"DOM.highlightNode"]) {
        NSNumber *id = p[@"nodeId"] ?: p[@"backendNodeId"];
        if (!id && p[@"objectId"])
            id = [self.objects[p[@"objectId"]][@"__geaNodeId"] toNumber];
        const auto &n = Tree::instance().node([self slot:id]);
        NSView *parent = NSApp.mainWindow.contentView ?: NSApp.windows.firstObject.contentView;
        if (!debugOverlay)
            debugOverlay = [[GeaDebugOverlay alloc] init];
        [debugOverlay removeFromSuperview];
        debugOverlay.frame =
            NSMakeRect(n.layout.x, parent.bounds.size.height - n.layout.y - n.layout.height,
                       n.layout.width, n.layout.height);
        [parent addSubview:debugOverlay positioned:NSWindowAbove relativeTo:nil];
        [debugOverlay setNeedsDisplay:YES];
        return @{};
    }
    if ([method isEqual:@"DOM.getNodeForLocation"]) {
        int slot = Tree::instance().hitTestNode([p[@"x"] intValue], [p[@"y"] intValue]);
        if (slot < 0)
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"No native node at this location"
                                         userInfo:nil];
        return @{@"backendNodeId" : nodeId(slot), @"nodeId" : nodeId(slot), @"frameId" : @"gea"};
    }
    if ([method isEqual:@"DOM.scrollIntoViewIfNeeded"]) {
        Tree::instance().scrollIntoView([self slot:p[@"nodeId"] ?: p[@"backendNodeId"]]);
        return @{};
    }
    if ([method isEqual:@"Page.bringToFront"]) {
        [NSApp.mainWindow makeKeyAndOrderFront:nil];
        return @{};
    }
    if ([method isEqual:@"CSS.getComputedStyleForNode"]) {
        NSDictionary *values = computed([self slot:p[@"nodeId"]]);
        NSMutableArray *properties = [NSMutableArray array];
        for (NSString *key in values)
            [properties addObject:@{@"name" : key, @"value" : values[key]}];
        return @{@"computedStyle" : properties};
    }
    if ([method isEqual:@"CSS.getInlineStylesForNode"])
        return @{
            @"inlineStyle" : [self inlineStyle:p[@"nodeId"]],
            @"attributesStyle" : @{@"cssProperties" : @[], @"shorthandEntries" : @[]}
        };
    if ([method isEqual:@"CSS.getMatchedStylesForNode"]) {
        int slot = [self slot:p[@"nodeId"]];
        NSMutableArray *matched = [NSMutableArray array];
        for (const auto &rule : debuggerMatchedCssRules(slot)) {
            if (rule.property.empty())
                continue;
            NSDictionary *property = @{
                @"name" : str(rule.property.c_str()),
                @"value" : str(rule.value.c_str()),
                @"text" : [NSString
                    stringWithFormat:@"%s: %s;", rule.property.c_str(), rule.value.c_str()]
            };
            [matched addObject:@{
                @"matchingSelectors" : @[ @0 ],
                @"rule" : @{
                    @"selectorList" : @{
                        @"text" : str(rule.selector.c_str()),
                        @"selectors" : @[ @{@"text" : str(rule.selector.c_str())} ]
                    },
                    @"origin" : rule.userAgent ? @"user-agent" : @"regular",
                    @"style" : @{@"cssProperties" : @[ property ], @"shorthandEntries" : @[]}
                }
            }];
        }
        return @{
            @"inlineStyle" : [self inlineStyle:p[@"nodeId"]],
            @"attributesStyle" : @{@"cssProperties" : @[], @"shorthandEntries" : @[]},
            @"matchedCSSRules" : matched,
            @"pseudoElements" : @[],
            @"inherited" : @[],
            @"cssKeyframesRules" : @[]
        };
    }
    if ([method isEqual:@"CSS.setEffectivePropertyValueForNode"]) {
        [self.context[@"__geaWrite"]
            callWithArguments:@[ p[@"nodeId"], @"style", p[@"propertyName"], p[@"value"] ]];
        return @{};
    }
    if ([method isEqual:@"CSS.setStyleTexts"]) {
        NSMutableArray *styles = [NSMutableArray array];
        for (NSDictionary *edit in p[@"edits"]) {
            NSString *sheet = edit[@"styleSheetId"];
            if (![sheet hasPrefix:@"inline-"])
                @throw [NSException exceptionWithName:@"CDP"
                                               reason:@"Only native inline styles are editable"
                                             userInfo:nil];
            NSNumber *id = @([[sheet substringFromIndex:7] intValue]);
            NSDictionary *old = [self inlineStyle:id];
            NSDictionary *range = edit[@"range"];
            NSString *text = old[@"cssText"];
            if ([range[@"startLine"] intValue] || [range[@"endLine"] intValue])
                @throw [NSException exceptionWithName:@"CDP"
                                               reason:@"Inline styles use a single line"
                                             userInfo:nil];
            NSInteger start = [range[@"startColumn"] integerValue],
                      end = [range[@"endColumn"] integerValue];
            if (start < 0 || end < start || end > (NSInteger)text.length)
                @throw [NSException exceptionWithName:@"CDP"
                                               reason:@"Invalid style range"
                                             userInfo:nil];
            [self setStyleText:[text stringByReplacingCharactersInRange:NSMakeRange(start,
                                                                                    end - start)
                                                             withString:edit[@"text"]]
                          node:id];
            [styles addObject:[self inlineStyle:id]];
        }
        return @{@"styles" : styles};
    }
    if ([method isEqual:@"CSS.getStyleSheetText"]) {
        NSString *sheet = p[@"styleSheetId"];
        if (![sheet hasPrefix:@"inline-"])
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"Unknown style sheet"
                                         userInfo:nil];
        return
            @{@"text" : [self inlineStyle:@([[sheet substringFromIndex:7] intValue])][@"cssText"]};
    }
    if ([method isEqual:@"CSS.getMediaQueries"])
        return @{@"medias" : @[]};
    if ([method isEqual:@"CSS.getPlatformFontsForNode"])
        return @{@"fonts" : @[]};
    if ([method isEqual:@"Runtime.evaluate"] || [method isEqual:@"Runtime.compileScript"] ||
        [method isEqual:@"Runtime.callFunctionOn"]) {
        self.context.exception = nil;
        if ([method isEqual:@"Runtime.compileScript"])
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"Persistent script compilation is not supported"
                                         userInfo:nil];
        JSValue *value;
        if ([method isEqual:@"Runtime.evaluate"])
            value =
                [self.context evaluateScript:p[@"expression"]
                               withSourceURL:[NSURL URLWithString:@"gea://inspector/console.js"]];
        else {
            JSValue *fn = [self.context
                evaluateScript:[NSString stringWithFormat:@"(%@)", p[@"functionDeclaration"]]];
            JSValue *target =
                p[@"objectId"] ? self.objects[p[@"objectId"]] : self.context.globalObject;
            if (!target)
                @throw [NSException exceptionWithName:@"CDP"
                                               reason:@"Remote object no longer exists"
                                             userInfo:nil];
            NSMutableArray *args = [NSMutableArray array];
            for (NSDictionary *arg in p[@"arguments"] ?: @[]) {
                if (arg[@"objectId"]) {
                    JSValue *v = self.objects[arg[@"objectId"]];
                    if (!v)
                        @throw [NSException exceptionWithName:@"CDP"
                                                       reason:@"Remote argument no longer exists"
                                                     userInfo:nil];
                    [args addObject:v];
                } else if (arg[@"unserializableValue"])
                    [args addObject:[self.context evaluateScript:arg[@"unserializableValue"]]];
                else
                    [args addObject:arg[@"value"]
                                        ?: [JSValue valueWithUndefinedInContext:self.context]];
            }
            value = self.context.exception
                        ? fn
                        : [fn invokeMethod:@"apply" withArguments:@[ target, args ]];
        }
        return [self evaluation:value params:p];
    }
    if ([method isEqual:@"Runtime.getProperties"]) {
        JSValue *object = self.objects[p[@"objectId"]];
        if (!object)
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"Remote object no longer exists"
                                         userInfo:nil];
        JSValue *descriptors = [self.context[@"Object"] invokeMethod:@"getOwnPropertyDescriptors"
                                                       withArguments:@[ object ]];
        JSValue *keys = [self.context[@"Object"] invokeMethod:@"keys"
                                                withArguments:@[ descriptors ]];
        NSMutableArray *props = [NSMutableArray array];
        for (NSString *key in [keys toArray]) {
            JSValue *descriptor = descriptors[key];
            NSMutableDictionary *property = [@{
                @"name" : key,
                @"configurable" : @([descriptor[@"configurable"] toBool]),
                @"enumerable" : @([descriptor[@"enumerable"] toBool]),
                @"isOwn" : @YES
            } mutableCopy];
            if ([descriptor hasProperty:@"value"]) {
                property[@"value"] = [self remote:descriptor[@"value"]
                                          byValue:NO
                                            group:@"properties"];
                property[@"writable"] = @([descriptor[@"writable"] toBool]);
            }
            if (![descriptor[@"get"] isUndefined])
                property[@"get"] = [self remote:descriptor[@"get"] byValue:NO group:@"properties"];
            if (![descriptor[@"set"] isUndefined])
                property[@"set"] = [self remote:descriptor[@"set"] byValue:NO group:@"properties"];
            [props addObject:property];
        }
        return @{@"result" : props, @"internalProperties" : @[]};
    }
    if ([method isEqual:@"Runtime.releaseObject"]) {
        [self.objects removeObjectForKey:p[@"objectId"]];
        return @{};
    }
    if ([method isEqual:@"Runtime.releaseObjectGroup"]) {
        for (NSString *id in self.groups[p[@"objectGroup"]])
            [self.objects removeObjectForKey:id];
        [self.groups removeObjectForKey:p[@"objectGroup"]];
        return @{};
    }
    if ([method isEqual:@"Runtime.getIsolateId"])
        return @{@"id" : @"gea-native-inspector"};
    if ([method isEqual:@"Runtime.globalLexicalScopeNames"])
        return @{
            @"names" :
                @[ @"document", @"window", @"$", @"$$", @"$0", @"getComputedStyle", @"console" ]
        };
    if ([method isEqual:@"Page.getFrameTree"])
        return @{@"frameTree" : @{@"frame" : frameInfo()}};
    if ([method isEqual:@"Page.getResourceTree"])
        return @{@"frameTree" : @{@"frame" : frameInfo(), @"resources" : @[]}};
    if ([method isEqual:@"Page.getLayoutMetrics"]) {
        NSSize s = NSApp.mainWindow.contentView.bounds.size;
        NSDictionary *v = @{
            @"pageX" : @0,
            @"pageY" : @0,
            @"clientWidth" : @(s.width),
            @"clientHeight" : @(s.height)
        };
        return @{
            @"cssLayoutViewport" : v,
            @"cssVisualViewport" : @{
                @"offsetX" : @0,
                @"offsetY" : @0,
                @"pageX" : @0,
                @"pageY" : @0,
                @"clientWidth" : @(s.width),
                @"clientHeight" : @(s.height),
                @"scale" : @1
            },
            @"cssContentSize" :
                @{@"x" : @0, @"y" : @0, @"width" : @(s.width), @"height" : @(s.height)}
        };
    }
    if ([method isEqual:@"Page.captureScreenshot"]) {
        NSView *view = NSApp.mainWindow.contentView ?: NSApp.windows.firstObject.contentView;
        NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
        [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png)
            @throw [NSException exceptionWithName:@"CDP"
                                           reason:@"Native window capture failed"
                                         userInfo:nil];
        return @{@"data" : [png base64EncodedStringWithOptions:0]};
    }
    if ([method isEqual:@"Browser.getVersion"])
        return @{
            @"protocolVersion" : @"1.3",
            @"product" : @"Gea/native-macos",
            @"revision" : @"0.1",
            @"userAgent" : @"Gea",
            @"jsVersion" : @"JavaScriptCore"
        };
    if ([method isEqual:@"Log.enable"] || [method isEqual:@"Log.disable"] ||
        [method isEqual:@"Page.enable"] || [method isEqual:@"Page.disable"] ||
        [method isEqual:@"Page.setLifecycleEventsEnabled"] ||
        [method isEqual:@"DOM.markUndoableState"] ||
        [method isEqual:@"Runtime.runIfWaitingForDebugger"])
        return @{};
    @throw [NSException
        exceptionWithName:@"MethodNotFound"
                   reason:[@"Unsupported native protocol method: " stringByAppendingString:method]
                 userInfo:nil];
}
- (void)publishChanges {
    NSDictionary *current = [self snapshot];
    if (self.domEnabled && self.previous.count) {
        BOOL structural = ![[NSSet setWithArray:current.allKeys]
            isEqual:[NSSet setWithArray:self.previous.allKeys]];
        for (NSNumber *id in current)
            if (![current[id][@"children"] isEqual:self.previous[id][@"children"]] ||
                ![current[id][@"tag"] isEqual:self.previous[id][@"tag"]] ||
                ([current[id][@"text"] length] == 0) != ([self.previous[id][@"text"] length] == 0))
                structural = YES;
        if (structural) {
            [self.knownNodes removeAllObjects];
            [self.publishedChildren removeAllObjects];
            [self emit:@"DOM.documentUpdated" params:@{}];
        } else
            for (NSNumber *id in current) {
                if (![self.knownNodes containsObject:id])
                    continue;
                NSDictionary *next = current[id], *old = self.previous[id];
                for (NSString *name in next[@"attributes"])
                    if (![next[@"attributes"][name] isEqual:old[@"attributes"][name]])
                        [self emit:@"DOM.attributeModified"
                            params:@{
                                @"nodeId" : id,
                                @"name" : name,
                                @"value" : next[@"attributes"][name]
                            }];
                for (NSString *name in old[@"attributes"])
                    if (!next[@"attributes"][name])
                        [self emit:@"DOM.attributeRemoved"
                            params:@{@"nodeId" : id, @"name" : name}];
                if ([self.knownNodes containsObject:@(id.intValue + 1)] &&
                    ![next[@"text"] isEqual:old[@"text"]])
                    [self emit:@"DOM.characterDataModified"
                        params:@{@"nodeId" : @(id.intValue + 1), @"characterData" : next[@"text"]}];
                if (self.cssEnabled && ![next[@"computed"] isEqual:old[@"computed"]])
                    [self emit:@"DOM.inlineStyleInvalidated" params:@{@"nodeIds" : @[ id ]}];
            }
    }
    self.previous = [current mutableCopy];
    for (NSNumber *id in debugStyles.allKeys)
        if (!current[id])
            [debugStyles removeObjectForKey:id];
}
- (void)poll {
    if (self.fd < 0)
        return;
    char buffer[65536];
    ssize_t count;
    while ((count = recv(self.fd, buffer, sizeof(buffer), 0)) > 0) {
        [self.input appendBytes:buffer length:count];
        if (self.input.length > 1024 * 1024) {
            close(self.fd);
            self.fd = -1;
            return;
        }
    }
    if (count == 0 || (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
        close(self.fd);
        self.fd = -1;
        return;
    }
    unsigned requests = 0;
    while (requests++ < 64) {
        const char *bytes = (const char *)self.input.bytes;
        const char *newline = (const char *)memchr(bytes, '\n', self.input.length);
        if (!newline)
            break;
        NSUInteger length = newline - bytes;
        NSData *line = [self.input subdataWithRange:NSMakeRange(0, length)];
        [self.input replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:nullptr length:0];
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if (![request isKindOfClass:NSDictionary.class] ||
            ![request[@"id"] isKindOfClass:NSNumber.class] ||
            ![request[@"method"] isKindOfClass:NSString.class]) {
            close(self.fd);
            self.fd = -1;
            return;
        }
        @try {
            NSDictionary *params = request[@"params"] ?: @{};
            if (![params isKindOfClass:NSDictionary.class])
                @throw [NSException exceptionWithName:@"InvalidParams"
                                               reason:@"params must be an object"
                                             userInfo:nil];
            self.context.exception = nil;
            id result = [self handle:request[@"method"] params:params];
            if (self.context.exception) {
                NSString *message = [self.context.exception toString];
                self.context.exception = nil;
                @throw [NSException exceptionWithName:@"CDP" reason:message userInfo:nil];
            }
            [self send:@{@"id" : request[@"id"], @"result" : result ?: @{}}];
        } @catch (NSException *error) {
            [self send:@{
                @"id" : request[@"id"],
                @"error" : @{
                    @"code" : [error.name isEqual:@"MethodNotFound"] ? @(-32601) : @(-32000),
                    @"message" : error.reason ?: @"Native debugger error"
                }
            }];
        }
    }
    [self publishChanges];
    if (self.output.length && self.fd >= 0) {
        ssize_t sent = send(self.fd, self.output.bytes, self.output.length, 0);
        if (sent > 0)
            [self.output replaceBytesInRange:NSMakeRange(0, sent) withBytes:nullptr length:0];
        else if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            close(self.fd);
            self.fd = -1;
        }
    }
}
@end

void gea_macos_debugger_start() {
    static BOOL started = NO;
    if (started || !getenv("GEA_DEBUGGER_NATIVE_PORT"))
        return;
    started = YES;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(atoi(getenv("GEA_DEBUGGER_NATIVE_PORT")));
    if (fd < 0 || bind(fd, (sockaddr *)&addr, sizeof(addr)) || listen(fd, 4)) {
        perror("Gea native debugger listen");
        if (fd >= 0)
            close(fd);
        return;
    }
    fcntl(fd, F_SETFL, O_NONBLOCK);
    socklen_t length = sizeof(addr);
    getsockname(fd, (sockaddr *)&addr, &length);
    debugStyles = [NSMutableDictionary dictionary];
    NSMutableArray<GeaDebugSession *> *sessions = [NSMutableArray array];
    NSTimer *timer = [NSTimer
        timerWithTimeInterval:0.05
                      repeats:YES
                        block:^(NSTimer *) {
                          int peer;
                          while ((peer = accept(fd, nullptr, nullptr)) >= 0) {
                              if (sessions.count >= 4) {
                                  close(peer);
                                  continue;
                              }
                              fcntl(peer, F_SETFL, O_NONBLOCK);
                              int one = 1;
                              setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
                              GeaDebugSession *session = [[GeaDebugSession alloc] init];
                              session.fd = peer;
                              [sessions addObject:session];
                          }
                          for (GeaDebugSession *session in [sessions copy]) {
                              [session poll];
                              if (session.fd < 0)
                                  [sessions removeObject:session];
                          }
                        }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
    printf("GEA_DEBUGGER_READY=%u\n", ntohs(addr.sin_port));
    fflush(stdout);
}
