## Install

1. Open **Registry** in your EmDash admin, search for **Post Views**, and click **Install**.
2. Approve the single permission, *read content*. The plugin uses it to confirm an entry exists and is published, and to remember its title for the most-read list.
3. Open **Post Views** in the left menu and copy the theme snippet shown at the bottom of the page.

## Add the snippet to your theme

The plugin cannot change your public pages, so one small script reports a view when a content page loads. Paste the snippet once into your base layout, for example `src/layouts/Base.astro`, just before `</body>`. It uses the `content` prop that EmDash templates already pass to the layout on content pages. No cookies are set.

## Show counts on your site (optional)

- One entry: `GET /_emdash/api/plugins/<plugin id>/count?collection=posts&id=<entry id>`
- Most read: `GET /_emdash/api/plugins/<plugin id>/top?limit=5&collection=posts`

Both routes are public and cached briefly, so they are safe to call from an Astro page or from the browser.
