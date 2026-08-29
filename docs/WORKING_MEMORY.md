# Working Memory

## Propósito

Mantener un laboratorio OMP pequeño, verificable e independiente del estado privado de usuario y de otros repositorios.

## Estado actual

- Discovery efectivo sobre OMP 18.0.10: el perfil global carga por path directo
  `wezterm-attention`, `agent-runtime-habitat`, `omp-fleet`,
  `sync-close-prompt`, `windows-input` y las cuatro integraciones runtime de OS.
  `.omp/config.yml` repite ese conjunto y suma `omp-profiles`, porque una lista
  project-local reemplaza, no fusiona, `extensions`. Los wrappers bajo
  `~/.omp/agent/extensions/` eran inertes frente a la lista explícita y quedan
  retirados; `extensions/` es la única fuente durable.
- Paridad workstation revalidada en PC `JP` y notebook `ASUS`: repo,
  configuración global y perfil administrado coinciden. El binario compilado de
  esta PC quedó actualizado a OMP 18.0.10; la notebook conserva su despliegue
  previo hasta la próxima sincronización explícita.
  El audit del laboratorio inyecta un provider sintético sin red para probar
  discovery sin depender del auth privado del host y normaliza CRLF al validar
  el índice generado; por eso el mismo checkout audita en ambas workstations.
- Defaults efectivos auditados con `omp config`: `edit.autoRepair.enabled=true`,
  `task.prewalk=false`, `advisor.enabled=false` y
  `advisor.syncBacklog=off`. Luna queda limitada a roles o flows cortos
  seleccionados explícitamente; no gobierna el runtime global.
- `windows-input.ts` es el entrypoint estable: registra el selector granular y
  carga el editor opcional 18.0.10. Sólo `windows-input-native.ts` posee
  `/windows-input`; no hay comando diagnóstico duplicado ni hotkeys de modelos.
- WinInput soporta selección editable por teclado y undo Windows sobre el
  prompt. No activa mouse reporting: la rueda normal recorre el scrollback de
  WezTerm y el mouse selecciona texto del terminal; `Shift + flechas` crea la
  selección editable. `Ctrl+Z` deshace texto y ediciones de rango. `Ctrl+C`
  copia una selección, limpia un draft no vacío como edición reversible y es
  inerte cuando el draft ya está vacío, por lo que un doble toque accidental no
  cierra OMP. Smoke real sobre el binario activo restauró `recuperar esto` tras
  `Ctrl+C`, `Ctrl+C`, `Ctrl+Z`.
- Perfil experimental reversible en `profiles/deepseek-lab.yml`: Pro `high` como `default/slow/plan`, Flash `low` como `smol/task/tiny`, cycling `default -> smol` y prewalk activo. Se lanza con `omp --config profiles/deepseek-lab.yml`; el overlay no cambia auth, sesiones ni configuración global.
- Baseline OpenRouter 2026-08-18: una corrida normal mostró Pro TTFT 1732 ms/duración 2297 ms y Flash 690/1557; el par cold/warm costó `$0.00262823616` Pro vs `$0.0004993065` Flash. Es sólo precio/latencia de esa corrida, no el costo actual de la cuenta DeepSeek.
- Smoke comparativo 2026-08-18: Luna Max padre+hijo pasó 3 tests en 165.51 s; DeepSeek Pro `max` padre + Flash `low` hijo pasó los mismos 3 tests en 138.33 s (-16.4%). DeepSeek padre reportó `$0.08508346308`; Codex sólo expuso cuota gruesa 96%, sin costo unitario. Fixture temporal en `tmp/`, no durable.
- Estado de costo DeepSeek 2026-08-18: el usuario confirmó una única API key y que el plan comenzó ese día; el panel del proveedor mostró `$4.31` y 1.180 requests. `omp stats` usa 24 horas por defecto y mostró 527 filas/$1.25; el panel DeepSeek es la autoridad de facturación y OMP puede subcontar requests no persistidas.
- Perfil visual global sobre OMP 18.0.10: la extensión registra `Ctrl+Alt+O`; en
  esta workstation, WezTerm convierte el chord físico `Ctrl+Shift+M` en esa
  secuencia privada. El selector modal opera sobre el transcript nativo y
  controla thinking, preámbulos, métricas por turno, actividad global y tools
  individuales; todos los `TranscriptContainer`, incluido el staging de
  startup/replay, reciben la misma política. Incluye presets atómicos
  `Conversación limpia`, `Trabajo enfocado` y `Diagnóstico`; permite guardar,
  aplicar y eliminar perfiles nombrados globales bajo
  `display.transcriptVisibilityProfiles`. Estado global actual: perfil `zen`,
  con thinking, preámbulos, métricas y toda la actividad de tools ocultos.
  El smoke real de 18.0.10 verificó el selector con sus tres presets, el perfil
  `zen` y 41 opciones; los 22 tests focales cubren filtrado y persistencia.
- Espejo Markdown local: `extensions/live-markdown.ts` consume los eventos
  oficiales `message_update` sólo en sesiones TUI y publica un archivo por
  sesión bajo `C:/dev/omp-live/<repo>/<fecha>/`. El nombre usa pane y session id
  completo; el documento contiene sólo respuestas del agente, Markdown crudo y
  estado `generating|idle`. Nunca copia prompts, nombres derivados del prompt ni
  payloads de tools; thinking y preámbulos siguen la política viva del
  transcript y quedan ocultos por defecto si esa API no existe. Las escrituras
  coalescen el último snapshot y todo I/O corre fuera del lifecycle de OMP:
  fallar el destino sólo registra el error.
  `/live-markdown` informa la ruta activa. El smoke real concurrente creó
  archivos distintos para `omp` y `dictation-tauri`, capturó 50/160 y 76/80
  líneas con `status: generating`, conservó 160/160 y 80/80 con `status: idle`
  tras cerrar y reiniciar OMP, y una raíz deliberadamente inválida no interrumpió
  la sesión. No se operó VS Code u Obsidian; las lecturas por etapas del mismo
  archivo verificaron el contrato vivo.
- El launcher único es `~/.bun/bin/omp.exe`, actualmente `omp/18.0.10`, con el
  addon Win32 publicado embebido y el patch workstation vigente. Además de los
  filtros granulares, el core usa 272k como límite económico de dispatch para
  Sol/Luna: al recibir un tool result que cruza el límite compacta
  sincrónicamente o aborta antes de otra request. El test determinístico del
  patch reproduce una ventana efectiva de 1M, 210k previos y un resultado
  oversize; sólo permite la primera llamada al provider. El deploy canónico
  `bun run deploy:omp -- <artifact>` exige el PE exacto, usa backups únicos aun
  con sesiones previas mapeadas y retira `omp.com`; el audit rechaza colisiones.
- Propuesta upstream de granularidad publicada el 2026-08-25 en
  [Discord `#feature-requests`](https://discord.com/channels/1465833614603325562/1465867712000692459/1541865268798820362):
  settings y rendering general en core; shortcuts, presets y perfiles en la
  extensión. Se vinculó el issue `#2158`. La implementación/PR upstream espera
  dirección del maintainer, como exige `CONTRIBUTING.md` para cambios amplios de
  UI; el build downstream 18.0.10 permanece estable mientras tanto.
- Selección de modelos: el mecanismo elegido es el hub nativo de OMP
  (`Alt+M`/`/models`, Roles). Se retiraron los favoritos y el ciclo custom;
  `Ctrl+P` queda con el comportamiento nativo de OMP, salvo overrides de un
  overlay. Los perfiles de modelos siguen reservados para overlays completos de sesión; los perfiles de visibilidad son preferencias UI independientes.
- Cliente RPC: `src/omp-rpc-client.ts`, protocolo v2 con JSONL, ids, `rpc_chunk`, settle terminal y controles host correlacionados.
- Fleet: `extensions/omp-fleet.ts` es la fuente directa de `/fleet`; un RPC por
  repo, concurrencia acotada, control por run id y artifacts sanitizados en
  `artifacts/fleet/<run-id>/`.
- Cierre multi-repo: `extensions/sync-close-prompt.ts` es la fuente directa de
  `/cerrar-computadora [foco]`; usa `ctx.ui.setEditorText()` para precargar, sin
  enviar ni ejecutar, el prompt gobernado por el runbook canónico de Infra.
- Habitat: `extensions/agent-runtime-habitat.ts` expone contexto runtime,
  lanzamiento OMP fresco sobre WezTerm, `/orquestar [objetivo]`,
  `/plan-implement-short [objetivo]`, `/handoff [foco]` y promoción durable. La
  tool acepta un workflow cerrado `prewalk|plan-yolo`, target de rol nativo y
  Advisor opt-in; nunca argv libre.
  `/plan-implement-short` abre una hija Sol en split derecho, plan-yolo entrega
  la implementación a `@smol` y Advisor revisa el corte, sin duplicar plan en
  el parent. El benchmark nativo corto pasó 8/8 turnos con Sol medium y Luna
  medium falló en el turno 5, por lo que esta degradación queda limitada al
  flow corto y `task.prewalk` global permanece apagado.
  Como el TUI despacha el builtin `/handoff` antes que extensiones, Habitat
  intercepta sólo el input exacto. Handoff persiste el cierre y abre una hija
  fresh saved en tab adyacente enfocado, con nombre generacional compartido por
  sesión y tab y origen intacto como rollback. El handshake conserva canal
  efímero, dos acks, hash, ownership del pane y fast fail sin persistir prompt,
  URL ni nonce.
  Para orquestaciones visibles, `placement:{kind:"window"}` crea un owner en
  ventana dedicada y sus tabs permanecen agrupados con títulos genealógicos
  cuya raíz es el título real del tab dispatcher; el nombre de sesión queda como
  fallback cuando WezTerm no expone ese título. Los launches de orquestación
  declaran `closeOnComplete:true`: el owner cierra cada worker sólo después de
  encolar su retorno y el dispatcher cierra el owner después de recibir el
  resultado consolidado. El cierre usa el adapter y handle exactos conservados
  en memoria; nunca mata por pane id desnudo ni reclama tabs tras reload/resume.
  Cada hija registra un mailbox runtime transitorio: su settle reanuda al parent
  por follow-up, y un orquestador no reporta upstream hasta integrar todas sus
  hijas. El dispatcher conserva un widget persistente con la última transición
  comprobada `working|waiting|blocked`; lanzamientos y retornos anidados se
  propagan automáticamente y `agent_runtime_status` cubre estados conocidos
  sólo por el owner, sin heartbeats ni polling. `waiting` y `blocked` difieren
  sólo ese turno para que una dependencia no se convierta en falso final; el
  siguiente `agent_start` de un completion consume su token y publica upstream.
  El smoke transitivo window → tab → parent pasó el 2026-08-25; el smoke de
  estados, widget, integración y retorno upstream pasó el 2026-08-26.
  `/orquestar` expone ese flow sin flags: confirma el owner y la observabilidad,
  delega sólo cuando aporta valor y devuelve el resultado consolidado a la
  sesión origen.
  `agent_runtime_session` exige `hasUI:true`: subagentes Task background
  devuelven por Task y sus hooks ignoran metadata runtime heredada, evitando que
  secuestren el pane del owner o contaminen acks/completions.
  Acks y completions fijan permisos en el temp antes del rename atómico; el
  publisher no toca el path final después de publicarlo porque el consumer puede
  claimarlo inmediatamente.
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
- La persistencia de sesión OMP y la vida del pane son independientes: `pane.onExit` decide entre cerrar o volver a un shell limpio; `pane.title` es además el nombre persistido de la sesión y, en tab placement, el título explícito del tab.
- Catálogo mantenible en `profiles/catalog.json`; `/profiles list|show|activate|prepare`
  vive en `extensions/omp-profiles.ts`, se descubre desde `.omp/config.yml`.
  `activate` cambia explícitamente el padre y thinking de la sesión actual;
  `prepare` conserva `omp --config profiles/<overlay>.yml` para una sesión nueva.
- El catálogo no promete cambios vivos de Task, `prewalk` o concurrencia si la
  API nativa no los expone; esos parámetros requieren el overlay completo.
- Los ocho overlays actuales (`deepseek-lab`, `study-deepseek`,
  `study-luna-max`, `study-sol-luna`, `codex-economic`,
  `deepseek-pro-high`, `deepseek-flash-high` y
  `glm-flash-qwen-coder-minimax`) están allowlisteados. `codex-economic` usa
  Luna High como padre/Task y conserva Sol en `plan/slow`.
- `/modo normal|economico|estado` cambia sólo el padre vivo y mantiene un status
  visible; los roles globales Task/smol/cheap usan Luna High en ambos modos.
  `/consumo` agrega stats locales por sesión o intervalo; su marcador persiste
  sólo timestamp y nunca reemplaza la cuota real de `omp usage`.
- El preset mixto usa GLM 4.7 Flash `low` para lo cotidiano, Qwen3 Coder Next
  `off` para Task y MiniMax M3 `high` para `slow/plan`; mantiene `prewalk` off.
  Los presets DeepSeek directos usan `high`; agregar o retirar combinaciones
  sólo requiere overlay y registro.

## Próxima lectura

Consultar `docs/TOPICS.md`; abrir `topics/agent-runtime-habitat.md`,
`topics/rpc-client.md`, `topics/omp-fleet.md`, `topics/wezterm-attention.md` o
`topics/ux-matrix.md` según el cambio.
