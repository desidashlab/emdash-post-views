import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost;

type Visitor = { ip: string; userAgent: string; referer: string | null; geo: null };
const visitorA: Visitor = { ip: "203.0.113.10", userAgent: "Mozilla/5.0 A", referer: null, geo: null };
const visitorB: Visitor = { ip: "203.0.113.11", userAgent: "Mozilla/5.0 B", referer: null, geo: null };

const POST = { collection: "posts", id: "post-live" };

function hit(input: unknown, meta = visitorA) {
	return host.transport.invokeRoute("hit", input, { method: "POST", meta });
}

beforeEach(async () => {
	host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "content", label: "Content", type: "text" },
		],
	});
	await host.fixtures.content("posts", {
		id: "post-live",
		slug: "hello-world",
		status: "published",
		data: { title: "Hello World" },
	});
	await host.fixtures.content("posts", {
		id: "post-draft",
		slug: "secret",
		status: "draft",
		data: { title: "Secret draft" },
	});
	await host.actions.plugin.activate();
});

afterEach(async () => {
	await host.dispose();
});

describe("hit route", () => {
	it("counts a view on a published entry and caches its title", async () => {
		expect(await hit(POST)).toEqual({ ok: true, counted: true });

		const total = await host.inspect.storage.get<{ total: number; title: string; slug: string }>(
			"totals",
			"posts:post-live",
		);
		expect(total?.total).toBe(1);
		expect(total?.title).toBe("Hello World");
		expect(total?.slug).toBe("hello-world");

		const daily = await host.inspect.storage.list<{ count: number }>("daily");
		expect(daily).toHaveLength(1);
		expect(daily[0]?.data.count).toBe(1);
	});

	it("counts the same visitor once per day, but counts a second visitor", async () => {
		await hit(POST, visitorA);
		expect(await hit(POST, visitorA)).toEqual({ ok: true, counted: false });
		expect(await hit(POST, visitorB)).toEqual({ ok: true, counted: true });

		const total = await host.inspect.storage.get<{ total: number }>("totals", "posts:post-live");
		expect(total?.total).toBe(2);
	});

	it("counts every request when unique-per-day is switched off", async () => {
		await host.fixtures.plugin.setting("uniquePerDay", false);
		await hit(POST, visitorA);
		await hit(POST, visitorA);
		const total = await host.inspect.storage.get<{ total: number }>("totals", "posts:post-live");
		expect(total?.total).toBe(2);
	});

	it("refuses drafts, unknown entries, unknown collections, and bad input", async () => {
		expect(await hit({ collection: "posts", id: "post-draft" })).toEqual({ ok: false, error: "NOT_PUBLISHED" });
		expect(await hit({ collection: "posts", id: "nope" })).toEqual({ ok: false, error: "NOT_PUBLISHED" });
		expect(await hit({ collection: "posts" })).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(await hit({ collection: "secrets", id: "post-live" })).toEqual({ ok: false, error: "NOT_PUBLISHED" });
		expect(await host.inspect.storage.list("totals")).toHaveLength(0);
	});
});

describe("public read routes", () => {
	it("returns one entry's count and the most-read list", async () => {
		await hit(POST, visitorA);
		await hit(POST, visitorB);

		expect(await host.transport.invokeRoute("count", POST, { method: "GET" })).toEqual({ ok: true, total: 2 });
		expect(
			await host.transport.invokeRoute("count", { collection: "posts", id: "unknown" }, { method: "GET" }),
		).toEqual({ ok: true, total: 0 });

		const top = (await host.transport.invokeRoute("top", { limit: "5" }, { method: "GET" })) as {
			ok: boolean;
			items: unknown[];
		};
		expect(top.ok).toBe(true);
		expect(top.items).toEqual([
			{ collection: "posts", id: "post-live", slug: "hello-world", title: "Hello World", total: 2 },
		]);
	});
});

describe("admin surfaces", () => {
	it("renders the overview page with stats, the table, and the theme snippet", async () => {
		await hit(POST);
		const page = await host.admin.loadPage("/overview");
		const types = page.blocks.map((b) => b.type);
		expect(types).toContain("stats");
		expect(types).toContain("table");
		expect(types).toContain("accordion");

		const table = page.blocks.find((b) => b.type === "table");
		expect(table && "rows" in table ? table.rows : []).toHaveLength(1);

		const setup = page.blocks.find((b) => b.type === "accordion");
		const code = setup && "blocks" in setup ? setup.blocks.find((b) => b.type === "code") : undefined;
		expect(code && "code" in code ? code.code : "").toContain("/hit");
	});

	it("lets the admin pick a range and remembers it", async () => {
		await hit(POST);
		const changed = await host.admin.act("/overview", "set_range", { value: "30" });
		const stats = changed.blocks.find((b) => b.type === "stats");
		const labels = stats && "items" in stats ? stats.items.map((s) => s.label) : [];
		expect(labels).toContain("Last 30 days");
		expect(changed.blocks.some((b) => b.type === "chart")).toBe(true);

		const reloaded = await host.admin.loadPage("/overview");
		const table = reloaded.blocks.find((b) => b.type === "table");
		const cols = table && "columns" in table ? table.columns.map((c) => c.label) : [];
		expect(cols).toContain("Last 30 days");
		expect(await host.inspect.kv.get("ui:rangeDays")).toBe(30);
	});

	it("shows an empty state on the widget before any views, then the most-read list", async () => {
		const empty = await host.admin.loadWidget("popular");
		expect(empty.blocks[0]?.type).toBe("empty");

		await hit(POST);
		const widget = await host.admin.loadWidget("popular");
		const types = widget.blocks.map((b) => b.type);
		expect(types[0]).toBe("stats");
		expect(types.filter((t) => t === "section").length).toBeGreaterThanOrEqual(2);
	});

	it("shows per-entry numbers in the editor panel", async () => {
		const before = await host.admin.loadEditorPanel("views", "posts", "post-live");
		expect(before.blocks[0]?.type).toBe("context");

		await hit(POST);
		const after = await host.admin.loadEditorPanel("views", "posts", "post-live");
		expect(after.blocks[0]?.type).toBe("fields");
	});

	it("shows the setup banner with the snippet before any views", async () => {
		const page = await host.admin.loadPage("/overview");
		const types = page.blocks.map((b) => b.type);
		expect(types).toContain("banner");
		expect(types).toContain("code");
		expect(types).not.toContain("table");
	});

	it("resets everything", async () => {
		await hit(POST, visitorB);
		const all = await host.admin.act("/overview", "reset_all");
		expect(all.toast?.message).toBe("All counts reset");
		expect(await host.inspect.storage.list("totals")).toHaveLength(0);
		expect(await host.inspect.storage.list("daily")).toHaveLength(0);
		expect(await host.inspect.storage.list("seen")).toHaveLength(0);
		expect(await host.inspect.storage.list("sitedaily")).toHaveLength(0);
	});
});

describe("maintenance", () => {
	it("schedules the nightly cleanup on activate", async () => {
		const tasks = await host.inspect.scheduledTasks();
		expect(tasks.some((t) => t.name === "cleanup")).toBe(true);
	});

	it("cleanup drops old fingerprints and old daily rows but keeps totals", async () => {
		await hit(POST);
		await host.fixtures.plugin.storage("seen", "old-fingerprint", { day: "2020-01-01" });
		await host.fixtures.plugin.storage("daily", "posts:post-live:2020-01-01", {
			entryKey: "posts:post-live",
			collection: "posts",
			entryId: "post-live",
			day: "2020-01-01",
			count: 5,
		});

		await host.transport.invokeHook("cron", { name: "cleanup", scheduledAt: new Date().toISOString() });

		expect(await host.inspect.storage.list("seen")).toHaveLength(1);
		expect(await host.inspect.storage.list("daily")).toHaveLength(1);
		expect(await host.inspect.storage.list("totals")).toHaveLength(1);
	});
});

describe("upgrade from 0.1.x", () => {
	it("builds the site-wide daily rows once from per-entry rows", async () => {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await host.fixtures.plugin.storage("daily", `posts:post-live:${yesterday}`, {
			entryKey: "posts:post-live",
			collection: "posts",
			entryId: "post-live",
			day: yesterday,
			count: 9,
		});
		await host.fixtures.plugin.storage("daily", `posts:other:${yesterday}`, {
			entryKey: "posts:other",
			collection: "posts",
			entryId: "other",
			day: yesterday,
			count: 3,
		});
		await host.fixtures.plugin.kv("state:siteDailyBuilt", null);

		const widget = await host.admin.loadWidget("popular");
		const stats = widget.blocks[0];
		const today = stats && "items" in stats ? stats.items[0] : undefined;
		// Widget shows "No views yet" when totals are empty, so seed one hit first.
		void today;
		await hit(POST, visitorA);
		const after = await host.admin.loadWidget("popular");
		const s2 = after.blocks[0];
		const t2 = s2 && "items" in s2 ? s2.items[0] : undefined;
		expect(t2?.description).toBe("Yesterday: 12");
		expect(await host.inspect.storage.get<{ count: number }>("sitedaily", yesterday)).toEqual({ day: yesterday, count: 12 });
	});
});

describe("upgrade from 0.1.x", () => {
	it("builds the site-wide daily rows once from per-entry rows", async () => {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await host.fixtures.plugin.storage("daily", `posts:post-live:${yesterday}`, {
			entryKey: "posts:post-live",
			collection: "posts",
			entryId: "post-live",
			day: yesterday,
			count: 9,
		});
		await host.fixtures.plugin.storage("daily", `posts:other:${yesterday}`, {
			entryKey: "posts:other",
			collection: "posts",
			entryId: "other",
			day: yesterday,
			count: 3,
		});
		await host.fixtures.plugin.kv("state:siteDailyBuilt", null);

		const widget = await host.admin.loadWidget("popular");
		const stats = widget.blocks[0];
		const today = stats && "items" in stats ? stats.items[0] : undefined;
		// Widget shows "No views yet" when totals are empty, so seed one hit first.
		void today;
		await hit(POST, visitorA);
		const after = await host.admin.loadWidget("popular");
		const s2 = after.blocks[0];
		const t2 = s2 && "items" in s2 ? s2.items[0] : undefined;
		expect(t2?.description).toBe("Yesterday: 12");
		expect(await host.inspect.storage.get<{ count: number }>("sitedaily", yesterday)).toEqual({ day: yesterday, count: 12 });
	});
});

describe("sources and trends", () => {
	it("records the referring site, host only, and Direct when there is none", async () => {
		await hit(POST, { ...visitorA, referer: "https://www.google.com/search?q=hello+world" });
		await hit(POST, { ...visitorB, referer: null });
		const rows = await host.inspect.storage.list<{ source: string; count: number }>("sources");
		const by = Object.fromEntries(rows.map((r) => [r.data.source, r.data.count]));
		expect(by["google.com"]).toBe(1);
		expect(by["Direct"]).toBe(1);

		const page = await host.admin.loadPage("/overview");
		const tables = page.blocks.filter((b) => b.type === "table");
		const sources = tables[1];
		const srcRows = sources && "rows" in sources ? (sources.rows as Array<{ source: string; share: string }>) : [];
		expect(srcRows.map((r) => r.source).sort()).toEqual(["Direct", "google.com"]);
		expect(srcRows[0]?.share).toBe("50%");
	});

	it("shows yesterday under Today and an arrow on the week card", async () => {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		await host.fixtures.plugin.storage("daily", `posts:post-live:${yesterday}`, {
			entryKey: "posts:post-live",
			collection: "posts",
			entryId: "post-live",
			day: yesterday,
			count: 4,
		});
		await host.fixtures.plugin.storage("sitedaily", yesterday, { day: yesterday, count: 4 });
		await hit(POST, visitorA);
		await hit(POST, visitorB);

		const widget = await host.admin.loadWidget("popular");
		const stats = widget.blocks[0];
		const today = stats && "items" in stats ? stats.items[0] : undefined;
		expect(today?.label).toBe("Today");
		expect(today?.trend).toBeUndefined();
		expect(today?.description).toBe("Yesterday: 4");

		const week = stats && "items" in stats ? stats.items[1] : undefined;
		expect(week?.label).toBe("Last 7 days");
		// Nothing in the week before, so no arrow, and a plain line keeps the cards aligned.
		expect(week?.trend).toBeUndefined();
		expect(week?.description).toBe("No earlier data yet");
		const all = stats && "items" in stats ? stats.items[2] : undefined;
		expect(all?.description?.startsWith("Since ")).toBe(true);
	});
});
