import { expect, test } from "bun:test";
import {
	FLEET_USAGE,
	fleetCompletionSummary,
	fleetArgumentCompletions,
	parseFleetArguments,
	parseFleetCommand,
	presentFleetApproval,
} from "../extensions/omp-fleet.ts";

interface ApprovalCall {
	repo: string;
	requestId: string;
	version: number;
	value?: string;
}

function approvalHarness(confirmResult = true) {
	const approved: ApprovalCall[] = [];
	const denied: Array<Omit<ApprovalCall, "value">> = [];
	const confirms: Array<[string, string]> = [];
	const selects: Array<[string, string[]]> = [];
	const inputs: Array<[string, string | undefined]> = [];
	const editors: Array<[string, string | undefined]> = [];
	const run = {
		async approve(repo: string, requestId: string, version: number, value?: string) {
			approved.push({ repo, requestId, version, ...(value === undefined ? {} : { value }) });
		},
		async deny(repo: string, requestId: string, version: number) {
			denied.push({ repo, requestId, version });
		},
	} as Parameters<typeof presentFleetApproval>[0];
	const ctx = {
		ui: {
			async confirm(title: string, message: string) {
				confirms.push([title, message]);
				return confirmResult;
			},
			async select(title: string, options: string[]) {
				selects.push([title, options]);
				return options[1];
			},
			async input(title: string, placeholder?: string) {
				inputs.push([title, placeholder]);
				return "typed value";
			},
			async editor(title: string, prefill?: string) {
				editors.push([title, prefill]);
				return "edited value";
			},
		},
	} as unknown as Parameters<typeof presentFleetApproval>[2];
	return { run, ctx, approved, denied, confirms, selects, inputs, editors };
}

test("parses quoted fleet arguments without treating backslashes as shell escapes", () => {
	expect(parseFleetArguments('send run-1 "api repo" "ship C:\\\\work"')).toEqual([
		"send",
		"run-1",
		"api repo",
		"ship C:\\work",
	]);
});

test("suggests Fleet subcommands, run ids, repositories, approvals, and window modes", () => {
	const runs = [
		{
			runId: "run-123",
			repos: ["omp", "infra"],
			pendingByRepo: { infra: ["request-7"] },
		},
	];
	expect(fleetArgumentCompletions("sta", runs)).toEqual([
		{
			value: "status ",
			label: "status [run-id]",
			description: "Show live fleet status",
			hint: "[run-id]",
		},
	]);
	expect(fleetArgumentCompletions("status run-", runs)?.map(item => item.value)).toEqual(["status run-123"]);
	expect(fleetArgumentCompletions("cancel run-123 ", runs)?.map(item => item.value)).toEqual([
		"cancel run-123 omp",
		"cancel run-123 infra",
		"cancel run-123 all",
	]);
	expect(fleetArgumentCompletions("approve run-123 infra ", runs)?.map(item => item.value)).toEqual([
		"approve run-123 infra request-7",
	]);
	expect(fleetArgumentCompletions("run fleet.json --window=d", runs)?.map(item => item.value)).toEqual([
		"run fleet.json --window=dashboard",
	]);
	expect(fleetArgumentCompletions("run ", runs)).toBeNull();
});

test("requires and routes explicit run ids for every mutating fleet command", () => {
	expect(parseFleetCommand('send run-a api "change course"')).toEqual({
		subcommand: "send",
		runId: "run-a",
		repo: "api",
		message: "change course",
	});
	expect(parseFleetCommand("follow-up run-b web summarize later")).toEqual({
		subcommand: "follow-up",
		runId: "run-b",
		repo: "web",
		message: "summarize later",
	});
	expect(parseFleetCommand("approve run-a api request-1")).toEqual({
		subcommand: "approve",
		runId: "run-a",
		repo: "api",
		requestId: "request-1",
	});
	expect(parseFleetCommand("deny run-b web request-2")).toEqual({
		subcommand: "deny",
		runId: "run-b",
		repo: "web",
		requestId: "request-2",
	});
	expect(parseFleetCommand("cancel run-a all")).toEqual({ subcommand: "cancel", runId: "run-a", target: "all" });

	for (const legacy of ["send api message", "follow-up api message", "approve api request-1", "deny api request-1", "cancel api"]) {
		expect(() => parseFleetCommand(legacy)).toThrow("Usage:");
	}
	expect(FLEET_USAGE).toContain("/fleet cancel <run-id> <repo|all>");
});

test("keeps successful completion compact and reports only actionable worker failures", () => {
	const complete = fleetCompletionSummary({
		runId: "run-complete",
		name: "publish",
		workers: [
			{ repo: "omp", state: "succeeded" },
			{ repo: "infra", state: "succeeded" },
		],
	} as Parameters<typeof fleetCompletionSummary>[0]);
	expect(complete).toEqual({
		clean: true,
		message: "Fleet publish: 2/2 repositories succeeded.",
		lines: [
			"Fleet publish: 2/2 repositories succeeded.",
			"Run: run-complete",
			"SUCCEEDED omp",
			"SUCCEEDED infra",
		],
	});

	const failed = fleetCompletionSummary({
		runId: "run-failed",
		name: "publish",
		workers: [
			{ repo: "omp", state: "succeeded", result: { text: "long assistant report that must stay hidden" } },
			{ repo: "infra", state: "failed", error: "push rejected" },
		],
	} as Parameters<typeof fleetCompletionSummary>[0]);
	expect(failed.clean).toBe(false);
	expect(failed.message).toBe("Fleet publish: 1 succeeded, 1 failed, 0 aborted, 0 active.");
	expect(failed.lines).toEqual([
		"Fleet publish: 1 succeeded, 1 failed, 0 aborted, 0 active.",
		"Run: run-failed",
		"SUCCEEDED omp",
		"FAILED infra: push rejected",
	]);
	expect(failed.lines.join("\n")).not.toContain("long assistant report");
	expect(parseFleetCommand("clear")).toEqual({ subcommand: "clear" });
	expect(() => parseFleetCommand("clear now")).toThrow("Usage:");
	expect(FLEET_USAGE).toContain("/fleet clear");
});

test("shows the live sanitized confirmation details before approving", async () => {
	const harness = approvalHarness(true);
	const approved = await presentFleetApproval(
		harness.run,
		{
			repo: "api",
			id: "confirm-1",
			version: 1,
			method: "confirm",
			title: " Deploy\u0000 production ",
			message: " Proceed?\nNow ",
		},
		harness.ctx,
	);

	expect(approved).toBe(true);
	expect(harness.confirms).toEqual([["Deploy production", "Proceed? Now"]]);
	expect(harness.approved).toEqual([{ repo: "api", requestId: "confirm-1", version: 1 }]);
	expect(harness.denied).toEqual([]);
});

test("a rejected host confirmation sends an explicit denial", async () => {
	const harness = approvalHarness(false);
	const approved = await presentFleetApproval(
		harness.run,
		{ repo: "web", id: "confirm-2", version: 2, method: "confirm", title: "Publish", message: "Release now?" },
		harness.ctx,
	);

	expect(approved).toBe(false);
	expect(harness.confirms).toEqual([["Publish", "Release now?"]]);
	expect(harness.approved).toEqual([]);
	expect(harness.denied).toEqual([{ repo: "web", requestId: "confirm-2", version: 2 }]);
});

test("select, input, and editor approvals expose their live request details through host UI", async () => {
	const harness = approvalHarness();
	await presentFleetApproval(
		harness.run,
		{ repo: "api", id: "select-1", version: 3, method: "select", title: "Target", message: "Choose branch", options: ["main", "next"] },
		harness.ctx,
	);
	await presentFleetApproval(
		harness.run,
		{ repo: "api", id: "input-1", version: 4, method: "input", title: "Version", message: "Enter tag", placeholder: "v1.2.3" },
		harness.ctx,
	);
	await presentFleetApproval(
		harness.run,
		{ repo: "api", id: "editor-1", version: 5, method: "editor", title: "Notes", message: "Review body", prefill: " Draft\u0000 \n\tbody\u009f " },
		harness.ctx,
	);

	expect(harness.selects).toEqual([["Target\n\nChoose branch", ["main", "next"]]]);
	expect(harness.inputs).toEqual([["Version\n\nEnter tag", "v1.2.3"]]);
	expect(harness.editors).toEqual([["Notes\n\nReview body", " Draft \n\tbody "]]);
	expect(harness.approved).toEqual([
		{ repo: "api", requestId: "select-1", version: 3, value: "next" },
		{ repo: "api", requestId: "input-1", version: 4, value: "typed value" },
		{ repo: "api", requestId: "editor-1", version: 5, value: "edited value" },
	]);
});

test("sanitizes colliding select labels while approving the exact selected RPC value", async () => {
	const harness = approvalHarness();
	await presentFleetApproval(
		harness.run,
		{
			repo: "api",
			id: "select-collision",
			version: 6,
			method: "select",
			title: "Target",
			options: [" release\u0000candidate ", "release\ncandidate", "release candidate (2)"],
		},
		harness.ctx,
	);

	expect(harness.selects).toEqual([
		["Target", ["release candidate", "release candidate (2)", "release candidate (2) (2)"]],
	]);
	expect(harness.approved).toEqual([
		{ repo: "api", requestId: "select-collision", version: 6, value: "release\ncandidate" },
	]);
	expect(harness.denied).toEqual([]);
});

test("keeps the observed approval version across open confirm and select dialogs", async () => {
	const calls: ApprovalCall[] = [];
	let currentVersion: number | undefined = 7;
	const run = {
		async approve(repo: string, requestId: string, version: number, value?: string) {
			calls.push({ repo, requestId, version, ...(value === undefined ? {} : { value }) });
			if (version !== currentVersion) throw new Error("stale approval identity");
		},
		async deny(_repo: string, _requestId: string, version: number) {
			if (version !== currentVersion) throw new Error("stale approval identity");
		},
	} as Parameters<typeof presentFleetApproval>[0];

	const confirmation = Promise.withResolvers<boolean>();
	const confirmCtx = {
		ui: {
			confirm() {
				return confirmation.promise;
			},
		},
	} as unknown as Parameters<typeof presentFleetApproval>[2];
	const confirming = presentFleetApproval(
		run,
		{ repo: "api", id: "same-id", version: 7, method: "confirm", title: "Original confirmation" },
		confirmCtx,
	);
	await Promise.resolve();
	currentVersion = undefined;
	currentVersion = 8;
	confirmation.resolve(true);
	await expect(confirming).rejects.toThrow("stale approval identity");

	currentVersion = 9;
	const selection = Promise.withResolvers<string | undefined>();
	const selectCtx = {
		ui: {
			select() {
				return selection.promise;
			},
		},
	} as unknown as Parameters<typeof presentFleetApproval>[2];
	const selecting = presentFleetApproval(
		run,
		{
			repo: "api",
			id: "same-id",
			version: 9,
			method: "select",
			title: "Original selection",
			options: ["first", "second"],
		},
		selectCtx,
	);
	await Promise.resolve();
	currentVersion = undefined;
	currentVersion = 10;
	selection.resolve("second");
	await expect(selecting).rejects.toThrow("stale approval identity");

	expect(calls).toEqual([
		{ repo: "api", requestId: "same-id", version: 7 },
		{ repo: "api", requestId: "same-id", version: 9, value: "second" },
	]);
});
