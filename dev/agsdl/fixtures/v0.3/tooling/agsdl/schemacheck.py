"""A small JSON Schema checker for the keywords the AgSDL schemas use.

It supports: $ref (local), type, const, enum, pattern, minLength, minimum,
minItems, maxItems, uniqueItems, prefixItems, items, properties, required,
additionalProperties, propertyNames, oneOf, anyOf and not. Annotations are
ignored. It is not a general JSON Schema implementation.
"""

import re
from decimal import Decimal


def json_equal(left, right):
    """Equality of JSON values, keeping booleans distinct from numbers."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if is_number(left) and is_number(right):
        return Decimal(str(left)) == Decimal(str(right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(json_equal(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return type(left) is type(right) and left == right


def is_number(value):
    return isinstance(value, (int, Decimal)) and not isinstance(value, bool)


def is_integer(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, Decimal) and value == value.to_integral_value()


def json_type_matches(value, name):
    if name == "null":
        return value is None
    if name == "boolean":
        return isinstance(value, bool)
    if name == "number":
        return is_number(value)
    if name == "integer":
        return is_integer(value)
    if name == "string":
        return isinstance(value, str)
    if name == "array":
        return isinstance(value, list)
    if name == "object":
        return isinstance(value, dict)
    return False


def pointer(parts):
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


class SchemaChecker:
    def __init__(self, root):
        self.root = root
        self._patterns = {}

    def check(self, value):
        """Return a list of (pointer, message) for value against the root schema."""
        errors = []
        self._check(value, self.root, [], errors)
        return errors

    def _resolve(self, ref):
        if not ref.startswith("#/"):
            raise ValueError(f"unsupported reference {ref}")
        node = self.root
        for part in ref[2:].split("/"):
            node = node[part.replace("~1", "/").replace("~0", "~")]
        return node

    def _pattern(self, text):
        if text not in self._patterns:
            # In JSON Schema, a final $ ends the string; in Python it also
            # matches before a final newline.
            source = text[:-1] + r"\Z" if text.endswith("$") and not text.endswith("\\$") else text
            self._patterns[text] = re.compile(source)
        return self._patterns[text]

    def _check(self, value, schema, path, errors):
        if schema is True:
            return
        if schema is False:
            errors.append((pointer(path), "no value is allowed here"))
            return
        if "$ref" in schema:
            self._check(value, self._resolve(schema["$ref"]), path, errors)
        if "type" in schema:
            names = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not any(json_type_matches(value, n) for n in names):
                errors.append((pointer(path), f"expected {' or '.join(names)}"))
                return
        if "const" in schema and not json_equal(value, schema["const"]):
            errors.append((pointer(path), f"expected {schema['const']!r}"))
        if "enum" in schema and not any(json_equal(value, item) for item in schema["enum"]):
            allowed = ", ".join(repr(item) for item in schema["enum"])
            errors.append((pointer(path), f"expected one of {allowed}"))
        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                errors.append((pointer(path), "the string is too short"))
            if "pattern" in schema and not self._pattern(schema["pattern"]).search(value):
                shown = schema["pattern"] if len(schema["pattern"]) <= 80 else "the expected syntax"
                errors.append((pointer(path), f"{value!r} does not match {shown}"))
        if is_number(value) and "minimum" in schema and value < schema["minimum"]:
            errors.append((pointer(path), f"expected at least {schema['minimum']}"))
        if isinstance(value, list):
            self._check_array(value, schema, path, errors)
        if isinstance(value, dict):
            self._check_object(value, schema, path, errors)
        if "not" in schema:
            probe = []
            self._check(value, schema["not"], path, probe)
            if not probe:
                errors.append((pointer(path), "this combination of fields is not allowed"))
        if "anyOf" in schema:
            results = [self._try(value, option, path) for option in schema["anyOf"]]
            if all(results):
                errors.extend(_best(results))
        if "oneOf" in schema:
            results = [self._try(value, option, path) for option in schema["oneOf"]]
            passing = sum(1 for r in results if not r)
            if passing == 0:
                errors.extend(_best(results))
            elif passing > 1:
                errors.append((pointer(path), "the value matches several alternatives"))

    def _try(self, value, schema, path):
        probe = []
        self._check(value, schema, path, probe)
        return probe

    def _check_array(self, value, schema, path, errors):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append((pointer(path), f"expected at least {schema['minItems']} items"))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append((pointer(path), f"expected at most {schema['maxItems']} items"))
        if schema.get("uniqueItems"):
            for i in range(len(value)):
                for j in range(i):
                    if json_equal(value[i], value[j]):
                        errors.append((pointer(path + [i]), "duplicate item"))
                        break
        prefix = schema.get("prefixItems", [])
        for index, item in enumerate(value):
            if index < len(prefix):
                self._check(item, prefix[index], path + [index], errors)
            elif "items" in schema:
                self._check(item, schema["items"], path + [index], errors)

    def _check_object(self, value, schema, path, errors):
        for name in schema.get("required", []):
            if name not in value:
                errors.append((pointer(path), f"missing field {name!r}"))
        properties = schema.get("properties", {})
        for key, item in value.items():
            if "propertyNames" in schema:
                probe = []
                self._check(key, schema["propertyNames"], path + [key], probe)
                if probe:
                    errors.append((pointer(path + [key]), f"invalid name {key!r}"))
                    continue
            if key in properties:
                self._check(item, properties[key], path + [key], errors)
            elif "additionalProperties" in schema:
                extra = schema["additionalProperties"]
                if extra is False:
                    errors.append((pointer(path + [key]), f"unknown field {key!r}"))
                elif extra is not True:
                    self._check(item, extra, path + [key], errors)


def _best(results):
    """Pick the most specific failure among alternatives."""
    def score(errors):
        depth = max(len(p.split("/")) for p, _ in errors)
        return (depth, -len(errors))
    return max(results, key=score)
