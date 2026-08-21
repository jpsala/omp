export const HANDOFF_AFTER_TAB_ENV = "OMP_RUNTIME_AFTER_TAB_ID";
export const HANDOFF_AFTER_TAB_USER_VAR = "OMP_HANDOFF_AFTER_TAB_ID";
export const RUNTIME_SESSION_TITLE_ENV = "OMP_RUNTIME_SESSION_TITLE";

export function handoffTabPlacementSequence(sourceTabId: string): string {
	if (!/^\d+$/.test(sourceTabId)) throw new Error("source tab id must be decimal");
	const encoded = Buffer.from(sourceTabId, "utf8").toString("base64");
	return `\u001b]1337;SetUserVar=${HANDOFF_AFTER_TAB_USER_VAR}=${encoded}\u0007`;
}
