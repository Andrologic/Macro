// JSON transports binary IPC arguments as arrays. Restore a typed array before
// Tauri passes the body to fetch, which otherwise stringifies it as comma-separated text.
(function (args) {
  return Array.isArray(args) ? new Uint8Array(args) : args
})
