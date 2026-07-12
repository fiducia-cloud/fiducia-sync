# admin

Admin-plane browser bundle entry for `@fiducia/sync`.

`entry.mjs` wires the SDK to the **admin** plane (IndexedDB `fiducia-admin`, the
backend WS at `/admin/ws`, write path `/api/admin/sync/{table}`; no Supabase
realtime — the backend WS is the only transport) and exposes `window.FiduciaSyncAdmin`.

`fiducia-admin.rs` is a server-rendered Maud+htmx app with no bundler, so this
entry is esbuild-bundled (with the wasm inlined as bytes) into a single
self-contained file that the admin binary serves as a static asset. Build via
`npm run build:admin-bundle`; output lands in `dist/` (gitignored).
