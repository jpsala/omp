import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const SYNC_CLOSE_COMMAND = "cerrar-computadora";

export function buildSyncClosePrompt(focus: string): string {
	const explicitFocus = focus.trim();
	const focusInstruction = explicitFocus
		? `\nFoco adicional provisto por JP (JSON string): ${JSON.stringify(explicitFocus)}\n`
		: "";

	return `Cerrá de forma segura el trabajo versionable de esta computadora.

Seguí como autoridad C:/dev/infra/docs/runbooks/sync-multi-repo.md, sección «Cierre Cotidiano De Una Computadora». Si este host es el VPS, usá /home/jpsal/dev/infra. Leé primero el contexto liviano de Infra y después las reglas propias de cada repo que realmente requiera trabajo.${focusInstruction}

1. Desde Infra ejecutá bun run sync:audit y conservá ese resultado como baseline.
2. Procesá sólo repos dirty, local-ahead, diverged, unknown o con locks/stashes que requieran decisión. Entendé el diff y separá unidades semánticas; no hagas commits mecánicos de archivos mezclados.
3. Excluí secretos, datos personales, dumps, stores, sesiones, artifacts privados y generados accidentales. Stageá únicamente paths revisados; nunca uses git add -A.
4. Ejecutá los checks focales definidos por cada proyecto. Si el cambio es coherente y verificable, creá commit y hacé push de la rama actual o de una rama wip/<tema> no productiva. Este pedido autoriza esos commits y pushes; no autoriza merge/rebase a main, release, deploy, reinicios, cambios DNS, servicios ni envíos reales.
5. No uses reset --hard, clean, force-push, stash automático ni borres refs/stashes. Ante divergencia, remote unknown, operación Git activa, conflicto, artifact privado, check fallido o riesgo de activar producción, preservá el estado y reportá un bloqueo explícito.
6. Si hay repos independientes y aporta paralelismo real, trabajá en worktrees aislados con un agente por repo. El coordinador principal revisa, integra y publica; ningún agente debe modificar el checkout canónico fuera de su slice.
7. Al final repetí bun run sync:audit contra los remotos reales. No termines hasta que cada repo afectado esté limpio e igual a su upstream publicado, o figure bloqueado con paths, causa y próximo paso concreto.

Entregá una tabla compacta por repo con rama, commit publicado, checks ejecutados, estado final del worktree y bloqueos. No confundas sincronización Git con deploy.`;
}

export default function syncClosePrompt(pi: ExtensionAPI): void {
	pi.registerCommand(SYNC_CLOSE_COMMAND, {
		description: "Insertar el cierre seguro de los repos de esta computadora",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.setEditorText(buildSyncClosePrompt(args));
		},
	});
}
