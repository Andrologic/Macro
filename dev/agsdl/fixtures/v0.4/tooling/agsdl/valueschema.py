"""AgSDL value schemas: consistency checks and value validation."""

from decimal import Decimal

from .schemacheck import json_equal, json_type_matches, pointer

ARRAY_ONLY = ("items", "minItems", "maxItems")
OBJECT_ONLY = ("properties", "required", "additionalProperties")


def is_index(part):
    """Whether a path part is an array index: an integer, possibly written 0.0."""
    if isinstance(part, bool):
        return False
    return isinstance(part, int) or (isinstance(part, Decimal) and part == part.to_integral_value())


def consistency(schema, path):
    """Return (pointer, message) problems in a value schema whose shape is already valid."""
    problems = []
    kind = schema["type"]
    for key in ARRAY_ONLY:
        if key in schema and kind != "array":
            problems.append((pointer(path + [key]), f"{key} is allowed only on arrays"))
    for key in OBJECT_ONLY:
        if key in schema and kind != "object":
            problems.append((pointer(path + [key]), f"{key} is allowed only on objects"))
    if "enum" in schema:
        values = schema["enum"]
        for index, value in enumerate(values):
            if not json_type_matches(value, kind):
                problems.append((pointer(path + ["enum", index]), f"enum value is not of type {kind}"))
            if any(json_equal(value, earlier) for earlier in values[:index]):
                problems.append((pointer(path + ["enum", index]), "duplicate enum value"))
    if kind == "object":
        declared = schema.get("properties", {})
        for index, name in enumerate(schema.get("required", [])):
            if name not in declared:
                problems.append((pointer(path + ["required", index]), f"{name!r} is not a declared property"))
        for name, child in declared.items():
            problems.extend(consistency(child, path + ["properties", name]))
    if schema.get("minItems", 0) > schema.get("maxItems", schema.get("minItems", 0)):
        problems.append((pointer(path + ["minItems"]), "minItems exceeds maxItems"))
    if kind == "array" and "items" in schema:
        problems.extend(consistency(schema["items"], path + ["items"]))
    return problems


def validate(value, schema, path):
    """Return (pointer, message) violations of value against a consistent value schema."""
    kind = schema["type"]
    if not json_type_matches(value, kind):
        return [(pointer(path), f"expected {kind}")]
    problems = []
    if "enum" in schema and not any(json_equal(value, item) for item in schema["enum"]):
        allowed = ", ".join(repr(item) for item in schema["enum"])
        problems.append((pointer(path), f"expected one of {allowed}"))
    if kind == "array" and len(value) < schema.get("minItems", 0):
        problems.append((pointer(path), f"expected at least {schema['minItems']} item{'' if schema['minItems'] == 1 else 's'}"))
    if kind == "array" and "maxItems" in schema and len(value) > schema["maxItems"]:
        problems.append((pointer(path), f"expected at most {schema['maxItems']} item{'' if schema['maxItems'] == 1 else 's'}"))
    if kind == "array" and "items" in schema:
        for index, item in enumerate(value):
            problems.extend(validate(item, schema["items"], path + [index]))
    if kind == "object":
        declared = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                problems.append((pointer(path), f"missing {name!r}"))
        for name, item in value.items():
            if name in declared:
                problems.extend(validate(item, declared[name], path + [name]))
            elif schema.get("additionalProperties") is False:
                problems.append((pointer(path + [name]), f"unknown {name!r}"))
    return problems


def descend(schema, path):
    """Follow a selection path below a value schema.

    Returns (ok, reason). ok is None when the path leaves what the schema
    declares and cannot be checked further.
    """
    node = schema
    for index, part in enumerate(path):
        if node is None:
            return None, None
        kind = node["type"]
        if kind == "object" and isinstance(part, str):
            declared = node.get("properties", {})
            if part not in declared:
                if node.get("additionalProperties") is False:
                    return False, f"{part!r} is not a declared property"
                return None, None
            node = declared[part]
        elif kind == "array" and is_index(part):
            if "maxItems" in node and int(part) >= node["maxItems"]:
                return False, f"index {int(part)} is beyond the {node['maxItems']} items the list may have"
            node = node.get("items")
        else:
            return False, f"cannot select {part!r} in a value of type {kind}"
    return True, None


def kind_at(schema, path):
    """The declared type of the value at path below a schema, or None when undeclared."""
    node = schema
    for part in path:
        if node is None or "type" not in node:
            return None
        kind = node["type"]
        if kind == "object" and isinstance(part, str):
            node = (node.get("properties") or {}).get(part)
        elif kind == "array" and is_index(part):
            node = node.get("items")
        else:
            return None
    return node.get("type") if node is not None else None
