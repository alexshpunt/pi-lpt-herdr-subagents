import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ChatMessage {
	role?: string;
	content?: unknown;
}

interface ChatRequest {
	model?: string;
	messages?: ChatMessage[];
	tools?: Array<{ function?: { name?: string } }>;
}

interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

interface ResponsePlan {
	text?: string;

	holdQuiet?: boolean;
	emptyCompletion?: boolean;
	toolCalls?: ToolCall[];
}

export const TEST_MODEL = "pi-integration/test";

export interface ProviderRequest {
	model?: string;
	status: number;
	messages: ChatMessage[];
	tools: string[];
	text: string;
	userText: string;
}

const providerRequests: ProviderRequest[] = [];

export function getProviderRequests(): readonly ProviderRequest[] {
	return providerRequests;
}

export function resetProviderRequests(): void {
	providerRequests.length = 0;
}

async function readJson(request: IncomingMessage): Promise<ChatRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type?: string; text?: string } =>
				typeof part === "object" && part !== null,
		)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function requestText(request: ChatRequest): string {
	return (request.messages ?? [])
		.map((message) => messageText(message.content))
		.join("\n");
}

function lastUserText(request: ChatRequest): string {
	const message = [...(request.messages ?? [])]
		.reverse()
		.find((entry) => entry.role === "user");
	return messageText(message?.content);
}

function toolNames(request: ChatRequest): Set<string> {
	return new Set(
		(request.tools ?? [])
			.map((tool) => tool.function?.name)
			.filter((name): name is string => typeof name === "string"),
	);
}

function providerRequest(request: ChatRequest, status: number): ProviderRequest {
	return {
		model: request.model,
		status,
		messages: request.messages ?? [],
		tools: [...toolNames(request)].sort(),
		text: requestText(request),
		userText: lastUserText(request),
	};
}

function quotedValue(source: string, key: string): string | undefined {
	const match = source.match(
		new RegExp(`\\b${key}:\\s*"((?:\\\\.|[^"\\\\])*)"`),
	);
	if (!match) return undefined;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return match[1];
	}
}

function subagentCalls(source: string): ToolCall[] {
	const names = [...source.matchAll(/\bname:\s*"((?:\\.|[^"\\])*)"/g)];
	return names.flatMap((match, index) => {
		const section = source.slice(match.index, names[index + 1]?.index);
		const name = quotedValue(section, "name");
		const task = quotedValue(section, "task");
		if (!name || !task) return [];

		const agent = quotedValue(section, "agent");
		const model = quotedValue(section, "model");
		const cwd = quotedValue(section, "cwd");
		const systemPrompt = quotedValue(section, "systemPrompt");
		const skills = quotedValue(section, "skills");
		const hasSkills = /\bskills:\s*"/.test(section);
		const branch = section.match(
			/\bworktree:\s*\{\s*branch:\s*"((?:\\.|[^"\\])*)"/,
		)?.[1];
		return [
			{
				name: "subagent",
				arguments: {
					name,
					...(agent ? { agent } : {}),
					...(model ? { model } : {}),
					...(cwd ? { cwd } : {}),
					...(systemPrompt ? { systemPrompt } : {}),
					...(hasSkills ? { skills: skills ?? "" } : {}),
					...(section.includes("autoExit: false") ? { autoExit: false } : {}),
					...(section.includes("fork: true") ? { fork: true } : {}),
					...(branch ? { worktree: { branch } } : {}),
					task,
				},
			},
		];
	});
}

function subagentResumeCall(source: string): ToolCall | null {
	const sessionPath = quotedValue(source, "sessionPath");
	if (!sessionPath) return null;
	const name = quotedValue(source, "name");
	const message = quotedValue(source, "message");
	return {
		name: "subagent_resume",
		arguments: {
			sessionPath,
			...(name ? { name } : {}),
			...(message ? { message } : {}),
			...(/\bautoExit:\s*false\b/.test(source) ? { autoExit: false } : {}),
		},
	};
}

function bashCommand(source: string): string | undefined {
	const commandStart = source.search(/\becho\s+['"]/);
	if (commandStart === -1) return undefined;
	const command = source
		.slice(commandStart)
		.split(/\n(?:After|Do not|Just|Use the|Then |You must|First,|Call )/)[0]
		.trim();
	// Lifecycle tests with observable START_/STATUS_ markers need the real delay;
	// other delays only slow the suite.
	return (
		(command.includes("STATUS_") || command.includes("START_")
			? command
			: command.replace(/\bsleep\s+\d+;?\s*/g, "")) || undefined
	);
}

function markerText(source: string): string | undefined {
	const matches = [...source.matchAll(/(?:Return|return) exactly ([A-Za-z0-9_-]+)/g)];
	return matches.at(-1)?.[1];
}

async function waitForIntegrationGate(source: string): Promise<void> {
	const path = source.match(/INTEGRATION_WAIT_FOR_FILE:\s*(\S+)/)?.[1];
	if (!path) return;
	const deadline = Date.now() + 30_000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!existsSync(path)) throw new Error(`Integration gate was not opened: ${path}`);
}

function btwText(source: string): string | undefined {
	// Prefer the latest BTW question over inherited "Reply with only SECRET_" context.
	if (/BTW question:\s*Say FIRST/i.test(source)) return "FIRST";
	if (/BTW question:\s*Read the previous assistant answer/i.test(source)) {
		const secret = source.match(/SECRET_([a-z0-9_]+)/i)?.[1];
		return secret ? `BTW_CONFIRMED_SECRET_${secret}` : "BTW_CONFIRMED";
	}
	const requestedSecret = source.match(
		/Reply with only (SECRET_[a-z0-9_]+)/i,
	)?.[1];
	if (requestedSecret) return requestedSecret;
	return undefined;
}

async function planResponse(request: ChatRequest): Promise<ResponsePlan> {
	const names = toolNames(request);
	const source = requestText(request);
	const user = lastUserText(request);
	const lastRole = request.messages?.at(-1)?.role;

	if (/previous process became (?:stale|unavailable)/i.test(user)) {
		if (/subagent-resume\/crash-/i.test(user)) return { text: "QUIET_RECOVERY_COMPLETE" };
		if (/subagent-resume\/stale-/i.test(user)) return { holdQuiet: true };
	}

	if (
		/Call the subagent tool/i.test(user) &&
		!/Sub-agent "[^"]+" launched and is now running in the background/.test(source) &&
		/INTEGRATION_(?:LARGE_RESULT|HOLD_QUIET_ONCE|ALWAYS_QUIET)/.test(user)
	) {
		const calls = subagentCalls(user);
		if (calls.length > 0) return { toolCalls: calls };
	}


	if (
		/INTEGRATION_ALWAYS_QUIET/.test(source) &&
		(!/Sub-agent "[^"]+" launched and is now running in the background/.test(source) ||
			/previous process became (?:stale|unavailable)/i.test(user))
	) return { holdQuiet: true };

	if (
		/INTEGRATION_LARGE_RESULT/.test(source) &&
		!/Sub-agent "[^"]+" launched and is now running in the background/.test(source)
	) {
		return { text: `LARGE_RESULT_BEGIN\n${"x".repeat(20_000)}\nLARGE_RESULT_END` };
	}
	if (/INTEGRATION_HOLD_QUIET_ONCE/.test(source)) {
		if (/previous process became (?:stale|unavailable)/i.test(user)) {
			return { text: "QUIET_RECOVERY_COMPLETE" };
		}
		if (!/Sub-agent "[^"]+" launched and is now running in the background/.test(source)) {
			return { holdQuiet: true };
		}
	}

	const resumed = !/Call the subagent_resume tool/i.test(user)
		? user.match(/RESUME_FOLLOWUP_INPUT:\s*([a-z0-9]+)/i)?.[1]
		: undefined;
	if (resumed) return { text: `RESUME_RESULT_${resumed}` };
	const btw = btwText(source);
	if (btw) return { text: btw };

	if (names.has("subagent_done") && /CLOSE_PERSISTENT_CHILD/.test(source)) {
		return {
			toolCalls: [
				{
					name: "subagent_done",
					arguments: { summary: "SETTLED_TWO" },
				},
			],
		};
	}

	// caller_ping is always allowlisted for public children; only use it when the
	// prompt actually asks for a help ping (test-ping), not for ordinary tasks.
	if (
		lastRole !== "tool" &&
		names.has("caller_ping") &&
		/caller_ping|ONLY call caller_ping|call the caller_ping tool/i.test(source)
	) {
		return {
			toolCalls: [
				{ name: "caller_ping", arguments: { message: "PING: integration" } },
			],
		};
	}

	if (
		names.has("consumer_tree_nested_launch") &&
		lastRole !== "tool" &&
		!source.includes("nested leaf launched")
	) {
		return { toolCalls: [{ name: "consumer_tree_nested_launch", arguments: {} }] };
	}

	const consumerProbe = [
		"consumer_tree_nested_probe",
		"consumer_tree_open_probe",
		"consumer_tree_transition_probe",
		"consumer_tree_metadata_probe",
		"consumer_tree_pending_callback_probe",
		"consumer_tree_root_failure_probe",
		"consumer_tree_interrupt_probe",
		"consumer_tree_worktree_probe",
		"consumer_tree_cancel_probe",
		"consumer_tree_cancel_unconfirmed_probe",
	].find((name) => names.has(name));
	if (consumerProbe && lastRole !== "tool") {
		return {
			toolCalls: [{ name: consumerProbe, arguments: {} }],
		};
	}

	const workflowPrompt =
		names.has("herdr_workflow") &&
		/herdr_workflow|prepare this workflow|start with this run ID|cancel(?: with)? this run ID/i.test(
			source,
		);

	await waitForIntegrationGate(user);

	const descendantOwner = source.includes("DESCENDANT_OWNER_FIXTURE");
	if (
		descendantOwner &&
		names.has("subagent_done") &&
		((lastRole !== "user" && source.includes("OWNER_FOUR")) || /Sub-agent "Nested-[^"]+" (?:completed|failed|needs help|settled)/i.test(source) || source.includes("GRANDCHILD_DONE"))
	) {
		return { toolCalls: [{ name: "subagent_done", arguments: { summary: "OWNER_FINAL" } }] };
	}

	if (lastRole === "tool") {
		if (workflowPrompt) {
			const runId =
				source.match(
					/(?:start with this run ID|cancel(?: with)? this run ID):\s*([\w-]+)/i,
				)?.[1] ?? source.match(/run ID:\s*([\w-]+)/i)?.[1];
			const toolText = (request.messages ?? [])
				.filter((message) => message.role === "tool")
				.map((message) => messageText(message.content))
				.join("\n");
			const started = /started in the background/i.test(toolText);
			const cancelled = /cancelled\.|ended as /i.test(toolText);
			if (
				started &&
				!cancelled &&
				runId &&
				/cancel(?: with)? this run ID/i.test(source)
			) {
				// Wait for observed journal evidence that a reviewer started so cancel
				// claims the gate after at least one active child, not after a fixed sleep.
				const journalPath =
					source.match(/journal path:\s*([^\s]+)/i)?.[1] ??
					join(process.cwd(), ".pi", "plans", runId, "run.jsonl");
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline) {
					if (existsSync(journalPath)) {
						const body = readFileSync(journalPath, "utf8");
						if (body.includes('"type":"agent_started"')) break;
					}
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				return {
					toolCalls: [
						{ name: "herdr_workflow", arguments: { action: "cancel", runId } },
					],
				};
			}
			return {
				text:
					/\bAPPROVE\s+[a-f0-9]{8}\b/i.test(user) || cancelled
						? "WORKFLOW_PARENT_COMPLETE"
						: // Keep runId on the final assistant line so viewport waits still match
							// after a long approval packet scrolls the tool result off-screen.
							runId
							? `Prepared workflow ${runId}`
							: "Prepared workflow",
			};
		}
		return { text: markerText(source) ?? "completed" };
	}

	if (workflowPrompt) {
		if (/\bAPPROVE\s+[a-f0-9]{8}\b/i.test(user)) {
			const runId = source.match(/start with this run ID:\s*([\w-]+)/i)?.[1];
			if (runId)
				return {
					toolCalls: [
						{ name: "herdr_workflow", arguments: { action: "start", runId } },
					],
				};
		}
		const path = source.match(/prepare this workflow:\s*([^\s]+)/i)?.[1];
		if (path)
			return {
				toolCalls: [
					{ name: "herdr_workflow", arguments: { action: "prepare", path } },
				],
			};
		return { text: "WORKFLOW_PARENT_COMPLETE" };
	}

	if (
		names.has("subagent_resume") &&
		!/Session "[^"]+" resumed\./.test(source)
	) {
		const resumeCall = subagentResumeCall(user);
		if (resumeCall) return { toolCalls: [resumeCall] };
	}
	if (
		descendantOwner &&
		names.has("subagent") &&
		!/Sub-agent "[^"]+" launched and is now running in the background/.test(source)
	) {
		const gate = source.match(/INTEGRATION_DESCENDANT_GATE:\s*(\S+)/)?.[1];
		if (gate) {
			const suffix = gate.replace(/[^A-Za-z0-9]/g, "").slice(-12);
			return {
				toolCalls: [
					{
						name: "subagent",
						arguments: {
							name: `Nested-${suffix}`,
							agent: "test-echo",
							task: `INTEGRATION_WAIT_FOR_FILE: ${gate} Return exactly GRANDCHILD_DONE`,
						},
					},
				],
			};
		}
	}

	if (names.has("subagent")) {
		if (/Sub-agent "[^"]+" launched and is now running in the background/.test(source)) {
			const continuation = source.match(
				/\b(?:say|respond with)\s+([A-Z][A-Za-z0-9_]*)/,
			)?.[1];
			return { text: markerText(user) ?? continuation ?? "completed" };
		}
		const calls = subagentCalls(source);
		if (calls.length > 0) {
			return {
				toolCalls: [
					...(names.has("subagents_list") && /subagents_list/i.test(source)
						? [{ name: "subagents_list", arguments: {} }]
						: []),
					...calls,
				],
			};
		}
		// If no subagent call was requested, let the provider handle other tools
		// (for example bash in a forked child that also auto-loaded this extension).
	}

	if (names.has("bash")) {
		const command = bashCommand(source);
		if (command)
			return { toolCalls: [{ name: "bash", arguments: { command } }] };
	}

	const marker = markerText(source);
	return marker === "EMPTY_COMPLETION"
		? { emptyCompletion: true }
		: { text: marker ?? "completed" };
}

function writeEvent(
	response: ServerResponse,
	request: ChatRequest,
	delta: Record<string, unknown>,
	finishReason: string | null,
): void {
	response.write(
		`data: ${JSON.stringify({
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: request.model ?? TEST_MODEL,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`,
	);
}

function writeResponse(
	response: ServerResponse,
	request: ChatRequest,
	plan: ResponsePlan,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	if (plan.toolCalls && plan.toolCalls.length > 0) {
		writeEvent(
			response,
			request,
			{
				role: "assistant",
				tool_calls: plan.toolCalls.map((toolCall, index) => ({
					index,
					id: `call_${Date.now()}_${index}`,
					type: "function",
					function: {
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					},
				})),
			},
			null,
		);
		writeEvent(response, request, {}, "tool_calls");
	} else {
		writeEvent(
			response,
			request,
			plan.emptyCompletion
				? { role: "assistant" }
				: { role: "assistant", content: plan.text ?? "completed" },
			null,
		);
		writeEvent(response, request, {}, "stop");
	}

	response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	try {
		const chatRequest = await readJson(request);
		if (chatRequest.model === "fallback-primary" || chatRequest.model === "fallback-fail") {
			providerRequests.push(providerRequest(chatRequest, 503));
			response.writeHead(503, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "deterministic fallback provider failure" } }));
			return;
		}
		providerRequests.push(providerRequest(chatRequest, 200));

		const plan = await planResponse(chatRequest);
		if (plan.holdQuiet) {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.flushHeaders();
			return;
		}
		writeResponse(response, chatRequest, plan);
	} catch (error) {
		providerRequests.push({ status: 500, messages: [], tools: [], text: "", userText: "" });
		response.writeHead(500, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			}),
		);
	}
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
server.unref();

const address = server.address();
if (!address || typeof address === "string")
	throw new Error("Expected fake provider to bind to a TCP port");

export const TEST_PROVIDER_URL = `http://127.0.0.1:${address.port}/v1`;
