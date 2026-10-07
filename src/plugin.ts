import type { SandboxedPlugin, PluginContext } from "emdash/plugin";
import type { StorageCollection } from "emdash";
import type { Block, BlockResponse } from "@emdash-cms/blocks";

/* ------------------------------------------------------------------ */
/* Stored shapes                                                       */
/* ------------------------------------------------------------------ */

interface TotalRow {
	collection: string;
	entryId: string;
	slug: string | null;
	title: string;
	total: number;
	lastViewedAt: string;
}

interface DailyRow {
	entryKey: string;
	collection: string;
	entryId: string;
	day: string;
	count: number;
}

interface SeenRow {
	day: string;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function entryKey(collection: string, id: string): string {
	return `${collection}:${id}`;
}

async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function titleOf(data: Record<string, unknown>, fallback: string): string {
	const t = data.title ?? data.name ?? data.heading;
	return typeof t === "string" && t.trim() ? t.trim() : fallback;
}

function fmt(n: number): string {
	return new Intl.NumberFormat("en-US").format(n);
}

function stores(ctx: PluginContext) {
	return {
		totals: ctx.storage.totals as StorageCollection<TotalRow>,
		daily: ctx.storage.daily as StorageCollection<DailyRow>,
		seen: ctx.storage.seen as StorageCollection<SeenRow>,
	};
}

async function allowedCollections(ctx: PluginContext): Promise<Set<string>> {
	const raw = (await ctx.settings.get<string>("collections")) ?? "posts,pages";
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

/** Increment-or-create on a counter row. */
async function bump<T extends object>(
	col: StorageCollection<T>,
	id: string,
	field: string,
	create: () => T,
	set?: Partial<T>,
): Promise<void> {
	const res = await col.updateIf(id, {
		where: {},
		set: set as Record<string, unknown> | undefined,
		delta: { [field]: { inc: 1 } },
	} as never);
	if (res.applied) return;
	// Row did not exist yet. Create it; if another request won the race, retry the increment once.
	const made = await col.compareAndSet(id, null, create());
	if (!made.applied) {
		await col.updateIf(id, { where: {}, delta: { [field]: { inc: 1 } } } as never);
	}
}

/** Sum of daily counts for an entry over the last `days` days, including today. */
async function windowCount(ctx: PluginContext, key: string, days: number): Promise<number> {
	const { daily } = stores(ctx);
	const since = daysAgo(days - 1);
	let sum = 0;
	let cursor: string | undefined;
	do {
		const page = await daily.query({
			where: { entryKey: key, day: { gte: since } },
			limit: 100,
			cursor,
		});
		for (const row of page.items) sum += row.data.count;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return sum;
}

/** Site-wide sum of daily counts since a day. */
async function siteWindow(ctx: PluginContext, since: string): Promise<number> {
	const { daily } = stores(ctx);
	let sum = 0;
	let cursor: string | undefined;
	do {
		const page = await daily.query({ where: { day: { gte: since } }, limit: 100, cursor });
		for (const row of page.items) sum += row.data.count;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return sum;
}

async function topEntries(ctx: PluginContext, limit: number) {
	const { totals } = stores(ctx);
	const page = await totals.query({ orderBy: { total: "desc" }, limit });
	return page.items;
}

/* ------------------------------------------------------------------ */
/* Block Kit screens                                                   */
/* ------------------------------------------------------------------ */

function snippet(pluginId: string): string {
	return [
		`{/* Post Views: paste once in src/layouts/Base.astro, just before </body>. */}`,
		`{content && (`,
		`\t<script is:inline define:vars={{ pv: { c: content.collection, i: content.id, u: "/_emdash/api/plugins/${pluginId}/hit" } }}>`,
		`\t\tfetch(pv.u, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection: pv.c, id: pv.i }) }).catch(() => {});`,
		`\t</script>`,
		`)}`,
	].join("\n");
}

async function overviewPage(ctx: PluginContext): Promise<BlockResponse> {
	const { totals } = stores(ctx);
	const [tracked, todayViews, weekViews, top] = await Promise.all([
		totals.count(),
		siteWindow(ctx, today()),
		siteWindow(ctx, daysAgo(6)),
		topEntries(ctx, 50),
	]);
	const allTime = top.reduce((s, r) => s + r.data.total, 0);

	const rows = await Promise.all(
		top.map(async (r) => ({
			title: {
				type: "link",
				label: r.data.title,
				target: { kind: "content", collection: r.data.collection, id: r.data.entryId },
			},
			collection: r.data.collection,
			total: r.data.total,
			week: await windowCount(ctx, r.id, 7),
			last: r.data.lastViewedAt,
			reset: {
				type: "button",
				label: "Reset",
				action_id: "reset_entry",
				value: r.id,
				style: "secondary",
				confirm: {
					title: "Reset this entry?",
					text: `All views for "${r.data.title}" will be set to zero.`,
					confirm: "Reset",
					deny: "Cancel",
				},
			},
		})),
	);

	const blocks: Block[] = [
		{ type: "header", text: "Post Views" },
		{
			type: "stats",
			items: [
				{ label: "Today", value: fmt(todayViews) },
				{ label: "Last 7 days", value: fmt(weekViews) },
				{ label: "All time", value: fmt(allTime) },
				{ label: "Entries tracked", value: fmt(tracked) },
			],
		},
	];

	if (tracked === 0) {
		blocks.push({
			type: "banner",
			title: "No views recorded yet",
			description:
				"Add the snippet below to your theme. Views are counted as soon as a published entry is opened on the public site.",
		});
	}

	blocks.push(
		{
			type: "table",
			columns: [
				{ key: "title", label: "Entry", format: "element" },
				{ key: "collection", label: "Collection", format: "badge" },
				{ key: "total", label: "All time", format: "number" },
				{ key: "week", label: "7 days", format: "number" },
				{ key: "last", label: "Last viewed", format: "relative_time" },
				{ key: "reset", label: "", format: "element" },
			],
			rows,
			page_action_id: "browse",
			empty_text: "Nothing counted yet.",
		},
		{
			type: "actions",
			elements: [
				{ type: "button", label: "Refresh", action_id: "refresh" },
				{
					type: "button",
					label: "Reset all counts",
					action_id: "reset_all",
					style: "danger",
					confirm: {
						title: "Reset every count?",
						text: "All totals and daily history will be deleted. This cannot be undone.",
						confirm: "Reset everything",
						deny: "Cancel",
						style: "danger",
					},
				},
			],
		},
		{ type: "divider" },
		{ type: "header", text: "Theme snippet" },
		{
			type: "context",
			text: "The plugin cannot change your public pages. Paste this once into your base layout so every content page reports a view. No cookies are set and nothing personal is stored.",
		},
		{ type: "code", language: "tsx", code: snippet(ctx.plugin.id) },
		{
			type: "context",
			text: `Themes can also read counts: GET /_emdash/api/plugins/${ctx.plugin.id}/count?collection=posts&id=<entry id>, and the most-read list at /_emdash/api/plugins/${ctx.plugin.id}/top.`,
		},
	);

	return { blocks };
}

async function popularWidget(ctx: PluginContext): Promise<BlockResponse> {
	const top = await topEntries(ctx, 5);
	if (top.length === 0) {
		return {
			blocks: [
				{
					type: "empty",
					title: "No views yet",
					description: "Add the theme snippet from the Post Views page.",
					size: "sm",
					actions: [
						{
							type: "link",
							label: "Open Post Views",
							target: { kind: "plugin-page", path: "/overview" },
							appearance: "primary",
						},
					],
				},
			],
		};
	}
	const [todayViews, weekViews] = await Promise.all([
		siteWindow(ctx, today()),
		siteWindow(ctx, daysAgo(6)),
	]);
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Today", value: fmt(todayViews) },
					{ label: "7 days", value: fmt(weekViews) },
				],
			},
			{
				type: "table",
				columns: [
					{ key: "title", label: "Most read", format: "element" },
					{ key: "total", label: "Views", format: "number" },
				],
				rows: top.map((r) => ({
					title: {
						type: "link",
						label: r.data.title,
						target: { kind: "content", collection: r.data.collection, id: r.data.entryId },
					},
					total: r.data.total,
				})),
				page_action_id: "browse",
			},
		],
	};
}

async function editorPanel(ctx: PluginContext, collection: string, id: string): Promise<BlockResponse> {
	const { totals } = stores(ctx);
	const key = entryKey(collection, id);
	const row = await totals.get(key);
	if (!row) {
		return {
			blocks: [{ type: "context", text: "No views recorded for this entry yet." }],
		};
	}
	const [t, w] = await Promise.all([windowCount(ctx, key, 1), windowCount(ctx, key, 7)]);
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Today", value: fmt(t) },
					{ label: "Last 7 days", value: fmt(w) },
					{ label: "All time", value: fmt(row.total) },
				],
			},
			{ type: "context", text: `Last viewed ${new Date(row.lastViewedAt).toUTCString()}` },
		],
	};
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

async function purge<T>(col: StorageCollection<T>, where: Record<string, unknown>): Promise<number> {
	let removed = 0;
	for (;;) {
		const page = await col.query({ where: where as never, limit: 100 });
		if (page.items.length === 0) return removed;
		removed += await col.deleteMany(page.items.map((i) => i.id));
		if (!page.hasMore) return removed;
	}
}

async function resetEntry(ctx: PluginContext, key: string): Promise<void> {
	const { totals, daily } = stores(ctx);
	await totals.delete(key);
	await purge(daily, { entryKey: key });
}

async function resetAll(ctx: PluginContext): Promise<void> {
	const { totals, daily, seen } = stores(ctx);
	await purge(totals, {});
	await purge(daily, {});
	await purge(seen, {});
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

interface HitInput {
	collection?: unknown;
	id?: unknown;
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await ctx.cron?.schedule("cleanup", { schedule: "0 3 * * *" });
		},
		"plugin:deactivate": async (_event, ctx) => {
			await ctx.cron?.cancel("cleanup").catch(() => {});
		},
		cron: async (event, ctx) => {
			if (event.name !== "cleanup") return;
			const { daily, seen } = stores(ctx);
			const keep = (await ctx.settings.get<number>("retentionDays")) ?? 90;
			const dropSeen = await purge(seen, { day: { lt: today() } });
			const dropDaily = await purge(daily, { day: { lt: daysAgo(keep) } });
			ctx.log.info("Post Views cleanup", { dropSeen, dropDaily });
		},
	},

	routes: {
		/** Public: a content page reports one view. */
		hit: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx) => {
				const input = (routeCtx.input ?? {}) as HitInput;
				const collection = typeof input.collection === "string" ? input.collection : "";
				const id = typeof input.id === "string" ? input.id : "";
				if (!ID_RE.test(collection) || !ID_RE.test(id)) return { ok: false, error: "INVALID_INPUT" };

				const allowed = await allowedCollections(ctx);
				if (!allowed.has(collection)) return { ok: false, error: "COLLECTION_NOT_COUNTED" };

				const entry = await ctx.content!.get(collection, id);
				if (!entry || entry.status !== "published") return { ok: false, error: "NOT_PUBLISHED" };

				const day = today();
				const key = entryKey(collection, id);
				const unique = (await ctx.settings.get<boolean>("uniquePerDay")) ?? true;

				if (unique) {
					const meta = (routeCtx.requestMeta ?? {}) as { ip?: string | null; userAgent?: string | null };
					const fingerprint = await sha256Hex(`${meta.ip ?? "noip"}|${meta.userAgent ?? "noua"}|${key}|${day}`);
					const { seen } = stores(ctx);
					const first = await seen.compareAndSet(fingerprint, null, { day });
					if (!first.applied) return { ok: true, counted: false };
				}

				const now = new Date().toISOString();
				const title = titleOf(entry.data, entry.slug ?? id);
				const { totals, daily } = stores(ctx);
				await bump<TotalRow>(
					totals,
					key,
					"total",
					() => ({ collection, entryId: id, slug: entry.slug, title, total: 1, lastViewedAt: now }),
					{ title, slug: entry.slug, lastViewedAt: now },
				);
				await bump<DailyRow>(daily, `${key}:${day}`, "count", () => ({
					entryKey: key,
					collection,
					entryId: id,
					day,
					count: 1,
				}));
				return { ok: true, counted: true };
			},
		},

		/** Public: read one entry's count, for themes. */
		count: {
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "public, max-age=60",
			handler: async (routeCtx, ctx) => {
				const q = (routeCtx.input ?? {}) as Record<string, unknown>;
				const collection = typeof q.collection === "string" ? q.collection : "";
				const id = typeof q.id === "string" ? q.id : "";
				if (!ID_RE.test(collection) || !ID_RE.test(id)) return { ok: false, error: "INVALID_INPUT" };
				const row = await stores(ctx).totals.get(entryKey(collection, id));
				return { ok: true, total: row?.total ?? 0 };
			},
		},

		/** Public: most-read entries, for "Trending" sections. */
		top: {
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "public, max-age=300",
			handler: async (routeCtx, ctx) => {
				const q = (routeCtx.input ?? {}) as Record<string, unknown>;
				const n = Math.min(20, Math.max(1, Number(q.limit) || 10));
				const wantCollection = typeof q.collection === "string" ? q.collection : null;
				const rows = await topEntries(ctx, wantCollection ? 100 : n);
				const items = rows
					.filter((r) => !wantCollection || r.data.collection === wantCollection)
					.slice(0, n)
					.map((r) => ({
						collection: r.data.collection,
						id: r.data.entryId,
						slug: r.data.slug,
						title: r.data.title,
						total: r.data.total,
					}));
				return { ok: true, items };
			},
		},

		/** Admin page and dashboard widget. */
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const i = (routeCtx.input ?? {}) as { type?: string; action_id?: string; value?: unknown; page?: string };
				const surface = routeCtx.ui?.surface;

				if (i.type === "block_action") {
					if (i.action_id === "reset_all") {
						await resetAll(ctx);
						return { ...(await overviewPage(ctx)), toast: { type: "success", message: "All counts reset" } };
					}
					if (i.action_id === "reset_entry" && typeof i.value === "string") {
						await resetEntry(ctx, i.value);
						return { ...(await overviewPage(ctx)), toast: { type: "success", message: "Entry reset" } };
					}
				}

				if (surface === "dashboard-widget" || i.page === "popular") return popularWidget(ctx);
				return overviewPage(ctx);
			},
		},

		/** Saved-entry panel in the editor. */
		"editor/views": {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { blocks: [] };
				return editorPanel(ctx, entry.collection, entry.id);
			},
		},
	},
};

export default plugin;
