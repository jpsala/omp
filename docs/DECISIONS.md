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
y del lanzamiento de sesiones hijas. El perfil OMP carga un wrapper mínimo; los
repos de producto no copian la implementación ni construyen comandos WezTerm.

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

`/promote-context [foco]` complementa ese gate con una curaduría profunda bajo
demanda desde `agent-runtime-habitat`. El comando actualiza fuentes existentes,
preserva certeza, riesgos y gates, y ejecuta los checks documentales definidos
por el repo. No introduce una auto-memory ni otra fuente de verdad.
