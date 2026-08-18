# Decisions

## 2026-08-04 — Workspace separado del estado OMP

`C:\dev\omp` conserva código y conocimiento durable. `~/.omp` sigue siendo estado privado administrado por la aplicación. No se espejan ni sincronizan.


## 2026-08-04 — Discovery project-local fino

La implementación vive en `extensions/wezterm-attention.ts`. `.omp/config.yml` contiene el path relativo de carga y la exclusión project-local del editor ambient incompatible. Se evita duplicar la fuente y no se instala un plugin.

## 2026-08-04 — UX primero nativa

Windows input, status line/cuota y renderers se conservan nativos cuando el runtime actual ya expone la capacidad. La única portabilidad activa es la señal de atención a WezTerm porque integra un consumidor externo local y no reemplaza el TUI.

## 2026-08-04 — Editor nativo project-local

`.omp/config.yml` deshabilita `extension-module:windows-input` en este workspace. El módulo ambient sustituye el editor OMP y elimina el autocompletado de `/`; el editor nativo ya cubre input y clipboard en Windows. No se modifica ni copia el estado privado bajo `~/.omp`.

## 2026-08-04 — RPC v2 como referencia aislada

El cliente usa stdio JSONL, negocia v2, correlaciona por id, valida/reensambla `rpc_chunk` y separa ack de finalización. Es código de referencia autocontenido, no una librería publicada ni una dependencia impuesta a otros repositorios.

## 2026-08-08 — Fleet local, explícito y sin dependencias

`extensions/omp-fleet.ts` es la fuente durable. El perfil OMP carga un wrapper mínimo en `~/.omp/agent/extensions/omp-fleet.ts` que reexporta esa fuente, evitando copias divergentes y haciendo `/fleet` global entre repos y reinicios; `.omp/config.yml` ya no duplica su discovery. La implementación usa APIs públicas de OMP y módulos `node:`, sin dependencias de terceros.

Cada repo habilitado obtiene un RPC independiente; los comandos que cambian workers o responden solicitudes exigen run id y target explícitos. Las aprobaciones nunca son automáticas: además identifican repo y request id, conservan ese request id en la respuesta y pasan por approve/deny explícito.

WezTerm y `fleet-observer.ts` son observadores de artifacts, no propietarios de workers; cerrarlos no cancela el run. La persistencia local conserva sólo metadatos, estados y resúmenes sanitizados, nunca texto crudo de resultados o errores.

## 2026-08-11 — Runtime Habitat global, launch explícito y fast fail

`extensions/agent-runtime-habitat.ts` es la fuente durable del contexto runtime
y del lanzamiento de sesiones hijas. El `config.yml` global declara esa fuente
directamente porque su lista explícita de extensiones reemplaza discovery; el
wrapper mínimo queda como fallback para perfiles sin lista. Los repos de
producto no copian la implementación ni construyen comandos WezTerm.

Harness y host son independientes. La primera implementación soporta OMP sobre
WezTerm, usa pane e instancia explícitos, separa `fresh` de `persistence` y
entrega prompts por un canal loopback efímero con handshake/hash, nunca por argv,
env ni input simulado del terminal. La operación conserva ownership únicamente
sobre panes que creó y hace rollback del pane exacto ante un fallo posterior a
la creación.

El bootstrap Bun transporta sólo metadata correlacionada no sensible por argv,
deriva pane e instancia del entorno real del child, limpia recursion markers y
arranca OMP. El parent expone el prompt una sola vez en un endpoint tokenizado
de `127.0.0.1`; el entorno lleva sólo URL opaca y hash. La extensión hija valida
el contenido, limpia esas variables y usa `pi.sendUserMessage()`. El prompt
sigue excluido de argv, env, terminal, markers y artifacts.

Una combinación sin adapter/capability devuelve `unsupported` y termina. No
busca variables internas, sesiones, procesos, directorios de colaboración ni
fallbacks manuales. El control manual por CLI queda reservado a diagnóstico
explícito, no al flujo normal del agente.

## 2026-08-12 — Capacidades OMP por trigger, no por novedad

Las herramientas avanzadas se seleccionan por evidencia de la tarea. `eval` es
el laboratorio preferido para cálculo ad hoc, análisis de datos y prototipos
incrementales en Python o JavaScript; no sustituye la ejecución, integración ni
verificación del código real del repositorio. `debug` se activa ante fallos de
estado, crashes o hangs que el análisis estático no cierre, y `ast_edit` ante
codemods estructurales repetidos.

LSP, hashline, internal URLs y los checks focales continúan como flujo normal.
Advisor, review y subagentes pueden activarse por defecto cuando OMP o el
sistema agéntico detectan riesgo, revisión especializada o slices realmente
independientes; no requieren una solicitud adicional por ejecución. El agente
principal conserva contratos, integración y aceptación. Commits, push,
publicación, deploy, instalaciones y uso de credenciales disponibles no agregan
un gate AOS cuando son necesarios para el resultado; se verifican destino,
alcance y valores y se respetan las salvaguardas runtime de OMP o del proveedor.
Los pull requests son excepcionales y requieren un motivo concreto. Collab,
browser y computer sólo se activan cuando su necesidad y las políticas locales
lo permiten.

## 2026-08-14 — Handoff corto como comando del Runtime Habitat

`/plan-implement-short [objetivo]` vive en la extensión global
`agent-runtime-habitat`, junto a la tool que lanza la sesión. El slash command
inyecta una instrucción compacta al parent en vez de copiar un prompt manual:
el parent resuelve alcance y contratos, arma el plan completo con la menor
cantidad de pasos y entrega un único handoff autocontenido.

El implementador arranca inmediatamente en un split derecho al 50%, fresh
saved, mismo cwd y modelo heredado; el foco queda en el parent. El paralelismo
es interno al implementador y sólo para slices independientes con contrato
cerrado. El parent no duplica implementación ni monitorea el pane después del
handshake.

## 2026-08-14 — Nombre y cierre del pane son contrato explícito

`agent_runtime_session` exige `pane: { title, onExit }` para tabs y splits.
`title` usa `OSC 1`; `onExit: "close"` termina el pane con OMP y
`onExit: "keep-open"` vuelve a un shell interactivo en el mismo `cwd`. Así se
separan ubicación (`placement`), almacenamiento de la sesión (`persistence`) y
ciclo de vida del terminal (`pane.onExit`) sin inferencias por tipo de launch.

El shell posterior recibe un entorno limpio, sin metadata `OMP_RUNTIME_*`, canal
efímero del prompt ni marcadores de recursión. `/plan-implement-short` elige
`Implementador · <objetivo>` y `keep-open`; otros callers deben declarar su
propia intención.

## 2026-08-14 — Closeout semántico y promoción explícita

El baseline global exige comparar los deltas de todo trabajo no trivial con la
documentación canónica antes de entregar. Sólo se promueve información durable
faltante y una única vez; ausencia de delta no crea archivos. Transcripts,
intentos, logs, resultados crudos de tools y hechos derivables del código se
descartan.

`/promote-context [foco]` y su alias en español
`/guardar-sesion [foco]` complementan ese gate con una curaduría profunda bajo
demanda desde `agent-runtime-habitat`. Actualizan fuentes existentes, preservan
certeza, riesgos y gates, y ejecutan los checks documentales definidos por el
repo. No introducen una auto-memory ni otra fuente de verdad.

## 2026-08-16 — Cierre multi-repo revisable y gobernado por Infra

`/cerrar-computadora [foco]` es una extensión UX pequeña, no un sincronizador.
Precarga mediante `ctx.ui.setEditorText()` una instrucción para cerrar el trabajo
versionable del host y deja el envío bajo control humano. No llama
`sendUserMessage`, Git, workers ni proveedores al ejecutar el slash command.

La política vive únicamente en
`C:\dev\infra\docs\runbooks\sync-multi-repo.md`; la extensión conserva un prompt
compacto que remite a esa autoridad y fija los límites necesarios para una
sesión sin contexto: auditoría inicial/final, revisión semántica por repo,
checks focales, commits y push no productivos, y bloqueo explícito de
divergencias, artifacts privados o riesgo de producción. Merge/rebase a `main`,
release, deploy y reparación destructiva quedan fuera del cierre cotidiano.

La fuente durable es `extensions/sync-close-prompt.ts`; el perfil global carga
un wrapper mínimo. Así el comando queda disponible desde cualquier repo sin
copiar reglas de Infra ni estado privado al laboratorio.

## 2026-08-18 — Agente DeepSeek project-local con prewalk económico

El workspace incorpora `.omp/agents/deepseek-pro.md`. Su lista de modelos
prioriza `deepseek/deepseek-v4-pro:high` cuando existe una credencial directa y
usa `openrouter/deepseek/deepseek-v4-pro-0813:high` como fallback actualmente
disponible en el catálogo efectivo del workspace. `prewalk` transfiere el primer
`edit` o `write` al selector económico
`openrouter/deepseek/deepseek-v4-flash-0731:low`.

La elección permanece en OMP, no en AOS: el modelo, provider, effort, tools y
handoff son configuración runtime del agente project-local. AOS conserva sólo
esta razón durable y el repositorio sigue sin almacenar credenciales. El provider
directo `deepseek` queda como primera opción cuando exista una credencial OMP
válida; no se copia ningún secreto al repositorio.

## 2026-08-18 — Perfil reversible para investigar DeepSeek

El workspace incorpora `profiles/deepseek-lab.yml` como overlay OMP de proceso,
no como un `--profile` de almacenamiento. Esa elección evita separar sesiones,
auth y caches: el objetivo es cambiar modelos, no crear otro perfil de usuario.

El overlay usa V4 Pro `high` como `default`, `slow` y `plan`; V4 Flash `low`
como `smol`, `task` y `tiny`; y `cycleOrder: [default, smol]` para alternar la
calidad normal y la implementación guiada. `prewalk.enabled` queda activo para
que el modelo fuerte pueda planificar y el modelo económico tomar la edición
cuando existe un todo-list de implementación.

La investigación mide costo efectivo, tokens, latencia, tool calls y tasa de
reparación con `omp bench` y el uso del provider. No se agregan scripts de API,
claves ni un segundo runtime; `--config` permite retirar el experimento sin
alterar la configuración global.

## 2026-08-18 — Baseline de costo y latencia DeepSeek vía OpenRouter

Se ejecutó un benchmark controlado con una solicitud normal por modelo (`maxTokens`
128, `par=1`) y un par cold/warm de cache (`maxTokens` 64), usando los selectors
OpenRouter V4 Pro 0813 `high` y V4 Flash 0731 `low`. Las cuatro solicitudes
terminaron correctamente.

La corrida normal observó TTFT de 1732 ms y duración de 2297 ms para Pro, frente
a 690 ms y 1557 ms para Flash. En el par de cache, Pro costó `$0.0022842864`
en frío y `$0.00034394976` en caliente, con 1536 tokens leídos de cache; Flash
costó `$0.00024965325` tanto en frío como en caliente y no expuso cache hit en
esa ruta. El par completo fue `$0.00262823616` para Pro y `$0.0004993065` para
Flash, aproximadamente 5.26x más caro para Pro en esta muestra.

Es un baseline de precio/latencia, no una comparación de calidad: una sola corrida
no prueba superioridad para coding. El prompt de cache tenía aproximadamente
1555 tokens de input y 64 de output por fase. Las solicitudes fueron vía
OpenRouter; el panel oficial de DeepSeek permaneció en `$0.00`, 0 requests y 0
tokens. Repetir con tareas de programación equivalentes, éxito de primera pasada,
reparaciones y costo por tarea cerrada antes de fijar una política definitiva.

## 2026-08-18 — Primer smoke Luna Max frente a DeepSeek Pro Max + Flash

La comparación cambió la baseline solicitada: Luna Max actúa como padre y como
implementador; el perfil DeepSeek usa V4 Pro `max` como padre y V4 Flash `low`
como hijo `task`. Ambos perfiles desactivan `prewalk`, fijan una sola tarea hija
y trabajan sobre `tmp/deepseek-study-fixture`, que se excluye del repositorio.

La tarea fue implementar `summarizeQueue` con invariantes de conteo, tasa de
completitud, cola vacía, primer queued por `createdAt` y no mutación. Ambos padres
delegaron exactamente una tarea y ambos dejaron `3 pass, 0 fail`; las
implementaciones fueron equivalentes en complejidad y pasaron el mismo fixture.

Luna Max tardó 165.51 s de extremo a extremo. DeepSeek Pro + Flash tardó
138.33 s, aproximadamente 16.4% menos en esta corrida. El stream DeepSeek
expuso seis turnos del padre, 56,334 tokens de input, 2,388 de output y un costo
observado del padre de `$0.08508346308`; el hijo Flash quedó asignado por
`task.agentModelOverrides`, pero esta ejecución sin sesión no expuso su receipt
de uso separado. El provider openai-codex conservó el reporte grueso de 96% de
cuota semanal usada antes y después, por lo que no permite atribuir un costo
unitario a Luna Max.

Este smoke prueba coordinación, compilación/tests y latencia, no superioridad de
calidad. La siguiente iteración debe repetir varias tareas y capturar receipts
de padre e hijo por separado antes de decidir el routing por defecto.

## 2026-08-18 — Catálogo de overlays y activación honesta

`profiles/catalog.json` separa la metadata mantenible de los cuatro overlays
YAML nativos. `extensions/omp-profiles.ts` registra una única superficie
`/profiles` con `list`, `show <name>`, `activate <name>` y `prepare <name>`, y
deriva el autocomplete de las entradas del catálogo.

La allowlist valida nombres estables y overlays relativos directos dentro de
`profiles/`; no acepta traversal, paths absolutos ni modelos arbitrarios.
`activate` cambia explícitamente el modelo padre y thinking de la sesión viva
mediante `setModel`/`setThinkingLevel`, sin fingir cambios de Task, `prewalk` o
concurrencia. `prepare` conserva el launcher exacto del overlay para una sesión
nueva cuando se necesita aplicar la combinación completa.
