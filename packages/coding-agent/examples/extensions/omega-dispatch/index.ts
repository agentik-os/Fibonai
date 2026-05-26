/**
 * Omega Dispatch Extension for Fibonai
 *
 * Dispatches tasks to Claude Code workers via tmux sessions.
 * Uses the Omega VPS authentication (OAuth, not API keys)
 * so Fibonai orchestrates while Claude Code executes.
 *
 * Architecture:
 *   Fibonai (brain) → tmux session → Claude Code (executor)
 *   Claude Code uses OAuth auth (no token limits like programmatic API)
 *
 * Tools registered:
 *   - dispatch_to_claude: Spawn a Claude Code worker in a tmux session
 *   - monitor_worker: Check worker status via tmux capture-pane
 *   - collect_result: Read worker's done.json and intent-delta
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HOME = process.env.HOME || "/home/hacker";
const DISPATCH_SCRIPT = path.join(HOME, ".aisb/lib/dispatch-to-session.sh");
const STATE_DIR = path.join(HOME, ".aisb/state");

function sessionExists(name: string): boolean {
	try {
		execSync(`tmux has-session -t "${name}" 2>/dev/null`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function capturePaneOutput(session: string, lines: number = 50): string {
	try {
		return execSync(`tmux capture-pane -t "${session}" -p -S -${lines} 2>/dev/null`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function uniqueSessionName(base: string): string {
	let name = base;
	let i = 2;
	while (sessionExists(name)) {
		name = `${base}-${i}`;
		i++;
	}
	return name;
}

export default function omegaDispatch(pi: ExtensionAPI): void {
	// ── Tool 1: Dispatch to Claude Code ──
	pi.registerTool({
		name: "dispatch_to_claude",
		label: "Dispatch to Claude",
		description:
			"Spawn a Claude Code worker in a tmux session to execute a task. " +
			"Claude Code uses OAuth authentication (not API keys), bypassing programmatic rate limits. " +
			"The worker runs autonomously and writes a done.json when complete.",
		promptSnippet: "dispatch_to_claude - spawn Claude Code worker in tmux for autonomous execution",
		promptGuidelines: [
			"Use dispatch_to_claude for any task that requires code changes, builds, deploys, or complex multi-file operations.",
			"Each dispatch creates an isolated tmux session with its own Claude Code instance.",
			"Monitor progress with monitor_worker, collect results with collect_result.",
			"Workers use the Omega intent system: structured intent is auto-injected into their prompt.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task description for the Claude Code worker" }),
			project_path: Type.Optional(
				Type.String({ description: "Project directory path (default: current directory)" }),
			),
			session_name: Type.Optional(
				Type.String({ description: "Custom session name prefix (default: fibonai-worker)" }),
			),
			wait: Type.Optional(
				Type.Boolean({
					description: "Wait for completion and return result (default: false for async)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const projectPath = params.project_path || process.cwd();
			const baseSession = params.session_name || "fibonai-worker";
			const session = uniqueSessionName(baseSession);
			const task = params.task;

			// Use dispatch-to-session.sh if available (full Omega pipeline with intent parsing)
			if (fs.existsSync(DISPATCH_SCRIPT)) {
				try {
					const result = execSync(
						`"${DISPATCH_SCRIPT}" "${session}" '${task.replace(/'/g, "'\\''")}' "${projectPath}"`,
						{
							encoding: "utf-8",
							timeout: 30000,
							env: { ...process.env, INTENT_PARSE_ENABLED: "1" },
						},
					);
					const output = `Dispatched to tmux session: ${session}\nProject: ${projectPath}\n${result.trim()}`;

					if (params.wait) {
						return await waitForCompletion(session, signal);
					}

					return {
						output,
						metadata: { session, projectPath, status: "dispatched" },
					};
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					return { output: `Dispatch failed: ${msg}`, metadata: { error: true } };
				}
			}

			// Fallback: manual tmux session creation
			try {
				execSync(`tmux new-session -d -s "${session}" -c "${projectPath}"`, { stdio: "pipe" });
				execSync(
					`tmux send-keys -t "${session}" 'claude --dangerously-skip-permissions' Enter`,
					{ stdio: "pipe" },
				);
				// Wait for Claude to boot
				await new Promise((r) => setTimeout(r, 5000));

				// Send the task
				const escapedTask = task.replace(/'/g, "'\\''");
				execSync(`tmux send-keys -t "${session}" '${escapedTask}' Enter`, { stdio: "pipe" });

				if (params.wait) {
					return await waitForCompletion(session, signal);
				}

				return {
					output: `Claude Code worker started in tmux session: ${session}\nTask: ${task}`,
					metadata: { session, projectPath, status: "dispatched" },
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return { output: `Failed to create session: ${msg}`, metadata: { error: true } };
			}
		},
	});

	// ── Tool 2: Monitor Worker ──
	pi.registerTool({
		name: "monitor_worker",
		label: "Monitor Worker",
		description: "Check the current status of a Claude Code worker in a tmux session.",
		promptSnippet: "monitor_worker - check Claude Code worker progress in tmux",
		parameters: Type.Object({
			session: Type.String({ description: "tmux session name to monitor" }),
			lines: Type.Optional(Type.Number({ description: "Number of output lines to capture (default: 30)" })),
		}),

		async execute(_toolCallId, params) {
			const session = params.session;
			const lines = params.lines || 30;

			if (!sessionExists(session)) {
				return { output: `Session "${session}" does not exist.`, metadata: { status: "not_found" } };
			}

			const paneOutput = capturePaneOutput(session, lines);
			const doneFile = path.join(STATE_DIR, `worker-${session}.done.json`);
			const doneData = readJsonFile(doneFile);

			let status = "running";
			if (doneData) {
				status = (doneData.status as string) || "done";
			} else if (paneOutput.includes("❯") && !paneOutput.includes("Thinking")) {
				status = "idle";
			}

			return {
				output: `Session: ${session}\nStatus: ${status}\n\n--- Last ${lines} lines ---\n${paneOutput}`,
				metadata: { session, status, hasDoneFile: !!doneData },
			};
		},
	});

	// ── Tool 3: Collect Result ──
	pi.registerTool({
		name: "collect_result",
		label: "Collect Result",
		description:
			"Read the completed worker's done.json and intent-delta to get the final outcome. " +
			"Use after monitor_worker shows the worker is done.",
		promptSnippet: "collect_result - read worker outcome (done.json + intent delta)",
		parameters: Type.Object({
			session: Type.String({ description: "tmux session name of the completed worker" }),
			kill_session: Type.Optional(
				Type.Boolean({ description: "Kill the tmux session after collecting (default: false)" }),
			),
		}),

		async execute(_toolCallId, params) {
			const session = params.session;
			const doneFile = path.join(STATE_DIR, `worker-${session}.done.json`);
			const intentFile = path.join(STATE_DIR, `intent-${session}.json`);
			const deltaFile = path.join(STATE_DIR, `intent-delta-${session}.json`);

			const done = readJsonFile(doneFile);
			const intent = readJsonFile(intentFile);
			const delta = readJsonFile(deltaFile);

			if (!done) {
				return {
					output: `No done.json found for session "${session}". Worker may still be running.`,
					metadata: { status: "not_done" },
				};
			}

			const parts: string[] = [];
			parts.push(`## Worker Result: ${session}`);
			parts.push(`Status: ${done.status || "unknown"}`);
			parts.push(`Summary: ${done.summary || "no summary"}`);

			if (intent) {
				parts.push(`\n## Original Intent`);
				parts.push(`Action: ${intent.action || "unknown"}`);
				parts.push(`Target: ${intent.target || "unknown"}`);
				const criteria = intent.success_criteria as string[] | undefined;
				if (criteria?.length) {
					parts.push("Success Criteria:");
					for (const c of criteria) parts.push(`  - ${c}`);
				}
			}

			if (delta) {
				parts.push(`\n## Intent Delta`);
				parts.push(`Score: ${delta.final_score || 0}/100 (threshold: ${delta.threshold || 75})`);
				parts.push(`Verdict: ${delta.verdict || "unknown"}`);
				const gaps = delta.gaps as string[] | undefined;
				if (gaps?.length) {
					parts.push("Gaps:");
					for (const g of gaps) parts.push(`  - ${g}`);
				}
			}

			if (params.kill_session && sessionExists(session)) {
				try {
					execSync(`tmux kill-session -t "${session}" 2>/dev/null`, { stdio: "pipe" });
					parts.push(`\nSession "${session}" killed.`);
				} catch {
					// ignore
				}
			}

			return {
				output: parts.join("\n"),
				metadata: { done, intent, delta, status: "collected" },
			};
		},
	});

	// ── Slash command: /dispatch ──
	pi.registerCommand("dispatch", {
		description: "Dispatch a task to a Claude Code worker via tmux",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.appendAssistantMessage("Usage: /dispatch <task description>");
				return;
			}
			ctx.appendUserMessage(`Dispatch this task to a Claude Code worker: ${args}`);
		},
	});

	// ── Slash command: /workers ──
	pi.registerCommand("workers", {
		description: "List all active Fibonai workers",
		handler: async (_args, ctx) => {
			try {
				const sessions = execSync('tmux list-sessions 2>/dev/null | grep "fibonai-worker"', {
					encoding: "utf-8",
				}).trim();
				ctx.appendAssistantMessage(sessions || "No active workers.");
			} catch {
				ctx.appendAssistantMessage("No active workers.");
			}
		},
	});
}

// ── Helper: wait for worker completion ──
async function waitForCompletion(
	session: string,
	signal?: AbortSignal,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
	const doneFile = path.join(STATE_DIR, `worker-${session}.done.json`);
	const maxWait = 600000; // 10 minutes max
	const pollInterval = 5000; // 5 seconds
	const start = Date.now();

	while (Date.now() - start < maxWait) {
		if (signal?.aborted) {
			return { output: "Aborted by user.", metadata: { status: "aborted" } };
		}

		if (fs.existsSync(doneFile)) {
			const done = readJsonFile(doneFile);
			return {
				output: `Worker completed: ${JSON.stringify(done, null, 2)}`,
				metadata: { session, status: "completed", done },
			};
		}

		// Check if session still exists
		if (!sessionExists(session)) {
			return {
				output: `Session "${session}" disappeared before writing done.json.`,
				metadata: { session, status: "lost" },
			};
		}

		await new Promise((r) => setTimeout(r, pollInterval));
	}

	return {
		output: `Timeout waiting for worker "${session}" (${maxWait / 1000}s).`,
		metadata: { session, status: "timeout" },
	};
}
