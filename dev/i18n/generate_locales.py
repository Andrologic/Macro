from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
LOCALE_DIR = ROOT / "src" / "i18n" / "locales"
GLOSSARY_PATH = ROOT / "dev" / "i18n" / "glossary.json"
SOURCE_LOCALE = "en"
TARGET_LOCALES = {
    "fr": "French",
    "es": "Spanish",
    "de": "German",
    "ja": "Japanese",
    "ko": "Korean",
}
PLACEHOLDER_RE = re.compile(r"\{\{\s*[^}]+\s*\}\}")
SENTINEL = "\n[[[SEP]]]\n"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_glossary() -> dict[str, dict[str, Any]]:
    if not GLOSSARY_PATH.exists():
        return {}

    raw = read_json(GLOSSARY_PATH)
    glossary: dict[str, dict[str, Any]] = {}

    for locale, config in raw.items():
        glossary[locale] = {
            "exact": config.get("exact", {}),
            "replacements": [tuple(item) for item in config.get("replacements", [])],
        }

    return glossary


def translate_google_query(text: str, target_locale: str) -> str:
    url = (
        "https://translate.googleapis.com/translate_a/single"
        f"?client=gtx&sl=en&tl={target_locale}&dt=t&q={urllib.parse.quote(text)}"
    )
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return "".join(part[0] for part in payload[0] if part and part[0])


def collect_plain_segments(node: Any, segments: set[str]) -> None:
    if isinstance(node, dict):
        for value in node.values():
            collect_plain_segments(value, segments)
        return

    if isinstance(node, list):
        for value in node:
            collect_plain_segments(value, segments)
        return

    if not isinstance(node, str):
        return

    last_index = 0
    for match in PLACEHOLDER_RE.finditer(node):
        segment = node[last_index:match.start()]
        if segment:
            segments.add(segment)
        last_index = match.end()

    trailing = node[last_index:]
    if trailing:
        segments.add(trailing)


def translate_segments(segments: set[str], target_locale: str) -> dict[str, str]:
    non_empty_segments = [segment for segment in sorted(segments) if segment.strip()]
    translations: dict[str, str] = {segment: segment for segment in segments if not segment.strip()}
    batch_size = 50

    for start in range(0, len(non_empty_segments), batch_size):
        batch = non_empty_segments[start : start + batch_size]
        translated = translate_google_query(SENTINEL.join(batch), target_locale)
        translated_parts = translated.split(SENTINEL)

        if len(translated_parts) != len(batch):
            translated_parts = [
                translate_google_query(segment, target_locale).replace("Â ", " ")
                for segment in batch
            ]

        for original, localized in zip(batch, translated_parts):
            translations[original] = localized.replace("Â ", " ")

        time.sleep(0.2)

    return translations


def apply_replacements(value: str, replacements: list[tuple[str, str]]) -> str:
    localized = value
    for source, target in replacements:
        localized = localized.replace(source, target)
    return localized


def translate_node(
    node: Any,
    segment_translations: dict[str, str],
    exact_overrides: dict[str, str],
    replacements: list[tuple[str, str]],
) -> Any:
    if isinstance(node, dict):
        return {
            key: translate_node(value, segment_translations, exact_overrides, replacements)
            for key, value in node.items()
        }
    if isinstance(node, list):
        return [
            translate_node(value, segment_translations, exact_overrides, replacements)
            for value in node
        ]
    if isinstance(node, str):
        if node in exact_overrides:
            return exact_overrides[node]

        parts: list[str] = []
        last_index = 0

        for match in PLACEHOLDER_RE.finditer(node):
            segment = node[last_index:match.start()]
            if segment:
                parts.append(segment_translations.get(segment, segment))
            parts.append(match.group(0))
            last_index = match.end()

        trailing = node[last_index:]
        if trailing:
            parts.append(segment_translations.get(trailing, trailing))

        if not parts:
            return node

        translated = "".join(parts).replace("Â ", " ")
        return apply_replacements(translated, replacements)
    return node


def main() -> int:
    source_path = LOCALE_DIR / f"{SOURCE_LOCALE}.json"
    source_locale = read_json(source_path)
    glossary = load_glossary()
    plain_segments: set[str] = set()
    collect_plain_segments(source_locale, plain_segments)

    for locale in TARGET_LOCALES:
        print(f"Generating {locale}.json...", flush=True)
        segment_translations = translate_segments(plain_segments, locale)
        locale_glossary = glossary.get(locale, {})
        translated = translate_node(
            source_locale,
            segment_translations,
            locale_glossary.get("exact", {}),
            locale_glossary.get("replacements", []),
        )
        write_json(LOCALE_DIR / f"{locale}.json", translated)

    print("Locale generation completed.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
