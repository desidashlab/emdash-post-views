# Post Views

Privacy-first view counter for [EmDash CMS](https://emdashcms.com). See which posts and pages people actually read, right inside your admin, with no Google Analytics, no third-party account, and no cookies.

## What you get

- **Dashboard**: today, last 7 days, all time, and your three most-read entries.
- **Post Views page**: pick a period, see the chart, the full list, and where readers came from.
- **In the editor**: that entry's views today, this week, this month, and all time.

Each visitor is counted once per page per day. No cookies, no Google, nothing leaves your site.

## Install

1. In your EmDash admin open **Registry**, search for **Post Views**, and click **Install**.
2. Open **Post Views** in the left menu and copy the snippet.
3. Paste it into your theme once, just before `</body>` in the base layout. The Post Views page shows the snippet with your site's plugin ID already filled in.

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

Open **Plugins**, then **Settings** next to Post Views.

| Setting | Default |
|---|---|
| Count each visitor once per day | on |
| Chart and periods go back | 3 months. All-time totals are always kept. |

## Privacy

- No cookies, no local storage, no fingerprinting library.
- The daily visitor hash combines IP, user agent, entry, and date, and is deleted the next night.
- Referring sites are stored as a site name only, such as google.com, never the full address.
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
