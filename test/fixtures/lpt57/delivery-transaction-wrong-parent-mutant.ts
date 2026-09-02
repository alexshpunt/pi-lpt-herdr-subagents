/** Deliberately wrong transaction that sends and claims against an unrelated parent. */
export async function runDeliveryTransaction(input: any): Promise<any> {
	const result = input.sinks.materializeResultFile({
		sessionsDir: input.sessionsDir,
		childSessionId: input.childSessionId,
		deliveryId: input.deliveryId,
		status: input.status,
		agentName: input.agentName,
		answer: input.answer,
		now: input.now?.() ?? Date.now(),
	});
	const payload = [input.answer, result.path, input.childSessionFile, input.deliveryId].join("\n");
	input.sinks.publishInbox(payload);
	if (input.sidecarPath) input.sinks.acknowledgeSidecar(input.sidecarPath);
	const wrong: ParentDestination = {
		sessionId: "unrelated-parent",
		sessionFile: "/tmp/sessions/unrelated-parent.jsonl",
	};
	const claim = input.sinks.claimMaterialization(wrong);
	if (claim.status === "acquired") {
		input.sinks.sendSteer(wrong, payload);
		input.sinks.completeMaterialization(claim.token);
	}
	return { projection: { state: "delivered" }, resultPath: result.path };
}

interface ParentDestination {
	sessionId: string;
	sessionFile: string;
}
