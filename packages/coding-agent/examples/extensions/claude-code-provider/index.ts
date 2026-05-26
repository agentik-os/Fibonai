/**
 * Claude Code Provider for Fibonai/Pi
 *
 * Routes all LLM inference through Claude Code CLI (`claude -p --output-format stream-json --verbose`)
 * Uses the VPS OAuth Max subscription — zero API costs.
 *
 * Architecture:
 *   User types in Pi TUI → Pi calls this provider → spawns `claude -p` subprocess
 *   → Claude Code processes via OAuth Max → streams JSON events back → Pi TUI displays
 *
 * Usage:
 *   pi -e ~/.pi/extensions/claude-code-provider/index.ts --provider claude-code
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessage,
	AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export default function claudeCodeProvider(pi: ExtensionAPI): void {
	pi.registerProvider("claude-code", {
		name: "Claude Code (Max OAuth)",
		baseUrl: "http://localhost:0",
		apiKey: "not-used",
		api: "anthropic-messages",
		models: [
			{
				id: "claude-code/opus",
				name: "Opus 4.7 via Claude Code",
				reasoning: true,
				input: ["text", "image"] as any,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-code/sonnet",
				name: "Sonnet 4.6 via Claude Code",
				reasoning: true,
				input: ["text", "image"] as any,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
		],
		streamSimple(
			model: Model<any>,
			context: Context,
			_options?: SimpleStreamOptions,
		): AssistantMessageEventStream {
			const stream = new AssistantMessageEventStream();

			const lastUserMsg = [...context.messages].reverse().find((m) => m.role === "user");
			const prompt = lastUserMsg
				? lastUserMsg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n")
				: "";

			(async () => {
				try {
					const args = [
						"-p",
						"--output-format", "stream-json",
						"--verbose",
						"--max-turns", "1",
						"--dangerously-skip-permissions",
					];

					const modelId = model.id || "";
					if (modelId.includes("sonnet")) {
						args.push("--model", "sonnet");
					}

					args.push(prompt);

					const env = { ...process.env };
					delete env.ANTHROPIC_API_KEY;

					const proc = spawn("claude", args, {
						env,
						stdio: ["pipe", "pipe", "pipe"],
					});

					let fullText = "";
					let started = false;
					let buffer = "";

					const baseMessage: AssistantMessage = {
						role: "assistant" as const,
						content: [],
						stopReason: "stop",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					};

					proc.stdout.on("data", (chunk: Buffer) => {
						buffer += chunk.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";

						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const event = JSON.parse(line);

								if (event.type === "assistant" && event.message?.content) {
									for (const block of event.message.content) {
										if (block.type === "text" && block.text) {
											const newText = block.text;
											if (!started) {
												started = true;
												baseMessage.content = [{ type: "text", text: "" }];
												stream.push({ type: "start", partial: { ...baseMessage } });
												stream.push({
													type: "text_start",
													contentIndex: 0,
													partial: { ...baseMessage },
												});
											}
											const delta = newText.slice(fullText.length);
											if (delta) {
												fullText += delta;
												(baseMessage.content[0] as any).text = fullText;
												stream.push({
													type: "text_delta",
													contentIndex: 0,
													delta,
													partial: { ...baseMessage },
												});
											}
										}
									}

									if (event.message.usage) {
										baseMessage.usage = {
											input: event.message.usage.input_tokens || 0,
											output: event.message.usage.output_tokens || 0,
											cacheRead: event.message.usage.cache_read_input_tokens || 0,
											cacheWrite: event.message.usage.cache_creation_input_tokens || 0,
										};
									}
								}

								if (event.type === "result") {
									if (!started) {
										fullText = event.result || "";
										baseMessage.content = [{ type: "text", text: fullText }];
										stream.push({ type: "start", partial: { ...baseMessage } });
										stream.push({
											type: "text_start",
											contentIndex: 0,
											partial: { ...baseMessage },
										});
									}

									if (event.total_cost_usd !== undefined) {
										baseMessage.usage.cost = event.total_cost_usd;
									}

									stream.push({
										type: "text_end",
										contentIndex: 0,
										content: fullText,
										partial: { ...baseMessage },
									});
									stream.push({
										type: "done",
										reason: "stop",
										message: { ...baseMessage },
									});
								}
							} catch {
								// Non-JSON or partial line, skip
							}
						}
					});

					proc.on("close", (code) => {
						if (!started) {
							baseMessage.content = [{ type: "text", text: fullText || "(no response)" }];
							stream.push({ type: "start", partial: { ...baseMessage } });
							if (code === 0) {
								stream.push({ type: "done", reason: "stop", message: baseMessage });
							} else {
								(baseMessage as any).stopReason = "error";
								(baseMessage as any).errorMessage = `exit ${code}`;
								stream.push({ type: "error", reason: "error", error: baseMessage });
							}
						}
					});

					proc.on("error", (err) => {
						baseMessage.content = [{ type: "text", text: `Claude Code not found: ${err.message}` }];
						(baseMessage as any).stopReason = "error";
						(baseMessage as any).errorMessage = err.message;
						stream.push({ type: "error", reason: "error", error: baseMessage });
					});
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					const errMsg: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: `Provider error: ${msg}` }],
						stopReason: "error",
						errorMessage: msg,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					};
					stream.push({ type: "error", reason: "error", error: errMsg });
				}
			})();

			return stream;
		},
	});
}
