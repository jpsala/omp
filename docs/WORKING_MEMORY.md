# Working Memory

## Propósito

Mantener un laboratorio OMP pequeño, verificable e independiente del estado privado de usuario y de otros repositorios.

## Estado actual

- Config local: `.omp/config.yml` enlaza `wezterm-attention`,
  `agent-runtime-habitat`, `omp-profiles`, `windows-input` y las tres
  extensiones globales de browser/atención porque las listas project-local
  reemplazan, no fusionan, `extensions` del perfil. El hotkey vive en el
  wrapper estable `extensions/windows-input.ts`, que registra el shortcut y el
  listener de terminal para consumir `U+00B5` (`µ`) cuando ConPTY codifica
  `Ctrl+Alt+M` así. También carga bajo demanda `windows-input-native.ts`; si
  falta `pi_natives`, omite sólo el editor Windows y conserva el ciclo del
  catálogo. `/windows-input` permite diagnosticar esa disponibilidad.
- La configuración global de OMP (`~/.omp/agent/config.yml`) ahora incluye el
  wrapper estable `~/.omp/agent/extensions/windows-input.ts`, que reexporta la
  fuente de `C:\dev\omp`; así repos sin `.omp/config.yml`, como
  `C:\dev\dictation-tauri`, también descubren el hotkey.
- Agente OMP project-local en `.omp/agents/deepseek-pro.md`: prioriza DeepSeek V4 Pro `high`, usa OpenRouter V4 Pro 0813 como fallback disponible y hace `prewalk` al V4 Flash económico en el primer edit/write. No almacena credenciales.
- Perfil experimental reversible en `profiles/deepseek-lab.yml`: Pro `high` como `default/slow/plan`, Flash `low` como `smol/task/tiny`, cycling `default -> smol` y prewalk activo. Se lanza con `omp --config profiles/deepseek-lab.yml`; el overlay no cambia auth, sesiones ni configuración global.
- Baseline OpenRouter 2026-08-18: una corrida normal mostró Pro TTFT 1732 ms/duración 2297 ms y Flash 690/1557; par cold/warm costó `$0.00262823616` Pro vs `$0.0004993065` Flash. Es sólo precio/latencia, no calidad; DeepSeek directo sigue en 0 requests/$0.
- Smoke comparativo 2026-08-18: Luna Max padre+hijo pasó 3 tests en 165.51 s; DeepSeek Pro `max` padre + Flash `low` hijo pasó los mismos 3 tests en 138.33 s (-16.4%). DeepSeek padre reportó `$0.08508346308`; Codex sólo expuso cuota gruesa 96%, sin costo unitario. Fixture temporal en `tmp/`, no durable.
- Perfil visual global: `display.hideToolActivity: false` mantiene visibles las llamadas/resultados de tools y `terminal.showProgress: true` publica progreso nativo mientras el agente o el mantenimiento de contexto siguen activos. Las sesiones ya abiertas conservan su snapshot; `Ctrl+Shift+O` alterna la actividad de tools en una sesión viva.
- Cliente RPC: `src/omp-rpc-client.ts`, protocolo v2 con JSONL, ids, `rpc_chunk`, settle terminal y controles host correlacionados.
- Fleet: un RPC por repo, concurrencia acotada, control por run id y artifacts sanitizados en `artifacts/fleet/<run-id>/`.
- Cierre multi-repo: `extensions/sync-close-prompt.ts` registra
  `/cerrar-computadora [foco]`; usa `ctx.ui.setEditorText()` para precargar, sin
  enviar ni ejecutar, el prompt gobernado por el runbook canónico de Infra. El
  wrapper global permite usarlo desde cualquier repo.
- Habitat: `extensions/agent-runtime-habitat.ts` expone contexto runtime, lanzamiento OMP fresco sobre WezTerm, `/plan-implement-short [objetivo]` para entregar un plan mínimo a un implementador y `/promote-context [foco]` con el alias `/guardar-sesion [foco]` para consolidar deltas durables en las fuentes canónicas del repo. Todo launch declara nombre y conducta al salir; el handoff corto usa un split `Implementador · <objetivo>` que vuelve a PowerShell al terminar OMP. Wrapper global activo; handshake usa `scripts/runtime-child-bootstrap.ts` para metadata y `src/runtime-prompt-channel.ts` para entregar el prompt por un endpoint loopback efímero autenticado, nunca por argv, env ni input del pane. Smoke vivo 2026-08-11 verde: pane `76` -> `118`, mismo tab `33`, nueva session id, prompt Unicode de 9165 caracteres, acks exactos y shell limpio post-exit. El wrapper `~/.omp/agent/extensions/agent-runtime-habitat.ts` reexporta la fuente local.
- Índice: `bun run index`.
- Audit: `bun run audit`, incluyendo discovery/import real de la extensión con estado temporal y sin modelo.
- Tests focales del contrato RPC: `bun test`.

## Invariantes

- El workspace contiene fuentes, no auth, sesiones, stores ni caches.
- `extensions/` es canónico; `.omp/` sólo contiene configuración project-local fina.
- La extensión Windows instalada delega el render completo a OMP y añade selección visual mediante `decorateText`, sin reemplazar el popup de autocomplete; el ciclo de perfiles usa únicamente las APIs públicas de modelos y thinking.
- `/cerrar-computadora` sólo reemplaza el draft del editor. Ejecutar el comando
  no inicia un turno, no invoca Git y no convierte merge/deploy en parte del
  cierre cotidiano.
- Una respuesta RPC acepta un comando; no necesariamente termina un turno.
- Un `agent_end` sólo finaliza cuando `isTerminal !== false`.
- Los prompts locales pueden finalizar sin `agent_end` mediante `agentInvoked: false`.
- Una failure RPC sin id rechaza todos los pending; nunca se asigna por orden o conjetura.
- Startup RPC tiene timeout finito y resetea/reapea el child ante fallo de ready o negociación.
- Los observers WezTerm sólo leen artifacts: no poseen workers y cerrarlos no cancela un run.
- Las solicitudes UI del fleet requieren approve/deny explícito con run id; no se persisten texto crudo de resultados o errores.
- Habitat falla como `unsupported` cuando falta provider/capability; no investiga ni construye launchers ad hoc. Sólo opera panes creados por la operación y nunca el pane origen.
- La persistencia de sesión OMP y la vida del pane son independientes: `pane.onExit` decide entre cerrar o volver a un shell limpio; `pane.title` nombra el pane mediante `OSC 1`.
- Catálogo mantenible en `profiles/catalog.json`; `/profiles list|show|activate|prepare`
  vive en `extensions/omp-profiles.ts`, se descubre desde `.omp/config.yml`.
  `activate` cambia explícitamente el padre y thinking de la sesión actual;
  `prepare` conserva `omp --config profiles/<overlay>.yml` para una sesión nueva.
- El catálogo no promete cambios vivos de Task, `prewalk` o concurrencia si la
  API nativa no los expone; esos parámetros requieren el overlay completo.
- Los seis overlays actuales (`deepseek-lab`, `study-deepseek`,
  `study-luna-max`, `study-sol-luna`, `deepseek-pro-high` y
  `deepseek-flash-high`) están allowlisteados. Los dos últimos usan el provider
  directo `deepseek` en `high`; agregar o retirar combinaciones sólo requiere
  overlay y registro.

## Próxima lectura

Consultar `docs/TOPICS.md`; abrir `topics/agent-runtime-habitat.md`,
`topics/rpc-client.md`, `topics/omp-fleet.md`, `topics/wezterm-attention.md` o
`topics/ux-matrix.md` según el cambio.
