"""Strict JSON input for AgSDL documents and harness modules."""

import json
from decimal import Decimal


class InputError(Exception):
    """The input is not acceptable JSON."""


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InputError(f"duplicate object key {key!r}")
        result[key] = value
    return result


def _constant(name):
    raise InputError(f"{name} is not a JSON value")


def _check_scalars(value, where="$"):
    if isinstance(value, str):
        for char in value:
            if 0xD800 <= ord(char) <= 0xDFFF:
                raise InputError(f"unpaired surrogate in a string at {where}")
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_scalars(key, where)
            _check_scalars(item, f"{where}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _check_scalars(item, f"{where}[{index}]")


def parse_bytes(data):
    """Parse UTF-8 JSON bytes. Numbers with a fraction or exponent become Decimal."""
    if data.startswith(b"\xef\xbb\xbf"):
        raise InputError("a byte order mark is not allowed")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise InputError(f"invalid UTF-8: {error}") from None
    try:
        value = json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_float=Decimal,
            parse_constant=_constant,
        )
    except json.JSONDecodeError as error:
        raise InputError(f"invalid JSON: {error}") from None
    except RecursionError:
        raise InputError("the input is nested too deeply") from None
    _check_scalars(value)
    return value


def load(path):
    with open(path, "rb") as handle:
        return parse_bytes(handle.read())
