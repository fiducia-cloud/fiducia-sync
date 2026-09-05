# admin

Admin-plane browser bundle entry for `@fiducia/sync`.

`entry.mjs` wires the SDK to the **admin** plane (IndexedDB `fiducia-admin`, the
backend WS at `/admin/ws`, write path `/api/admin/sync/{table}`; no Supabase
realtime — the backend WS is the only transport) and exposes `window.FiduciaSyncAdmin`.

Admin streams should authenticate with an HttpOnly session cookie
(`streamAuth: "cookie"`). Bearer tokens remain in HTTP write headers; the
compatibility-only `"query-token"` stream mode must be explicitly selected.
Cookie-authenticated writes pass `csrfToken` through to the
`x-fiducia-csrf` header; the admin page supplies the credential-bound token
rendered in its same-origin meta tag.

`fiducia-admin.rs` is a server-rendered Maud+htmx app with no bundler, so this
entry is esbuild-bundled (with the wasm inlined as bytes) into a single
self-contained file that the admin binary serves as a static asset. Build via
`npm run build:admin-bundle`; output lands in `dist/` (gitignored).
