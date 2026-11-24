"""Static evaluation of AgSDL permissions."""

import re

ACTIONS = ("read", "write", "shell", "network", "mcp", "delegate")
ORDER = {"allow": 0, "ask": 1, "deny": 2}

PRESETS = {
    "read-only": {"read": "allow", "write": "deny", "shell": "deny", "network": "deny", "mcp": "deny", "delegate": "deny"},
    "workspace": {"read": "allow", "write": "allow", "shell": "allow", "network": "deny", "mcp": "allow", "delegate": "allow"},
    "full": {action: "allow" for action in ACTIONS},
}


def normalize(permissions):
    """Return (preset or None, rules) for a declared permissions value."""
    if permissions is None:
        return None, []
    if isinstance(permissions, str):
        return permissions, []
    return permissions.get("preset"), permissions.get("rules", [])


def outside(permissions):
    """Whether reads outside the zone are denied ("deny") or allowed ("read")."""
    preset, _ = normalize(permissions)
    if isinstance(permissions, dict) and "outside" in permissions:
        return permissions["outside"]
    return "read" if preset == "full" else "deny"


def covers_all(rule):
    """Whether a rule covers every use of its action: no match, or only `*`.
    A path pattern is relative to the workspace, so `**` covers the
    workspace only; `/**` covers every path."""
    if "match" not in rule:
        return True
    if rule["action"] in ("read", "write"):
        return rule["match"] == "/**"
    return set(rule["match"]) == {"*"}


def shell_denied(permissions):
    """Whether the agent can run no shell command at all."""
    preset, rules = normalize(permissions)
    shell = [rule for rule in rules if rule["action"] == "shell"]
    if any(rule["effect"] == "deny" and covers_all(rule) for rule in shell):
        return True
    if any(rule["effect"] != "deny" for rule in shell):
        return False
    return (PRESETS[preset]["shell"] if preset else "deny") == "deny"


def glob_matches(pattern, text, paths=False, command=False):
    """Match `*` (and `**` for paths) against text. For a command, a final
    ` *` also covers the command without arguments."""
    if command and pattern.endswith(" *") and text == pattern[:-2]:
        return True
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i) and paths:
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*" if paths else ".*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.fullmatch("".join(out), text, re.DOTALL) is not None


def effect_for(permissions, action, subject):
    """The effective effect of one concrete action, as far as it can be decided statically."""
    preset, rules = normalize(permissions)
    paths = action in ("read", "write")
    command = action == "shell"
    matching = [
        rule["effect"]
        for rule in rules
        if rule["action"] == action and ("match" not in rule or glob_matches(rule["match"], subject, paths, command))
    ]
    if matching:
        return max(matching, key=ORDER.get)
    if preset is None:
        return "deny"
    return PRESETS[preset][action]


def command_prefix(pattern):
    """Whether a shell pattern names leading words: words alone, or words
    then ` *`. A harness that matches commands by their leading words
    enforces a deny or ask on such a pattern, and no other."""
    words = pattern[:-2] if pattern.endswith(" *") else pattern
    return bool(words) and "*" not in words and words == words.strip()


def effects_in_use(permissions):
    """For each action, the set of effects the agent's permissions can produce."""
    preset, rules = normalize(permissions)
    result = {}
    for action in ACTIONS:
        effects = {rule["effect"] for rule in rules if rule["action"] == action}
        if not any(rule["action"] == action and covers_all(rule) for rule in rules):
            default = "deny" if preset is None else PRESETS[preset][action]
            effects.add(default)
            if preset == "workspace" and action == "write":
                effects.add("deny")
        result[action] = effects
    return result
