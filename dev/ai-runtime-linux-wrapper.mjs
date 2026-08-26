import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const LINUX_RUNTIME_PAYLOAD_MARKER = '__MACRO_AI_RUNTIME_PAYLOAD__';
const LINUX_RUNTIME_PAYLOAD_END = '__MACRO_AI_RUNTIME_PAYLOAD_END__';

export const createLinuxRuntimeWrapper = (runtime) => {
  const digest = createHash('sha256').update(runtime).digest('hex');
  const payload = gzipSync(runtime, { level: 9 });
  const launcher = `#!/bin/sh
set -eu

payload_line="$(awk '/^${LINUX_RUNTIME_PAYLOAD_MARKER}$/ { print NR + 1; exit }' "$0")"
if [ -z "$payload_line" ]; then
  echo "Macro AI runtime payload is missing." >&2
  exit 1
fi

if [ -n "\${XDG_CACHE_HOME:-}" ]; then
  cache_root="$XDG_CACHE_HOME"
elif [ -n "\${HOME:-}" ]; then
  cache_root="$HOME/.cache"
else
  cache_root="/tmp"
fi

runtime_dir="$cache_root/ai.andrologic.macro"
runtime_path="$runtime_dir/macro-ai-runtime-${digest}"

if [ ! -x "$runtime_path" ]; then
  umask 077
  mkdir -p "$runtime_dir"
  temporary_path="$runtime_path.$$"
  trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
  tail -n "+$payload_line" "$0" | head -c ${payload.length} | gzip -dc > "$temporary_path"
  chmod 700 "$temporary_path"
  mv -f "$temporary_path" "$runtime_path"
  trap - EXIT HUP INT TERM
fi

exec "$runtime_path" "$@"
: <<'${LINUX_RUNTIME_PAYLOAD_END}'
${LINUX_RUNTIME_PAYLOAD_MARKER}
`;

  return {
    digest,
    wrapper: Buffer.concat([
      Buffer.from(launcher),
      payload,
      Buffer.from(`\n${LINUX_RUNTIME_PAYLOAD_END}\n`),
    ]),
  };
};
