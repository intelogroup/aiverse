#!/usr/bin/env python3
"""STRUCTURAL SURFACE ENUMERATION — the runner lineage, via AST.

Literal string scanning is how PR #76's guard went blind (a dynamic
key is invisible to a shape). This enumerator parses each runner
module's AST and extracts the envoy's exposed surface from code
structure:

  plan verbs        — in any function that BINDS a local `ty` from a
                      step's "type" field (ty = st.get("type") /
                      ty = step["type"]), every string constant the
                      function compares `ty` against is a dispatch
                      verb; corroborated by the step dicts the
                      validator/fallback functions emit
  actuation types   — {"type": ...} dicts passed to .act(...)
  decision kinds    — the kind argument at llm_call(...) call sites
                      (the decision port's two clocks)
  window keys       — the api-key argument at Agent(...) construction,
                      plus window.__* names the runners' evaluate
                      expressions reference
  page methods used — method names invoked on the window api object
                      in the runners' evaluate expressions (plain
                      strings and f-strings, structurally rejoined)
  network           — URL constants, net-capable imports; subprocess
                      use is recorded separately as harness-side
                      machinery (the supervisor's, never addressable
                      by the envoy)

Output: surface.json next to this file.
"""
import ast
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent
EXP = Path.home() / "workspace/.build-tmp/experiments"
PY_FILES = [
    Path.home() / "tmp-pip/exp-work/egg_hunt_runner_v2.py",
    EXP / "gauntlet/gauntlet_runner.py",
    EXP / "drive-layer/drive_runner.py",
    EXP / "drive-layer/drive_layer.py",
    EXP / "checkpoint.py",
]
TSX_FILES = {
    "production": HERE / "fixtures/ScoutAgent.production.tsx",
    "rig": Path.home() / ("tmp-pip/aiverse-experiments/apps/console/"
                          "src/features/world/ScoutAgent.tsx"),
}
EMIT_FUNCS = {"validate_plan", "fallback_plan"}
NET_MODULES = {"urllib", "socket", "requests", "httpx", "aiohttp",
               "http.client", "websocket", "websockets"}
_METHOD_RE = re.compile(
    r"window\s*(?:\.\s*(?:__\w+|§)|\[[^\]]*\])\s*\.\s*(\w+)\s*\(")
_GLOBAL_RE = re.compile(r"window\s*\.\s*(__\w+)")


def _const_str(node):
    return node.value if isinstance(node, ast.Constant) \
        and isinstance(node.value, str) else None


def _func_binds_ty(fn, src):
    """True if fn binds local `ty` from a step's type field."""
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id == "ty":
            seg = ast.get_source_segment(src, node.value) or ""
            if '"type"' in seg or "'type'" in seg:
                return True
    return False


class Surface(ast.NodeVisitor):
    def __init__(self, path, src):
        self.path, self.src = path, src
        self.func_stack = []
        self.plan_verbs = {}       # value -> provenance
        self.actuation = {}
        self.llm_kinds = {}
        self.agent_keys = {}
        self.page_methods = {}
        self.page_globals = {}
        self.urls = {}
        self.imports = set()
        self.subprocess_calls = 0

    def _prov(self, node):
        fn = self.func_stack[-1] if self.func_stack else "<module>"
        return f"{self.path.name}:{fn}:{node.lineno}"

    # -- function-scope pass: dispatch verbs via the `ty` binding ---
    def visit_FunctionDef(self, node):
        if _func_binds_ty(node, self.src):
            for sub in ast.walk(node):
                if not isinstance(sub, ast.Compare):
                    continue
                sides = [sub.left] + list(sub.comparators)
                for i, s in enumerate(sides):
                    v = _const_str(s)
                    if v is None:
                        continue
                    others = sides[:i] + sides[i + 1:]
                    if any(isinstance(o, ast.Name) and o.id == "ty"
                           for o in others):
                        self.plan_verbs[v] = (
                            f"{self.path.name}:{node.name}:{sub.lineno}")
        self.func_stack.append(node.name)
        self.generic_visit(node)
        self.func_stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Import(self, node):
        for a in node.names:
            self.imports.add(a.name.split(".")[0])
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            self.imports.add(node.module.split(".")[0])
        self.generic_visit(node)

    def visit_Dict(self, node):
        fn = self.func_stack[-1] if self.func_stack else ""
        if fn in EMIT_FUNCS:
            for k, v in zip(node.keys, node.values):
                if _const_str(k) == "type" and _const_str(v):
                    self.plan_verbs[_const_str(v)] = self._prov(node)
        self.generic_visit(node)

    def visit_Call(self, node):
        f = node.func
        attr = f.attr if isinstance(f, ast.Attribute) else None
        name = f.id if isinstance(f, ast.Name) else None
        if attr == "act" and node.args and isinstance(node.args[0], ast.Dict):
            for k, v in zip(node.args[0].keys, node.args[0].values):
                if _const_str(k) == "type" and _const_str(v):
                    self.actuation[_const_str(v)] = self._prov(node)
        if name == "llm_call" or attr == "llm_call":
            if len(node.args) >= 2 and _const_str(node.args[1]):
                self.llm_kinds[_const_str(node.args[1])] = self._prov(node)
        if name == "Agent" and len(node.args) >= 2 \
                and _const_str(node.args[1]):
            self.agent_keys[_const_str(node.args[1])] = self._prov(node)
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) \
                and f.value.id == "subprocess":
            self.subprocess_calls += 1
        self.generic_visit(node)

    def _scan_string(self, text, node):
        for m in _METHOD_RE.finditer(text):
            self.page_methods[m.group(1)] = self._prov(node)
        for m in _GLOBAL_RE.finditer(text):
            self.page_globals[m.group(1)] = self._prov(node)

    def visit_Constant(self, node):
        v = node.value
        if isinstance(v, str):
            if v.startswith(("http://", "https://")):
                self.urls[v] = self._prov(node)
            if "window" in v:
                self._scan_string(v, node)
        self.generic_visit(node)

    def visit_JoinedStr(self, node):
        parts = []
        for v in node.values:
            parts.append(v.value if isinstance(v, ast.Constant)
                         and isinstance(v.value, str) else "§")
        self._scan_string("".join(parts), node)
        self.generic_visit(node)


def enumerate_python():
    agg = {"plan_verbs": {}, "actuation": {}, "llm_kinds": {},
           "agent_keys": {}, "page_methods": {}, "page_globals": {},
           "urls": {}, "net_imports": {}, "subprocess_calls": {}}
    for p in PY_FILES:
        src = p.read_text()
        s = Surface(p, src)
        s.visit(ast.parse(src, filename=str(p)))
        for cat in ("plan_verbs", "actuation", "llm_kinds",
                    "agent_keys", "page_methods", "page_globals",
                    "urls"):
            agg[cat].update(getattr(s, cat))
        net = sorted(s.imports & NET_MODULES)
        if net:
            agg["net_imports"][p.name] = net
        if s.subprocess_calls:
            agg["subprocess_calls"][p.name] = s.subprocess_calls
    return agg


def enumerate_tsx():
    out = {}
    for label, p in TSX_FILES.items():
        r = subprocess.run(["node", str(HERE / "enumerate_tsx.js"),
                            str(p)], capture_output=True, text=True,
                           timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"tsx enumeration failed for {label}: "
                               f"{r.stderr[:400]}")
        out[label] = json.loads(r.stdout)
    return out


def main():
    py = enumerate_python()
    tsx = enumerate_tsx()
    hosts = sorted({urlparse(u).netloc for u in py["urls"]})
    surface = {"python": py, "tsx": tsx, "network_hosts": hosts}
    (HERE / "surface.json").write_text(json.dumps(surface, indent=1))
    print("plan verbs:      ", sorted(py["plan_verbs"]))
    print("actuation:       ", sorted(py["actuation"]))
    print("decision kinds:  ", sorted(py["llm_kinds"]))
    print("agent keys (py): ", sorted(py["agent_keys"]))
    print("page globals ref:", sorted(py["page_globals"]))
    print("page methods:    ", sorted(py["page_methods"]))
    print("network hosts:   ", hosts)
    for label, t in tsx.items():
        print(f"tsx[{label}] globals:",
              sorted({g['name'] for g in t['globals']}),
              "| apis:", {k: sorted(v) for k, v in t['apis'].items()},
              "| page action types:", t["action_types"],
              "| fetch:", t["fetch_calls"])
    print(f"wrote {HERE / 'surface.json'}")
    return surface


if __name__ == "__main__":
    main()
