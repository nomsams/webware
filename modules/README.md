# modules/

Standalone JS building blocks for functionality discussed but not yet built into the app. None
of this is imported by `index.html` — nothing here changes app behavior until a module is
deliberately wired in. Each file has a `STATUS:` header comment with its intended integration
point. Run all tests with:

```bash
node --test modules/tests/*.test.js
```

## What's here

- **`groq-client.js`** + **`../supabase/functions/groq-proxy/index.ts`** — chat with Groq-hosted
  models (model + reasoning-effort selectable, streaming supported), with the API key held
  server-side in a Supabase Edge Function's secrets rather than in the browser. Deploy the
  function and `supabase secrets set GROQ_API_KEY=...` before this does anything real. See the
  security note below on why it's an Edge Function and not a key in `index.html`.
- **`cors-proxy.js`** — pluggable CORS-proxy fetch wrapper (primary proxy, falling back to public
  proxies, falling back to a direct fetch), used by `web-search.js`. See the `chikibriki` note
  below before configuring a primary proxy.
- **`web-search.js`** — DuckDuckGo search + page-text extraction, ported from
  `github.com/nomsams/timeline` (the search) with a cleanup approach mirroring
  `github.com/nomsams/crawly` (the text extraction). Depends on `cors-proxy.js`.
- **`order-parser.js`** — the actual feature behind "a box where we can write or paste something
  like 'plocka item 1 and item 2...'": turns free text into a structured `{ items, recipient }`
  pack-order draft via `groq-client.js`, optionally using `web-search.js` to look up a recipient's
  address when the text names them but doesn't give one. This is the piece the other modules
  exist to support.
- **`img-square.js`** — pads an image to a square, filling the new space with a solid color or a
  color sampled from the image's own edges. Ported from `github.com/nomsams/imgsquare`. Intended
  to slot into the existing item-photo/manufacturer-logo canvas editor as an extra step.
- **`contacts.js`** — minimal hand-rolled vCard (`.vcf`) parse/export, same approach as
  `github.com/nomsams/contactview`. Intended for a future "saved recipients" picker on Pack
  Order — import contacts from a phone's exported `.vcf`, pick one to fill the recipient fields.
  contactview's autosave (plain `localStorage`) and "Google Calendar sync" (turned out to be a
  `calendar.google.com` deep link / `.ics` download, not a real API integration) weren't ported —
  neither is more than a few lines to add directly wherever this ends up wired in, if wanted.

## Security note: API keys in a static, client-only site

`index.html` is served as-is from GitHub Pages — anything written into it, including an API key,
is visible to anyone who views page source. That's why `groq-client.js` doesn't hold a Groq key
itself: it calls a Supabase Edge Function (`groq-proxy`) that holds `GROQ_API_KEY` as a Supabase
secret and only accepts requests from signed-in app users. The same reasoning applies to any
future proxy/key this app adds — prefer a server-side secret over a client-embedded one.

`cors-proxy.js`'s doc comment covers a related but different case: crawly and timeline (two of
the reference repos this was ported from) hardcode a fallback proxy key, `"chikibriki"`, in
cleartext in their own public source. That's already exposed on the public internet regardless of
anything done here, so there's nothing to protect by keeping it out of this repo too — but it
also isn't something to depend on, since it points at a Supabase project (`onbkfqayveownervyktu`)
that belongs to those repos, not to webware. `cors-proxy.js` ships with no primary proxy
configured by default; wire that one back in explicitly (see the module's doc comment) only if
you still control that project and want it.

## Not ported as a separate module

- **timeline's DuckDuckGo search** — already covered by `web-search.js` (that's literally where
  the search logic was ported from).
- **contactview's Google Calendar "sync"** — see above; it's a deep link / `.ics` download, not
  an API integration worth its own module.
