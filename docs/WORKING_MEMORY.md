# Working Memory

## Propósito

Mantener un laboratorio OMP pequeño, verificable e independiente del estado privado de usuario y de otros repositorios.

## Estado actual

- Config local: `.omp/config.yml` enlaza `wezterm-attention`,
  `agent-runtime-habitat`, `omp-profiles`, `windows-input` y las tres
  extensiones globales de browser/atención porque las listas project-local
  reemplazan, no fusionan, `extensions` del perfil. `windows-input` conserva
  sólo el editor Windows opcional y `/windows-input`; no registra hotkeys de
  perfiles ni intercepta la selección de modelos.
- La configuración global carga `C:/dev/omp/extensions/windows-input.ts`
  directamente. Sobre OMP 17.3.8 activa el editor y `/windows-input`; evita el
  wrapper `~/.omp/agent/extensions/windows-input.ts`, cuya reexportación resuelve
  `@oh-my-pi/pi-natives` 17.4.0 sin addon Win32. El wrapper permanece como
  archivo inerte, no como discovery operativo.
- WinInput soporta selección editable por teclado y undo Windows sobre el
  prompt. No activa mouse reporting: la rueda normal recorre el scrollback de
  WezTerm y el mouse selecciona texto del terminal; `Shift + flechas` crea la
  selección editable. `Ctrl+Z` deshace texto y ediciones de rango. `Ctrl+C`
  copia una selección, limpia un draft no vacío como edición reversible y es
  inerte cuando el draft ya está vacío, por lo que un doble toque accidental no
  cierra OMP. Smoke real sobre el binario activo restauró `recuperar esto` tras
  `Ctrl+C`, `Ctrl+C`, `Ctrl+Z`.
- Agente OMP project-local en `.omp/agents/deepseek-pro.md`: prioriza DeepSeek V4 Pro `high`, usa OpenRouter V4 Pro 0813 como fallback disponible y hace `prewalk` al V4 Flash económico en el primer edit/write. No almacena credenciales.
- Perfil experimental reversible en `profiles/deepseek-lab.yml`: Pro `high` como `default/slow/plan`, Flash `low` como `smol/task/tiny`, cycling `default -> smol` y prewalk activo. Se lanza con `omp --config profiles/deepseek-lab.yml`; el overlay no cambia auth, sesiones ni configuración global.
- Baseline OpenRouter 2026-08-18: una corrida normal mostró Pro TTFT 1732 ms/duración 2297 ms y Flash 690/1557; el par cold/warm costó `$0.00262823616` Pro vs `$0.0004993065` Flash. Es sólo precio/latencia de esa corrida, no el costo actual de la cuenta DeepSeek.
- Smoke comparativo 2026-08-18: Luna Max padre+hijo pasó 3 tests en 165.51 s; DeepSeek Pro `max` padre + Flash `low` hijo pasó los mismos 3 tests en 138.33 s (-16.4%). DeepSeek padre reportó `$0.08508346308`; Codex sólo expuso cuota gruesa 96%, sin costo unitario. Fixture temporal en `tmp/`, no durable.
- Estado de costo DeepSeek 2026-08-18: el usuario confirmó una única API key y que el plan comenzó ese día; el panel del proveedor mostró `$4.31` y 1.180 requests. `omp stats` usa 24 horas por defecto y mostró 527 filas/$1.25; el panel DeepSeek es la autoridad de facturación y OMP puede subcontar requests no persistidas.
- Perfil visual global: `display.hideToolActivity: false` mantiene visibles las llamadas/resultados de tools y `terminal.showProgress: true` publica progreso nativo mientras el agente o el mantenimiento de contexto siguen activos. Las sesiones ya abiertas conservan su snapshot; `Ctrl+Shift+O` alterna la actividad de tools en una sesión viva.
- Barra de estado global ajustada: tema `dark-poimandres-compact` con effort textual (`min`, `low`, `med`, `hgh`, `xhi`, `max`), ruta completa sin abreviar, y sólo `context_pct` para evitar duplicar la ventana máxima; `context_total` fue retirado.
- Selección de modelos: el mecanismo elegido es el hub nativo de OMP
  (`Alt+M`/`/models`, Roles). Se retiraron los favoritos y el ciclo custom;
  `Ctrl+P` queda con el comportamiento nativo de OMP, salvo overrides de un
  overlay. Los perfiles siguen reservados para overlays completos de sesión.
- Cliente RPC: `src/omp-rpc-client.ts`, protocolo v2 con JSONL, ids, `rpc_chunk`, settle terminal y controles host correlacionados.
- Fleet: un RPC por repo, concurrencia acotada, control por run id y artifacts sanitizados en `artifacts/fleet/<run-id>/`.
- Cierre multi-repo: `extensions/sync-close-prompt.ts` registra
  `/cerrar-computadora [foco]`; usa `ctx.ui.setEditorText()` para precargar, sin
  enviar ni ejecutar, el prompt gobernado por el runbook canónico de Infra. El
  wrapper global permite usarlo desde cualquier repo.
- Habitat: `extensions/agent-runtime-habitat.ts` expone contexto runtime,
  lanzamiento OMP fresco sobre WezTerm, `/plan-implement-short [objetivo]` y
  promoción durable. Si se omite placement abre un split derecho al 50%; cada
  launch declara nombre y conducta al salir. El handshake usa
  `scripts/runtime-child-bootstrap.ts` y `src/runtime-prompt-channel.ts`; una
  falla del canal se reporta inmediatamente, los timeouts devuelven etapa y
  rollback estructurados, y nunca persisten prompt, URL o nonce. Wrapper global
  activo. Smoke vivo 2026-08-11: pane `76` -> `118`, mismo tab `33`, nueva
  session id, prompt Unicode de 9165 caracteres, acks exactos y shell limpio
  post-exit.
- Índice: `bun run index`.
- Audit: `bun run audit`, incluyendo discovery/import real de la extensión con estado temporal y sin modelo.
- Tests focales del contrato RPC: `bun test`.

## Invariantes

- El workspace contiene fuentes, no auth, sesiones, stores ni caches.
- `extensions/` es canónico; `.omp/` sólo contiene configuración project-local fina.
- La extensión Windows delega el render completo a OMP y añade selección
  visual mediante `decorateText`, sin reemplazar el popup de autocomplete ni
  interceptar hotkeys de selección de modelos.
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
- Los siete overlays actuales (`deepseek-lab`, `study-deepseek`,
  `study-luna-max`, `study-sol-luna`, `deepseek-pro-high`,
  `deepseek-flash-high` y `glm-flash-qwen-coder-minimax`) están allowlisteados.
  El preset mixto usa GLM 4.7 Flash `low` para lo cotidiano, Qwen3 Coder Next
  `off` para Task y MiniMax M3 `high` para `slow/plan`; mantiene `prewalk` off y
  `deepseek-pro-high` y `deepseek-flash-high` usan el provider directo `deepseek`
  en `high`; agregar o retirar combinaciones sólo requiere overlay y registro.

## Próxima lectura

Consultar `docs/TOPICS.md`; abrir `topics/agent-runtime-habitat.md`,
`topics/rpc-client.md`, `topics/omp-fleet.md`, `topics/wezterm-attention.md` o
`topics/ux-matrix.md` según el cambio.
