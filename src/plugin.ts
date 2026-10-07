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
/* Ranges                                                              */
/* ------------------------------------------------------------------ */

/** `days: 0` means all time. */
const RANGES = [
	{ days: 1, label: "Today" },
	{ days: 7, label: "Last 7 days" },
	{ days: 30, label: "Last 30 days" },
	{ days: 90, label: "Last 90 days" },
	{ days: 365, label: "Last 12 months" },
	{ days: 0, label: "All time" },
] as const;

const DEFAULT_RANGE = 7;
const RANGE_KEY = "ui:rangeDays";

function rangeLabel(days: number): string {
	return RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`;
}

async function currentRange(ctx: PluginContext): Promise<number> {
	const saved = await ctx.kv.get<number>(RANGE_KEY);
	return typeof saved === "number" && RANGES.some((r) => r.days === saved) ? saved : DEFAULT_RANGE;
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

/** Walk every daily row since `since` (inclusive), optionally for one entry. */
async function eachDaily(
	ctx: PluginContext,
	since: string,
	key: string | null,
	visit: (row: DailyRow) => void,
): Promise<void> {
	const { daily } = stores(ctx);
	let cursor: string | undefined;
	do {
		const page = await daily.query({
			where: key ? { entryKey: key, day: { gte: since } } : { day: { gte: since } },
			limit: 100,
			cursor,
		});
		for (const row of page.items) visit(row.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
}

/** Views for one entry over the last `days` days (0 = all time, read from totals). */
async function entryCount(ctx: PluginContext, key: string, days: number, total: number): Promise<number> {
	if (days === 0) return total;
	let sum = 0;
	await eachDaily(ctx, daysAgo(days - 1), key, (r) => (sum += r.count));
	return sum;
}

/** Site-wide views over the last `days` days. */
async function siteCount(ctx: PluginContext, days: number): Promise<number> {
	let sum = 0;
	await eachDaily(ctx, daysAgo(days - 1), null, (r) => (sum += r.count));
	return sum;
}

/** Site-wide views per day for the last `days` days, zero-filled, as chart points. */
async function siteSeries(ctx: PluginContext, days: number): Promise<[number, number][]> {
	const byDay = new Map<string, number>();
	for (let i = days - 1; i >= 0; i--) byDay.set(daysAgo(i), 0);
	await eachDaily(ctx, daysAgo(days - 1), null, (r) => byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count));
	return [...byDay.entries()].map(([day, n]) => [Date.parse(`${day}T00:00:00Z`), n]);
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
	const days = await currentRange(ctx);
	const label = rangeLabel(days);
	const retention = (await ctx.settings.get<number>("retentionDays")) ?? 90;
	// Daily history only exists for `retention` days, so a longer range is charted over what we keep.
	const chartDays = Math.min(days === 0 ? retention : days, retention);

	const [tracked, todayViews, rangeViews, top, series] = await Promise.all([
		totals.count(),
		siteCount(ctx, 1),
		days === 0 ? null : siteCount(ctx, days),
		topEntries(ctx, 50),
		chartDays > 1 ? siteSeries(ctx, chartDays) : null,
	]);
	const allTime = top.reduce((s, r) => s + r.data.total, 0);

	const rows = await Promise.all(
		top.map(async (r) => ({
			title: r.data.title,
			collection: r.data.collection,
			range: await entryCount(ctx, r.id, days, r.data.total),
			total: r.data.total,
			last: r.data.lastViewedAt,
			open: {
				type: "link",
				label: "Open",
				target: { kind: "content", collection: r.data.collection, id: r.data.entryId },
			},
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
			type: "section",
			text: `Showing ${label.toLowerCase()}.`,
			accessory: {
				type: "menu",
				action_id: "set_range",
				label: label,
				items: RANGES.map((r) => ({ label: r.label, value: String(r.days) })),
			},
		},
		{
			type: "stats",
			items: [
				{ label: "Today", value: fmt(todayViews) },
				...(days === 0 || days === 1 ? [] : [{ label, value: fmt(rangeViews ?? 0) }]),
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

	if (series) {
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				series: [{ name: "Views", data: series }],
				style: "bar",
				y_axis_name: "Views",
				height: 240,
			},
		});
		if (days === 0 || days > retention) {
			blocks.push({
				type: "context",
				text: `Chart shows the last ${retention} days, the daily history kept by the retention setting.`,
			});
		}
	}

	blocks.push(
		{
			type: "table",
			columns: [
				{ key: "title", label: "Entry" },
				{ key: "collection", label: "Collection", format: "badge" },
				{ key: "range", label, format: "number" },
				{ key: "total", label: "All time", format: "number" },
				{ key: "last", label: "Last viewed", format: "relative_time" },
				{ key: "open", label: "", format: "element" },
				{ key: "reset", label: "", format: "element" },
			],
			rows,
			page_action_id: "browse",
			empty_text: "Nothing counted yet.",
		},
		{
			type: "actions",
			elements: [
				{ type: "button", label: "Refresh", action_id: "refresh", style: "secondary" },
				{
					type: "button",
					label: "Reset all counts",
					action_id: "reset_all",
					style: "secondary",
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
	const widgetDays = Number((await ctx.settings.get<string>("widgetRange")) ?? "7") || 7;
	const [todayViews, rangeViews] = await Promise.all([siteCount(ctx, 1), siteCount(ctx, widgetDays)]);
	const allTime = top.reduce((s, r) => s + r.data.total, 0);

	const blocks: Block[] = [
		{
			type: "stats",
			items: [
				{ label: "Today", value: fmt(todayViews) },
				{ label: rangeLabel(widgetDays), value: fmt(rangeViews) },
				{ label: "All time", value: fmt(allTime) },
			],
		},
		{ type: "context", text: "Most read" },
	];
	for (const r of top) {
		blocks.push({
			type: "section",
			text: `${r.data.title}  ·  ${r.data.collection}`,
			accessory: {
				type: "link",
				label: `${fmt(r.data.total)} ${r.data.total === 1 ? "view" : "views"}`,
				target: { kind: "content", collection: r.data.collection, id: r.data.entryId },
			},
		});
	}
	blocks.push({
		type: "section",
		text: "",
		accessory: {
			type: "link",
			label: "All entries",
			target: { kind: "plugin-page", path: "/overview" },
			appearance: "secondary",
		},
	});
	return { blocks };
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
	const [d1, d7, d30] = await Promise.all([
		entryCount(ctx, key, 1, row.total),
		entryCount(ctx, key, 7, row.total),
		entryCount(ctx, key, 30, row.total),
	]);
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Today", value: fmt(d1) },
					{ label: "7 days", value: fmt(d7) },
					{ label: "30 days", value: fmt(d30) },
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
					if (i.action_id === "set_range") {
						const days = Number(i.value);
						if (RANGES.some((r) => r.days === days)) await ctx.kv.set(RANGE_KEY, days);
						return overviewPage(ctx);
					}
					if (i.action_id === "reset_all") {
						await resetAll(ctx);
						return { ...(await overviewPage(ctx)), toast: { type: "success", message: "All counts reset" } };
					}
					if (i.action_id === "reset_entry" && typeof i.value === "string") {
						await resetEntry(ctx, i.value);
						return { ...(await overviewPage(ctx)), toast: { type: "success", message: "Entry reset" } };
					}
				}

				if (surface === "dashboard-widget" || i.page === "widget:popular") return popularWidget(ctx);
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
