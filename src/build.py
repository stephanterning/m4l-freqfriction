"""Build both self-contained Max for Live devices."""
import base64
import json
from pathlib import Path
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
APP_VERSION = dict(major=9, minor=0, revision=0, architecture="x64", modernui=1)
BANK_SIZE = 31
ROUTING = (ROOT / "routing.js").read_text()


# Rebuild the portable kernels with: python3 src/build.py --dsp /path/to/zig
# Normal device builds embed the checked-in module and need only Python.
if len(sys.argv) == 3 and sys.argv[1] == "--dsp":
    subprocess.run([sys.argv[2], "cc", "-target", "wasm32-freestanding", "-O3",
                    "-nostdlib", "-ffp-contract=off", "-Wl,--no-entry", "-Wl,--strip-all",
                    "-Wl,--export=decimate", "-Wl,--export=probepower",
                    "-Wl,--export=resample", "-Wl,--export=fftpower", "-Wl,--export=__heap_base",
                    "dsp.c", "-o", "dsp.wasm"], cwd=ROOT, check=True)

class Patcher:
    def __init__(self):
        self.boxes = []
        self.lines = []

    def box(self, name, kind, rect, presentation=None, **attrs):
        entry = dict(id=name, maxclass=kind, patching_rect=rect, **attrs)
        if presentation:
            entry.update(presentation=1, presentation_rect=presentation)
        self.boxes.append({"box": entry})

    def obj(self, name, text, x, y, **attrs):
        self.box(name, "newobj", [x, y, max(80, min(700, len(text) * 7)), 22], text=text, **attrs)

    def message(self, name, text, x, y):
        self.box(name, "message", [x, y, max(85, len(text) * 6), 22], text=text)

    def js(self, name, kind, text, rect, presentation, outlets, **attrs):
        if kind == "v8":
            attrs["text"] = f"v8 1 {outlets}"
            kind = "newobj"
        self.box(name, kind, rect, presentation, varname=name, filename="none",
                 numinlets=1, numoutlets=outlets, outlettype=[""] * outlets,
                 textfile=dict(filename="none", text=text, embed=1, flags=0, autowatch=0), **attrs)

    def wire(self, source, target, outlet=0, inlet=0):
        self.lines.append({"patchline": {"source": [source, outlet], "destination": [target, inlet]}})

    def data(self, rect, **attrs):
        return dict(fileversion=1, appversion=APP_VERSION, classnamespace="box", rect=rect,
                    openinpresentation=1, boxes=self.boxes, lines=self.lines, **attrs)


def input_bank(patch, helper):
    channels = BANK_SIZE * 2
    inputs = " ".join(map(str, range(1, channels + 3)))
    patch.obj("inputs", "plugin~ " + inputs, 15, 270)
    patch.obj("through", "plugout~ 1 2", 15, 330)
    # Keep each Live input bound to a separate stereo memory and synchronize the writers.
    prefix = "#0-ff-helper" if helper else "#0-ff-main"
    patch.obj("capture", "int", 230, 330, varname="capture")
    if helper:
        patch.obj("start", "loadmess 1", 485, 235)
    patch.wire("inputs", "through")
    patch.wire("inputs", "through", 1, 1)
    for slot in range(BANK_SIZE):
        name = f"{prefix}-{slot}"
        x = 20 + 215 * (slot % 4)
        y = 1240 + 76 * (slot // 4)
        patch.obj(f"buffer{slot}", f"buffer~ {name} 500 2", x, y)
        patch.obj(f"capture{slot}", f"record~ {name} 2 @loop 1", x, y + 28)
        patch.wire("inputs", f"capture{slot}", 2 + 2 * slot)
        patch.wire("inputs", f"capture{slot}", 3 + 2 * slot, 1)
        patch.wire("capture", f"capture{slot}")
    patch.obj("head", "snapshot~", 370, 385, varname="head")
    patch.wire("capture0", "head")
    if helper:
        patch.obj("sample-request", "receive FreqFriction.Stereo.Capture", 600, 330)
        patch.wire("sample-request", "plot")
    else:
        patch.obj("clock", "qmetro 85", 435, 330, varname="clock")
        patch.wire("clock", "head")
        patch.obj("engine-state", "dspstate~", 935, 385)
        patch.obj("engine-rate", "prepend engineRate", 935, 415)
        patch.wire("inputs", "engine-state")
        patch.wire("poll", "engine-state")
        patch.wire("engine-state", "engine-rate", 1)
        patch.wire("engine-rate", "plot")
    patch.obj("buf-name", f"loadmess buffername {prefix}", 610, 330)
    patch.obj("live-ready", "live.thisdevice", 505, 395)
    patch.obj("init", "deferlow", 505, 425)
    patch.obj("poll", "qmetro 1000", 650, 395, **({} if helper else {"varname": "poll"}))
    patch.message("device-path", "path this_device", 570, 470)
    patch.obj("device-id", "live.path", 720, 470)
    patch.obj("bind-device", "prepend bindDevice", 720, 505)
    patch.obj("routing-clock", "qmetro 65", 350, 440, **({} if helper else {"varname": "routingClock"}))
    patch.message("routing-update", "updateRouting", 350, 480)
    patch.wire("live-ready", "init")
    if helper:
        patch.wire("init", "device-path")
        patch.wire("start", "poll")
    patch.wire("poll", "device-path")
    patch.wire("device-path", "device-id")
    patch.wire("device-id", "bind-device")
    if helper:
        patch.wire("start", "routing-clock")
    patch.wire("routing-clock", "routing-update")
    for item in ("head", "bind-device", "buf-name", "routing-update"):
        patch.wire(item, "plot")

    for i in range(BANK_SIZE):
        x = 20 + 115 * (i % 8)
        y = 850 + 90 * (i // 8)
        patch.obj(f"dispatch{i}", "routepass id", x, y)
        patch.obj(f"io{i}", "live.object", x, y + 28)
        patch.wire("plot", f"dispatch{i}", i)
        patch.wire(f"dispatch{i}", f"io{i}", 0, 1)
        patch.wire(f"dispatch{i}", f"io{i}", 1, 0)


def window():
    patch = Patcher()
    html = (ROOT / "monitor.html").read_text().replace("/* MONITOR_SCRIPT */", (ROOT / "spectrum.js").read_text())
    url = "data:text/html;charset=utf-8;base64," + base64.b64encode(html.encode()).decode()
    script = "const monitorURL = " + json.dumps(url) + ";\n" + (ROOT / "monitor.js").read_text()
    patch.js("plot", "v8", script, [10, 610, 160, 22], None, 1)
    patch.box("command", "inlet", [760, 620, 40, 22])
    patch.obj("window", "thispatcher", 760, 655)
    patch.obj("closed", "closebang", 760, 690)
    patch.message("closed-message", "windowClosed", 760, 725)
    patch.box("reply", "outlet", [760, 760, 40, 22])
    for source, target in [("command", "window"), ("closed", "closed-message"),
                           ("closed-message", "plot"), ("plot", "reply")]:
        patch.wire(source, target)
    return patch.data([120, 140, 935, 594], toolbarvisible=0, statusbarvisible=0,
                      enablehscroll=0, enablevscroll=0)


def main_patcher():
    patch = Patcher()
    input_bank(patch, helper=False)
    kernels = json.dumps(list((ROOT / "dsp.wasm").read_bytes()), separators=(",", ":"))
    script = ROUTING + "const kernelBytes = " + kernels + ";\n" + (ROOT / "analysis.js").read_text() + (ROOT / "analyzer.js").read_text()
    patch.js("plot", "v8", script, [15, 550, 180, 22], None, BANK_SIZE)
    patch.box("float-button", "live.text", [775, 550, 72, 20], [8, 12, 84, 25],
              fontname="Ableton Sans Small", fontface=1, fontsize=10.0, text="Float", texton="Float", mode=1, varname="floatToggle", parameter_enable=1,
              saved_attribute_attributes={"valueof": dict(parameter_longname="Float", parameter_shortname="Float",
                  parameter_type=2, parameter_enum=["Closed", "Open"], parameter_mmax=1,
                  parameter_initial_enable=1, parameter_initial=[0])},
              annotation="Show or hide the floating FreqFriction window")
    patch.box("monitor", "newobj", [750, 675, 120, 22], text="p FreqFriction", varname="monitor",
              numinlets=1, numoutlets=1, outlettype=[""], patcher=window())
    patch.obj("window-trigger", "t b b b", 570, 665)
    patch.message("window-open", "open", 670, 705)
    patch.obj("window-control", "pcontrol", 670, 738)
    patch.obj("window-defer", "deferlow", 570, 705)
    patch.message("window-style", "title FreqFriction, window flags float grow, window exec", 570, 770)
    patch.message("window-sync", "monitorOpened", 570, 810)
    patch.obj("window-select", "sel 1 0", 775, 590)
    patch.message("window-close", "close", 820, 705)
    patch.wire("float-button", "window-select")
    patch.wire("window-select", "window-trigger")
    patch.wire("window-select", "window-close", 1)
    patch.wire("window-close", "window-control")
    patch.wire("window-trigger", "window-open", 1)
    patch.wire("window-open", "window-control")
    patch.wire("window-control", "monitor")
    patch.wire("window-trigger", "window-defer")
    patch.wire("window-trigger", "window-style", 2)
    patch.wire("window-style", "monitor")
    patch.wire("window-defer", "window-sync")
    patch.wire("window-sync", "plot")
    patch.wire("monitor", "plot")
    return patch.data([0, 0, 960, 1210], parameters={"float-button": ["Float", "Float", 0]}, devicewidth=100, latency=0, autosave=0,
                      description="Multitrack spectral masking monitor")


def helper_patcher():
    patch = Patcher()
    input_bank(patch, helper=True)
    patch.js("plot", "v8", ROUTING + (ROOT / "helper.js").read_text(),
             [15, 550, 180, 22], None, BANK_SIZE)
    patch.box("caption", "comment", [15, 15, 212, 38], [9, 12, 206, 38],
              fontname="Ableton Sans Small", fontface=1, fontsize=10.0,
              text="Adds 31 stereo inputs to the main FreqFriction device.", linecount=2)
    return patch.data([0, 0, 960, 1210], devicewidth=226, latency=0, autosave=0,
                      description="Input helper for FreqFriction")


def write_device(name, patch):
    payload = json.dumps({"patcher": patch}, indent=2).encode() + b'\n\0'
    header = b'ampf' + struct.pack('<I', 4) + b'aaaa' + b'meta' + struct.pack('<II', 4, 0)
    (ROOT.parent / name).write_bytes(header + b'ptch' + struct.pack('<I', len(payload)) + payload)


write_device("FreqFriction.amxd", main_patcher())
write_device("FreqFriction Input.amxd", helper_patcher())
