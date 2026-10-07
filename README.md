# Post Views

Privacy-first view counter for [EmDash CMS](https://emdashcms.com). See which posts and pages people actually read, right inside your admin, with no Google Analytics, no third-party account, and no cookies.

## What you get

- **Popular posts** widget on the Dashboard: today, last 7 days, and the five most-read entries.
- **Views** panel in the editor: today, last 7 days, and all-time for the entry you are editing.
- **Post Views** page: every tracked entry sorted by views, per-entry reset, reset all, and the theme snippet.
- **Two public JSON routes** for themes: a single entry's count, and the most-read list for "Trending" sections.

Each visitor is counted once per entry per day using a one-way hash of IP address and browser string. The hash is deleted every night. No cookies are set and nothing personal is stored. Only published entries are counted; drafts, previews, and unknown IDs are ignored.

## Install

1. In your EmDash admin, open **Registry**, search for **Post Views**, and click **Install**.
2. Approve the single permission: read content. The plugin needs it to confirm an entry exists and is published, and to remember its title.
3. Open **Plugins → Post Views** and copy the theme snippet.

## Add the snippet to your theme

The plugin cannot change your public pages, so one small script reports a view when a content page loads. Paste this into your base layout, for example `src/layouts/Base.astro`, just before `</body>`. It relies on the `content` prop that EmDash templates already pass to the layout on content pages.

```astro
{content && (
	<script is:inline define:vars={{ pv: { c: content.collection, i: content.id, u: "/_emdash/api/plugins/<plugin id>/hit" } }}>
		fetch(pv.u, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection: pv.c, id: pv.i }) }).catch(() => {});
	</script>
)}
```

The Post Views admin page shows this snippet with your site's real plugin ID filled in.

## Show counts on your site

Fetch a single entry's count:

```
GET /_emdash/api/plugins/<plugin id>/count?collection=posts&id=<entry id>
→ { "success": true, "data": { "ok": true, "total": 1245 } }
```

Fetch the most-read entries, optionally limited to one collection:

```
GET /_emdash/api/plugins/<plugin id>/top?limit=5&collection=posts
→ { "success": true, "data": { "ok": true, "items": [ { "collection": "posts", "id": "...", "slug": "hello-world", "title": "Hello World", "total": 1245 } ] } }
```

Both routes are public and cached for a short time, so they are safe to call from the browser or from an Astro page.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Counted collections | `posts,pages` | Comma-separated collection slugs to count. |
| Count each visitor once per day | on | Turn off to count every page load. |
| Keep daily history for (days) | 90 | Per-day rows older than this are removed nightly. All-time totals are kept forever. |

## Privacy

- No cookies, no local storage, no fingerprinting library.
- The daily visitor hash combines IP, user agent, entry, and date, and is deleted the next night.
- Nothing leaves your site. There are no outbound network requests.

## Development

```sh
pnpm install
pnpm run test       # validate manifest + run the sandbox test suite
pnpm run build      # produce dist/ for linking into a local site
pnpm run dev        # rebuild on change
```

Link into a local site with `npm install ../post-views`, then add it to `astro.config.mjs`:

```js
import postViews from "post-views";
// inside emdash({ ... })
sandboxed: [postViews],
sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
```

## License

MIT. Built by DesiDash Lab.
