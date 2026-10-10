"""LLDB's Python API over a private, line-delimited stdio channel."""

import json
import queue
import sys
import threading

import lldb


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def check(error):
    if error.Fail():
        raise RuntimeError(error.GetCString() or "LLDB operation failed")


class Worker:
    def __init__(self):
        self.debugger = lldb.SBDebugger.Create()
        self.debugger.SetAsync(True)
        self.listener = self.debugger.GetListener()
        self.target = None
        self.process = None
        self.stop_id = 0
        self.values = {}
        self.next_value = 0
        self.breakpoints = set()

    def thread(self, thread_id=None):
        thread = (self.process.GetThreadByID(int(thread_id)) if thread_id
                  else self.process.GetSelectedThread())
        if not thread.IsValid():
            raise RuntimeError("Native thread is unavailable")
        return thread

    def frame(self, params):
        if self.process.GetState() != lldb.eStateStopped:
            raise RuntimeError("The native app is not paused")
        frame = self.thread(params.get("thread")).GetFrameAtIndex(int(params.get("frame", 0)))
        if not frame.IsValid():
            raise RuntimeError("Native frame is unavailable")
        return frame

    def value(self, value):
        result = {"name": value.GetName() or "", "type": value.GetTypeName() or "native",
                  "value": value.GetValue(), "summary": value.GetSummary()}
        if value.MightHaveChildren():
            self.next_value += 1
            self.values[self.next_value] = value
            result["handle"] = self.next_value
        return result

    def stack(self, thread):
        frames = []
        for level in range(min(thread.GetNumFrames(), 40)):
            frame = thread.GetFrameAtIndex(level)
            entry = frame.GetLineEntry()
            frames.append({"level": level, "function": frame.GetFunctionName() or "(native)",
                           "file": str(entry.GetFileSpec()) if entry.IsValid() else "",
                           "line": entry.GetLine() if entry.IsValid() else 0,
                           "column": entry.GetColumn() if entry.IsValid() else 0})
        return frames

    def lines(self, filename):
        rows = set()
        for module in self.target.module_iter():
            # Frameworks cannot contain the compiler's synthetic source file.
            if module.GetFileSpec() != self.target.GetExecutable():
                continue
            for index in range(module.GetNumCompileUnits()):
                unit = module.GetCompileUnitAtIndex(index)
                if (unit.GetFileSpec().GetFilename() != filename and
                        unit.FindSupportFileIndex(0, lldb.SBFileSpec(filename), False) == lldb.LLDB_INVALID_INDEX32):
                    continue
                for line_index in range(unit.GetNumLineEntries()):
                    entry = unit.GetLineEntryAtIndex(line_index)
                    if entry.GetFileSpec().GetFilename() == filename and entry.GetLine() > 0:
                        rows.add(entry.GetLine())
        return sorted(rows)

    def handle(self, method, params):
        if method == "attach":
            self.debugger.SetAsync(False)
            self.target = self.debugger.CreateTarget(params["executable"])
            if not self.target.IsValid():
                raise RuntimeError("Cannot load the native Mac executable")
            error = lldb.SBError()
            self.process = self.target.AttachToProcessWithID(self.listener, int(params["pid"]), error)
            check(error)
            self.stop_id = self.process.GetStopID()
            lines = self.lines(params["file"])
            self.debugger.SetAsync(True)
            check(self.process.Continue())
            return {"lines": lines}
        if method == "breakpoint":
            breakpoint = self.target.BreakpointCreateByLocation(params["file"], int(params["line"]))
            if not breakpoint.IsValid() or breakpoint.GetNumLocations() == 0:
                if breakpoint.IsValid():
                    self.target.BreakpointDelete(breakpoint.GetID())
                raise RuntimeError("No executable code at this native source position")
            self.breakpoints.add(breakpoint.GetID())
            breakpoint.SetEnabled(params.get("enabled", True))
            if params.get("temporary"):
                breakpoint.SetOneShot(True)
            entry = breakpoint.GetLocationAtIndex(0).GetAddress().GetLineEntry()
            return {"id": breakpoint.GetID(), "line": entry.GetLine()}
        if method == "remove":
            self.target.BreakpointDelete(int(params["id"]))
            self.breakpoints.discard(int(params["id"]))
            return {}
        if method == "active":
            for breakpoint_id in self.breakpoints:
                self.target.FindBreakpointByID(breakpoint_id).SetEnabled(params["active"])
            return {}
        if method == "pause":
            check(self.process.Stop())
            return {}
        if method == "resume":
            check(self.process.Continue())
            return {}
        if method == "step":
            thread = self.thread(params.get("thread"))
            self.process.SetSelectedThread(thread)
            if params["mode"] == "into":
                thread.StepInto(lldb.eOnlyDuringStepping)
            elif params["mode"] == "out":
                thread.StepOut()
            else:
                thread.StepOver(lldb.eOnlyDuringStepping)
            return {}
        if method == "variables":
            variables = self.frame(params).GetVariables(True, True, False, True)
            return {"values": [self.value(value) for value in variables]}
        if method == "children":
            value = self.values.get(int(params["handle"]))
            if value is None:
                raise RuntimeError("Stale native value")
            return {"values": [self.value(value.GetChildAtIndex(i))
                               for i in range(min(value.GetNumChildren(), 128))]}
        if method == "evaluate":
            options = lldb.SBExpressionOptions()
            options.SetTimeoutInMicroSeconds(1000000)
            options.SetIgnoreBreakpoints(True)
            options.SetTryAllThreads(False)
            value = self.frame(params).EvaluateExpression(params["expression"], options)
            check(value.GetError())
            return self.value(value)
        if method == "locations":
            # Return addresses point after the call; look up the call itself.
            addresses = params.get("addresses", [])
            if len(addresses) > 256:
                raise RuntimeError("Native handler location limit exceeded")
            locations = {}
            for text in addresses:
                address = self.target.ResolveLoadAddress(int(text, 16) - 1)
                entry = address.GetLineEntry()
                if not entry.IsValid() or entry.GetLine() <= 0:
                    continue
                function = address.GetFunction()
                locations[text] = {"file": str(entry.GetFileSpec()), "line": entry.GetLine(),
                                   "column": entry.GetColumn(),
                                   "function": function.GetDisplayName() if function.IsValid() else ""}
            return {"locations": locations}
        if method == "close":
            self.close()
            return {}
        raise RuntimeError("Unknown LLDB operation: " + method)

    def events(self):
        event = lldb.SBEvent()
        while self.listener.GetNextEvent(event):
            if not lldb.SBProcess.EventIsProcessEvent(event):
                continue
            state = lldb.SBProcess.GetStateFromEvent(event)
            if state == lldb.eStateRunning:
                emit({"event": "running"})
            elif state == lldb.eStateStopped and not lldb.SBProcess.GetRestartedFromEvent(event):
                stop_id = self.process.GetStopID()
                if stop_id <= self.stop_id:
                    continue
                self.stop_id = stop_id
                self.values.clear()
                thread = self.process.GetSelectedThread()
                for candidate in self.process:
                    if candidate.GetStopReason() in (lldb.eStopReasonBreakpoint, lldb.eStopReasonPlanComplete):
                        thread = candidate
                        break
                self.process.SetSelectedThread(thread)
                reason = thread.GetStopReason()
                hit = [thread.GetStopReasonDataAtIndex(i)
                       for i in range(0, thread.GetStopReasonDataCount(), 2)] if reason == lldb.eStopReasonBreakpoint else []
                emit({"event": "stopped", "thread": str(thread.GetThreadID()),
                      "reason": "breakpoint" if hit else "step" if reason == lldb.eStopReasonPlanComplete else "pause",
                      "breakpoints": hit, "frames": self.stack(thread)})
            elif state in (lldb.eStateExited, lldb.eStateDetached):
                emit({"event": "exited"})
            while self.process and self.process.GetSTDOUT(4096):
                pass

    def close(self):
        if not self.debugger:
            return
        if self.process and self.process.IsValid():
            for breakpoint_id in self.breakpoints:
                self.target.BreakpointDelete(breakpoint_id)
            self.breakpoints.clear()
            if self.process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
                self.process.Detach()
        if self.debugger:
            lldb.SBDebugger.Destroy(self.debugger)
            self.debugger = None


def main():
    requests = queue.Queue()

    def read():
        for line in sys.stdin:
            requests.put(line)
        requests.put(None)

    threading.Thread(target=read, daemon=True).start()
    worker = Worker()
    try:
        while True:
            worker.events()
            try:
                line = requests.get(timeout=0.02)
            except queue.Empty:
                continue
            if line is None:
                break
            request = {}
            try:
                request = json.loads(line)
                result = worker.handle(request["method"], request.get("params", {}))
                emit({"id": request["id"], "result": result})
                if request["method"] == "close":
                    break
            except Exception as error:
                emit({"id": request.get("id"), "error": str(error)})
    finally:
        worker.close()


if __name__ == "__main__":
    main()
