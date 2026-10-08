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

interface SiteDayRow {
	day: string;
	count: number;
}

interface SourceRow {
	source: string; // referring site, e.g. "google.com", or "Direct"
	day: string;
	count: number;
}

/* ------------------------------------------------------------------ */
/* Ranges and settings                                                 */
/* ------------------------------------------------------------------ */

/** `days: 0` means all time. */
const RANGES = [
	{ days: 1, label: "Today" },
	{ days: 7, label: "Last 7 days" },
	{ days: 30, label: "Last 30 days" },
	{ days: 90, label: "Last 3 months" },
	{ days: 180, label: "Last 6 months" },
	{ days: 365, label: "Last 12 months" },
	{ days: 0, label: "All time" },
] as const;

function rangesFor(retentionDays: number) {
	return RANGES.filter((r) => r.days <= retentionDays);
}

const DEFAULT_RANGE = 7;
const RANGE_KEY = "ui:rangeDays";

function rangeLabel(days: number): string {
	return RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`;
}

async function currentRange(ctx: PluginContext, retentionDays: number): Promise<number> {
	const saved = await ctx.kv.get<number>(RANGE_KEY);
	return typeof saved === "number" && rangesFor(retentionDays).some((r) => r.days === saved) ? saved : DEFAULT_RANGE;
}

/** Day-by-day rows are kept for one year. All-time totals are kept forever. */
const RETENTION_DAYS = 365;

interface Settings {
	uniquePerDay: boolean;
}

/** Settings with defaults applied. Values come from the host's settings form. */
async function loadSettings(ctx: PluginContext): Promise<Settings> {
	const unique = await ctx.settings.get<boolean>("uniquePerDay");
	return { uniquePerDay: typeof unique === "boolean" ? unique : true };
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

function views(n: number): string {
	return `${fmt(n)} ${n === 1 ? "view" : "views"}`;
}

function stores(ctx: PluginContext) {
	return {
		totals: ctx.storage.totals as StorageCollection<TotalRow>,
		daily: ctx.storage.daily as StorageCollection<DailyRow>,
		seen: ctx.storage.seen as StorageCollection<SeenRow>,
		sources: ctx.storage.sources as StorageCollection<SourceRow>,
		siteDaily: ctx.storage.sitedaily as StorageCollection<SiteDayRow>,
	};
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

const BACKFILL_KEY = "state:siteDailyBuilt";

/**
 * Sites upgraded from 0.1.x have per-entry daily rows but no site-wide rows.
 * Build them once from what exists, then remember that it is done.
 */
async function ensureSiteDaily(ctx: PluginContext): Promise<void> {
	if (await ctx.kv.get<boolean>(BACKFILL_KEY)) return;
	const byDay = new Map<string, number>();
	await eachDaily(ctx, daysAgo(RETENTION_DAYS - 1), null, (r) => byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count));
	const { siteDaily } = stores(ctx);
	const items = [...byDay.entries()].map(([day, count]) => ({ id: day, data: { day, count } }));
	for (let i = 0; i < items.length; i += 100) await siteDaily.putMany(items.slice(i, i + 100));
	await ctx.kv.set(BACKFILL_KEY, true);
}

/** Walk the site-wide one-row-per-day table between two days, inclusive. */
async function eachSiteDay(ctx: PluginContext, since: string, until: string, visit: (row: SiteDayRow) => void): Promise<void> {
	const { siteDaily } = stores(ctx);
	let cursor: string | undefined;
	do {
		const page = await siteDaily.query({ where: { day: { gte: since, lte: until } }, limit: 100, cursor });
		for (const row of page.items) visit(row.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
}

/** Site-wide views over the last `days` days. */
async function siteCount(ctx: PluginContext, days: number): Promise<number> {
	let sum = 0;
	await eachSiteDay(ctx, daysAgo(days - 1), today(), (r) => (sum += r.count));
	return sum;
}

/** Site-wide views per day for the last `days` days, zero-filled, as chart points. */
async function siteSeries(ctx: PluginContext, days: number): Promise<[number, number][]> {
	const byDay = new Map<string, number>();
	for (let i = days - 1; i >= 0; i--) byDay.set(daysAgo(i), 0);
	await eachSiteDay(ctx, daysAgo(days - 1), today(), (r) => byDay.set(r.day, r.count));
	return [...byDay.entries()].map(([day, n]) => [Date.parse(`${day}T00:00:00Z`), n]);
}

/** Site-wide views between two day offsets, inclusive: fromDaysAgo >= toDaysAgo. */
async function siteWindow(ctx: PluginContext, fromDaysAgo: number, toDaysAgo: number): Promise<number> {
	let sum = 0;
	await eachSiteDay(ctx, daysAgo(fromDaysAgo), daysAgo(toDaysAgo), (r) => (sum += r.count));
	return sum;
}

/** Plain-words name for the period before the chosen one. */
function beforeLabel(days: number): string {
	if (days === 7) return "Last week";
	if (days === 30) return "Last month";
	if (days === 90) return "3 months earlier";
	if (days === 180) return "6 months earlier";
	if (days === 365) return "Last year";
	return `${days} days earlier`;
}

/** A fair comparison gets an arrow and the earlier number. Every card always has a line, so the cards line up. */
function trendOf(current: number, previous: number, vs: string): { trend?: "up" | "down" | "neutral"; description: string } {
	if (previous === 0) return { description: "No earlier data yet" };
	const description = `${vs}: ${fmt(previous)}`;
	if (current === previous) return { trend: "neutral", description };
	return { trend: current > previous ? "up" : "down", description };
}

/** Today's card. A part of a day against a whole day is not a fair comparison, so no arrow, just yesterday's number. */
async function todayCard(ctx: PluginContext) {
	const [t, y] = await Promise.all([siteCount(ctx, 1), siteWindow(ctx, 1, 1)]);
	return { label: "Today", value: fmt(t), description: `Yesterday: ${fmt(y)}` };
}

/** A period card with its arrow against the period before it. */
async function periodCard(ctx: PluginContext, days: number, label: string) {
	const [cur, prev] = await Promise.all([siteCount(ctx, days), siteWindow(ctx, days * 2 - 1, days)]);
	return { label, value: fmt(cur), ...trendOf(cur, prev, beforeLabel(days)) };
}

/** The all-time card says since when it has been counting. */
async function allTimeCard(ctx: PluginContext, allTime: number) {
	const first = (await stores(ctx).siteDaily.query({ orderBy: { day: "asc" }, limit: 1 })).items[0]?.data.day;
	const since = first
		? new Date(`${first}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
		: "today";
	return { label: "All time", value: fmt(allTime), description: `Since ${since}` };
}

/** Referring site for a hit: host only, "Direct" when absent or from this site. */
function sourceOf(referer: string | null | undefined, siteUrl: string): string {
	if (!referer) return "Direct";
	const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
	try {
		const host = strip(new URL(referer).hostname);
		let own = "";
		try {
			own = strip(new URL(siteUrl).hostname);
		} catch {
			own = "";
		}
		if (!host || host === own || host === "localhost" || host === "127.0.0.1") return "Direct";
		return host.slice(0, 120);
	} catch {
		return "Direct";
	}
}

/** Views by source over the last `days` days (0 = all kept history). */
async function topSources(ctx: PluginContext, days: number, retention: number) {
	const { sources } = stores(ctx);
	const since = daysAgo((days === 0 ? retention : Math.min(days, retention)) - 1);
	const byHost = new Map<string, number>();
	let cursor: string | undefined;
	do {
		const page = await sources.query({ where: { day: { gte: since } }, limit: 100, cursor });
		for (const row of page.items) byHost.set(row.data.source, (byHost.get(row.data.source) ?? 0) + row.data.count);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	const total = [...byHost.values()].reduce((a, b) => a + b, 0);
	return {
		total,
		items: [...byHost.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([source, n]) => ({ source, views: n, share: total ? `${Math.round((n / total) * 100)}%` : "0%" })),
	};
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
		`\t<script`,
		`\t\tis:inline`,
		`\t\tdefine:vars={{`,
		`\t\t\tpv: {`,
		`\t\t\t\tc: content.collection,`,
		`\t\t\t\ti: content.id,`,
		`\t\t\t\tu: "/_emdash/api/plugins/${pluginId}/hit",`,
		`\t\t\t},`,
		`\t\t}}`,
		`\t>`,
		`\t\tfetch(pv.u, {`,
		`\t\t\tmethod: "POST",`,
		`\t\t\tkeepalive: true,`,
		`\t\t\theaders: { "Content-Type": "application/json" },`,
		`\t\t\tbody: JSON.stringify({ collection: pv.c, id: pv.i }),`,
		`\t\t}).catch(() => {});`,
		`\t</script>`,
		`)}`,
	].join("\n");
}

async function overviewPage(ctx: PluginContext): Promise<BlockResponse> {
	await ensureSiteDaily(ctx);
	const { totals } = stores(ctx);
	const retention = RETENTION_DAYS;
	const days = await currentRange(ctx, retention);
	const label = rangeLabel(days);
	const chartDays = Math.min(days === 0 ? retention : days, retention);

	const [tracked, today_, rangeCard, top, series, sources] = await Promise.all([
		totals.count(),
		todayCard(ctx),
		days === 0 || days === 1 ? null : periodCard(ctx, days, label),
		topEntries(ctx, 50),
		chartDays > 1 ? siteSeries(ctx, chartDays) : null,
		topSources(ctx, days, retention),
	]);
	const allTime = top.reduce((s, r) => s + r.data.total, 0);

	const rows = await Promise.all(
		top.map(async (r) => ({
			title: r.data.title,
			range: await entryCount(ctx, r.id, days, r.data.total),
			total: r.data.total,
			last: r.data.lastViewedAt,
			open: {
				type: "link",
				label: "Open",
				target: { kind: "content", collection: r.data.collection, id: r.data.entryId },
			},
		})),
	);

	const setup: Block[] = [
		{
			type: "context",
			text: "Paste this once into your theme's base layout, just before </body>. After that, every post and page reports its views here.",
		},
		{ type: "code", language: "tsx", code: snippet(ctx.plugin.id) },
	];

	const blocks: Block[] = [{ type: "header", text: "Post Views" }];

	if (tracked === 0) {
		blocks.push(
			{
				type: "banner",
				title: "One step to finish setup",
				description: "Views start counting as soon as the snippet below is in your theme.",
			},
			...setup,
		);
		return { blocks };
	}

	blocks.push(
		{
			type: "section",
			text: `Views, ${label.toLowerCase()}.`,
			accessory: {
				type: "menu",
				action_id: "set_range",
				label,
				items: rangesFor(retention).map((r) => ({ label: r.label, value: String(r.days) })),
			},
		},
		{
			type: "stats",
			items: [today_, ...(rangeCard ? [rangeCard] : []), await allTimeCard(ctx, allTime)],
		},
	);

	if (series) {
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				series: [{ name: "Views", data: series }],
				style: "bar",
				y_axis_name: "Views",
				height: 220,
			},
		});
		if (days === 0) {
			blocks.push({
				type: "context",
				text: "All-time totals are exact. The chart and the sources cover the last 12 months.",
			});
		}
	}

	blocks.push(
		{
			type: "table",
			columns: [
				{ key: "title", label: "Entry" },
				{ key: "range", label: days === 0 ? "Views" : label, format: "number" },
				{ key: "total", label: "All time", format: "number" },
				{ key: "last", label: "Last viewed", format: "relative_time" },
				{ key: "open", label: "", format: "element" },
			],
			rows,
			page_action_id: "browse",
			empty_text: "Nothing counted yet.",
		},
		{ type: "header", text: "Where readers came from" },
		{
			type: "table",
			columns: [
				{ key: "source", label: "Source" },
				{ key: "views", label: "Views", format: "number" },
				{ key: "share", label: "Share" },
			],
			rows: sources.items,
			page_action_id: "browse_sources",
			empty_text: "No sources recorded yet.",
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					label: "Reset all counts",
					action_id: "reset_all",
					style: "secondary",
					confirm: {
						title: "Reset every count?",
						text: "All views will be set to zero. This cannot be undone.",
						confirm: "Reset",
						deny: "Cancel",
						style: "danger",
					},
				},
			],
		},
		{ type: "accordion", label: "Setup", default_open: false, blocks: setup },
	);

	return { blocks };
}

async function popularWidget(ctx: PluginContext): Promise<BlockResponse> {
	await ensureSiteDaily(ctx);
	const top = await topEntries(ctx, 3);
	if (top.length === 0) {
		return {
			blocks: [
				{
					type: "empty",
					title: "No views yet",
					description: "Finish setup on the Post Views page.",
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
	const [t, w, all] = await Promise.all([todayCard(ctx), periodCard(ctx, 7, "Last 7 days"), topEntries(ctx, 100)]);
	const allTime = all.reduce((s, r) => s + r.data.total, 0);
	const blocks: Block[] = [
		{ type: "stats", items: [t, w, await allTimeCard(ctx, allTime)] },
		{ type: "context", text: "Most read" },
	];
	for (const r of top) {
		blocks.push({
			type: "section",
			text: r.data.title,
			accessory: {
				type: "link",
				label: views(r.data.total),
				target: { kind: "content", collection: r.data.collection, id: r.data.entryId },
			},
		});
	}
	blocks.push({
		type: "section",
		text: "",
		accessory: {
			type: "link",
			label: "See all",
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
				type: "fields",
				fields: [
					{ label: "Today", value: fmt(d1) },
					{ label: "Last 7 days", value: fmt(d7) },
					{ label: "Last 30 days", value: fmt(d30) },
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

async function resetAll(ctx: PluginContext): Promise<void> {
	const { totals, daily, seen, sources, siteDaily } = stores(ctx);
	await purge(totals, {});
	await purge(daily, {});
	await purge(seen, {});
	await purge(sources, {});
	await purge(siteDaily, {});
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
			await ensureSiteDaily(ctx);
		},
		"plugin:deactivate": async (_event, ctx) => {
			await ctx.cron?.cancel("cleanup").catch(() => {});
		},
		cron: async (event, ctx) => {
			if (event.name !== "cleanup") return;
			const { daily, seen } = stores(ctx);
			const dropSeen = await purge(seen, { day: { lt: today() } });
			const dropDaily = await purge(daily, { day: { lt: daysAgo(RETENTION_DAYS) } });
			const dropSources = await purge(stores(ctx).sources, { day: { lt: daysAgo(RETENTION_DAYS) } });
			const dropSite = await purge(stores(ctx).siteDaily, { day: { lt: daysAgo(RETENTION_DAYS) } });
			ctx.log.info("Post Views cleanup", { dropSeen, dropDaily, dropSources, dropSite });
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

				// Unknown collections make the host throw; treat that the same as an unknown entry.
				const entry = await ctx.content!.get(collection, id).catch(() => null);
				if (!entry || entry.status !== "published") return { ok: false, error: "NOT_PUBLISHED" };

				const day = today();
				const key = entryKey(collection, id);
				const { uniquePerDay } = await loadSettings(ctx);

				if (uniquePerDay) {
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
				await bump<SiteDayRow>(stores(ctx).siteDaily, day, "count", () => ({ day, count: 1 }));
				const refMeta = (routeCtx.requestMeta ?? {}) as { referer?: string | null };
				const source = sourceOf(refMeta.referer, ctx.site.url);
				await bump<SourceRow>(stores(ctx).sources, `${source}:${day}`, "count", () => ({ source, day, count: 1 }));
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
						if (rangesFor(RETENTION_DAYS).some((r) => r.days === days)) await ctx.kv.set(RANGE_KEY, days);
						return overviewPage(ctx);
					}
					if (i.action_id === "reset_all") {
						await resetAll(ctx);
						return { ...(await overviewPage(ctx)), toast: { type: "success", message: "All counts reset" } };
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
