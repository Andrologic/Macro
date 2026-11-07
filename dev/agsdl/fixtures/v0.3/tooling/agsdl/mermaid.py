"""Render a flow or a composition as a Mermaid flowchart.

Usage: python3 -m agsdl.mermaid DOCUMENT [--composition NAME]

The drawing shows authored steps and routes. The flow's onError is drawn as an
error route from the start. Compose steps are drawn as one box; render a
composition on its own to see its body.
"""

import argparse
import sys

from . import jsoninput
from .graph import route_items, route_targets, step_routes

SHAPES = {
    "join": ('(["', '"])'),
    "compose": ('[["', '"]]'),
}


def label(text):
    return text.replace('"', "#quot;")


def render(steps, entry, on_error=None):
    ids = {name: f"s{index}" for index, name in enumerate(steps)}
    lines = ["flowchart LR", '  start(( )) --> ' + ids[entry]]
    for name, step in steps.items():
        opening, closing = SHAPES.get(step["type"], ('["', '"]'))
        lines.append(f"  {ids[name]}{opening}{label(step.get('title', name))}{closing}")
    # The flow's onError: failures not handled elsewhere start there.
    for tkind, target, _, _ in route_targets(on_error, []) if on_error is not None else []:
        if tkind == "step" and target in ids:
            lines.append(f"  start -. error .-> {ids[target]}")
    exits = {}
    ended = []
    for name, step in steps.items():
        for kind, key, route, _ in step_routes(step, []):
            if route == [] and key is not None:
                if not ended:
                    ended.append(True)
                    lines.append('  finish((("end")))')
                lines.append(f"  {ids[name]} -- {label(key)} --> finish")
            for tkind, target, _, _, each in route_items(route, []):
                if tkind == "output":
                    if target not in exits:
                        exits[target] = f"o{len(exits)}"
                        lines.append(f"  {exits[target]}>\"{label(target)}\"]")
                    destination = exits[target]
                elif target in ids:
                    destination = ids[target]
                else:
                    continue
                # A fan-out starts its target once per element: drawn as a thick arrow.
                arrow = "==>" if each is not None else "-->"
                if kind == "error":
                    lines.append(f"  {ids[name]} -. error .-> {destination}")
                elif key is not None:
                    lines.append(f"  {ids[name]} -- {label(key)} {arrow} {destination}")
                else:
                    lines.append(f"  {ids[name]} {arrow} {destination}")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agsdl.mermaid", description="Draw an AgSDL flow as Mermaid.")
    parser.add_argument("document")
    parser.add_argument("--composition", help="draw this composition instead of the flow")
    args = parser.parse_args(argv)
    try:
        document = jsoninput.load(args.document)
    except (OSError, jsoninput.InputError) as error:
        print(f"agsdl.mermaid: {error}", file=sys.stderr)
        return 2
    if args.composition:
        container = document.get("compositions", {}).get(args.composition)
    else:
        container = document.get("flow")
    if not container:
        print("agsdl.mermaid: nothing to draw", file=sys.stderr)
        return 2
    sys.stdout.write(render(container["steps"], container["entry"], container.get("onError")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
