# Agent Runtime Habitat

Status: active
Summary: Contexto runtime tipado y lanzamiento OMP fresco sobre un pane WezTerm poseído, con handshake y rollback.

## Contrato

`extensions/agent-runtime-habitat.ts` registra dos tools globales:

- `agent_runtime_context`: lectura sanitizada de harness, host, ubicación y capacidades.
- `agent_runtime_session`: lanzamiento local explícito de una sesión hija OMP.

La extensión no autoriza lanzamientos por estar disponible. La tool mutante conserva los gates del perfil y sólo opera ante una solicitud directa.

### Handoff corto de implementación

`/plan-implement-short [objetivo]` empaqueta el objetivo en la sesión actual y
lanza exactamente una hija como dueña conjunta de planning e implementación. El
parent no investiga para cerrar un plan completo ni implementa. Sin argumento
deriva la solicitud accionable inmediatamente anterior; si no existe un objetivo
recuperable, pide sólo ese dato y no abre una sesión.

La hija es fresh saved, hereda modelo y cwd, abre un split derecho al 50%,
conserva el foco en el parent y usa `onExit: "keep-open"`. El request declara
exactamente `workflow: { mode: "plan-yolo", target: "@smol", advisor: true }`.
OMP recibe el workflow nativo plan-yolo: la hija produce el plan y aplica el
cambio patch-specific, en vez de recibir un plan completo preparado por el
parent. Este comando opta explícitamente por advisor; no convierte advisor en
default para otros lanzamientos.

El pane recibe un título corto `Implementador · <objetivo>`. El parent no abre
panes adicionales ni monitorea al child después del handshake. Salir de OMP
devuelve a un PowerShell limpio en el mismo split, en vez de eliminarlo.

### Orquestación visible en ventana

`/orquestar [objetivo]` convierte la sesión actual en dispatcher y lanza
exactamente un owner fresh saved con modelo heredado, `focus:true`,
`onExit:"keep-open"`, `closeOnComplete:true` y
`placement:{kind:"window"}`. Sin argumento deriva la solicitud accionable
inmediatamente anterior; si no existe, pide sólo el objetivo y no abre una
ventana.

El dispatcher sólo construye un kickoff autocontenido. El owner decide si
delegar aporta valor: puede trabajar solo o fijar contratos, dependencias y
ownership antes de abrir implementadores o revisores en tabs. Cada tab de
orquestación declara `closeOnComplete:true`: el owner cierra sus workers cuando
ya recibió el resultado, y el dispatcher cierra el owner cuando recibe el
resultado consolidado. Paraleliza únicamente frentes independientes, integra
todos los retornos automáticos y verifica el conjunto antes de responder
upstream. El dispatcher no abre workers, no monitorea la ventana y un fallo de
launch no crea una segunda. Tras el handshake confirma owner, pane y session id,
pero no queda en silencio: mantiene un widget persistente con el último estado
comprobado y el retorno automático.

El owner publica sólo transiciones reales mediante `agent_runtime_status`:
`working`, `waiting` o `blocked`, con detalle acotado y sin heartbeats. Lanzar
una hija y recibir su retorno también generan transiciones automáticas que se
propagan hacia el dispatcher. `waiting` y `blocked` difieren el cierre upstream
de ese turno; la sesión visible puede continuar cuando se resuelva la
dependencia, sin convertir una pregunta o bloqueo en un falso resultado final.

### Promoción de contexto durable

`/promote-context [foco]` y su alias en español `/guardar-sesion [foco]`
disparan una curaduría semántica en la sesión actual.
Compara conversación y estado comprobado con las fuentes canónicas del repo,
promueve una sola vez únicamente deltas durables y prefiere actualizar
documentos existentes. Rutea reglas a `AGENTS.md`, estado vivo a Working
Memory, decisiones con razones a Decisions, conocimiento reusable a topics y
trabajo retomable incompleto a tracks.

El comando no crea memoria paralela ni guarda transcripts, handoffs, intentos,
logs, resultados crudos de tools o hechos derivables del código. Si no encuentra
un delta durable no edita archivos. Tras cambios documentales ejecuta el índice
y audit definidos por el repo y reporta promociones, omisiones deliberadas y
checks.

### Handoff atómico de continuidad

`/handoff [foco]` cierra semánticamente el corte actual, promueve sólo el valor
durable faltante y construye un kickoff compacto con el sobre temporal necesario
para arrancar sin la conversación origen. Una track se actualiza o crea sólo
cuando existe trabajo vivo retomable que la necesita.
El TUI de OMP despacha su builtin `handoff` antes que los comandos de extensión,
por lo que un registro homónimo nunca se alcanza en el flujo interactivo. La
extensión no conserva esa colisión inerte: intercepta únicamente el input exacto
`/handoff [foco]` antes del despacho de builtins, lo consume y envía al agente el
prompt coordinador atómico. Otros prefijos no coinciden. `/compact` conserva la
compactación nativa en la sesión actual; el builtin nativo `/handoff` queda
deliberadamente oculto por esta operación AOS.

Si la persistencia o sus checks fallan, el comando no lanza otra sesión. Si
cierran, abre exactamente una sesión fresh saved en un tab nuevo, inyecta y
envía el kickoff, enfoca la hija y conserva el origen intacto como rollback.
El nombre de la hija deriva del nombre actual con generación incremental
(`<nombre> · 2`, `<nombre> · 3`); el mismo valor se persiste como nombre de
sesión OMP y título explícito de tab.

El tab nace en la misma ventana e inmediatamente después del tab origen. El
bootstrap emite `OMP_HANDOFF_AFTER_TAB_ID` como user var con el id decimal del
origen; la configuración WezTerm canónica mueve sólo el tab que contiene al pane
emisor. El parent confirma nombre, adyacencia, session id distinta y hash exacto
antes de considerar exitoso el lanzamiento. Un fallo revierte únicamente el
pane owned.

## Primera implementación

- Harness: OMP 17.2.13.
- Host: WezTerm en Windows.
- Ubicación: instancia, window, tab y pane se validan por `wezterm cli list --format json`.
- Split: `split-pane` con pane origen explícito; tab: `spawn` con pane origen explícito.
- Fresh saved: overlay `runtime/omp-fresh-session.yml` con `autoResume: false`.
- Fresh ephemeral: `--no-session`.
- Selección de modelo: el request siempre declara `explicit` o `inherit`;
  `inherit` resuelve el modelo actual.

### Workflows nativos cerrados

`agent_runtime_session.workflow` es opcional. Su ausencia conserva exactamente
el argv histórico. Cuando está presente sólo acepta:

```text
{ mode: "prewalk" | "plan-yolo", target?: string, advisor?: boolean }
```

La traducción es directa y sin argv libre: `prewalk` agrega `--prewalk` y un
target agrega `--prewalk-into <target>`; `plan-yolo` agrega `--plan-yolo` y un
target agrega `--plan-yolo-into <target>`. Sólo `advisor: true` agrega
`--advisor`. Campos extra, tipos incorrectos y targets vacíos devuelven
`unsupported` antes de crear un pane.

`target` es un selector de rol nativo OMP, por ejemplo `@smol`; no es
`model.spec`, no cambia el modelo efectivo declarado por `model` y no debe
sintetizarse como `provider/model`. Activar un workflow puede sumar turns,
latencia y costo frente al lanzamiento legacy. El caller opta por ese costo en
cada request; el rollback sigue limitado al pane owned y conserva intacto el
origen.


### Ciclo de vida y nombre de panes

Todo request de `agent_runtime_session` declara
`pane: { title, onExit, closeOnComplete? }`. `placement` es opcional: si se
omite, el runtime abre un split derecho al 50%; `{ kind: "tab" }` crea un tab
inmediatamente después del origen y `{ kind: "window" }` crea el primer tab de
una ventana dedicada. Una ubicación split explícita conserva soporte para otra
dirección. `title` se persiste como nombre de sesión OMP; para tab y window
placement también se aplica mediante `wezterm cli set-tab-title`.

Los tabs y ventanas nuevos conservan genealogía visual automáticamente. El
runtime toma como origen el título real del tab creador leído del probe validado
de WezTerm y, sólo si ese dato falta, usa el nombre de sesión OMP. Luego antepone
`<origen>: <title>`; no lo duplica cuando el título solicitado ya empieza con
ese origen seguido por `:` o ` · `. Esto conserva el nombre del tab dispatcher
como raíz común y permite jerarquía anidada (`os: Orquestador: Implementador`).
Los splits no cambian su título porque no crean otro tab.

`onExit: "close"` conserva el comportamiento nativo: al terminar OMP también
termina el proceso principal y WezTerm elimina el pane. `onExit: "keep-open"`
inicia un shell interactivo después de OMP, en el mismo `cwd`; Windows usa
PowerShell 7 y otros hosts usan `$SHELL` o `/bin/sh`. El shell recibe un entorno
limpio: no hereda metadata `OMP_RUNTIME_*`, el canal efímero del prompt ni
marcadores de recursión. Cerrar explícitamente un pane normal en WezTerm siempre
lo elimina. El pane, shell o proceso bootstrap que sobreviva por `keep-open` no
es trabajo pendiente por sí mismo.

`closeOnComplete:true` es un opt-in distinto de `onExit`: el parent conserva en
memoria el handle exacto que creó y cierra sólo ese pane después de encolar con
éxito el `followUp` de su resultado final. El mailbox se reconoce después del
enqueue y antes del cierre. No cierra por transiciones `working|waiting|blocked`,
no opera por pane id desnudo y no afecta handoffs o launches que omiten el flag.
Para launches con `closeOnComplete:true`, el parent también sondea cada tres
segundos el handle exacto que creó. Si ese pane poseído desaparece antes de un
resultado terminal, publica `cancelled` por el mailbox normal y reanuda la
integración. Fallas transitorias del probe conservan el pending; un pane no
poseído nunca participa en esta reconciliación.
Si el enqueue falla, conserva mailbox y pane para reintentar. Si el parent se
recarga o reabre, no intenta reclamar ownership histórico; deja el tab
sobreviviente intacto antes que arriesgar cerrar un pane reutilizado.

`persistence: "saved"|"ephemeral"` gobierna el almacenamiento de la sesión OMP;
no gobierna la vida del pane. `placement` gobierna únicamente ubicación y tamaño.

La tool es exclusiva de un owner interactivo con `harness.hasUI:true`. Los
subagentes background de Task pueden heredar variables WezTerm y metadata
`OMP_RUNTIME_*`, pero no poseen la UI ni el pane: `agent_runtime_session`
devuelve `unsupported`, y sus hooks no publican acks ni completions heredadas.
Esos subagentes deben devolver por Task; nunca pueden abrir splits, tabs o
ventanas visibles usando el pane del parent. El fragmento runtime expone
`ui=yes|no` para que el agente conozca este gate antes de invocar.

### Retorno automático y estado observable

Cada launch exitoso registra transitoriamente la identidad de la hija bajo el
directorio runtime privado del usuario. El estado semántico es:

- `working`: la hija ejecuta o el parent integra un retorno; sigue pendiente.
- `waiting`: la hija espera un retorno o condición externa; sigue pendiente y
  difiere sólo una finalización normal de ese turno.
- `blocked`: la hija requiere una acción externa concreta; sigue pendiente y
  difiere sólo una finalización normal de ese turno.
- `attention_required`: no hubo resultado ni actividad durante 15 minutos; el
  pending se conserva para inspección, reanudación o cancelación explícita.
- `completed|failed|cancelled`: la hija publicó un resultado terminal. Ese
  resultado sigue siendo trabajo pendiente del parent hasta que su `followUp`
  queda encolado; después, la sesión del parent permanece `pending` por su
  mensaje de integración hasta que produce la respuesta terminal correspondiente.

La vida de panes no poseídos, tabs, shells o procesos no participa en esa
clasificación. `onExit:"keep-open"` puede conservar el bootstrap y el pane
después de `completed` sin reabrir trabajo. La única excepción es la
desaparición comprobada del handle exacto de un launch
`closeOnComplete:true`: representa la cancelación externa de esa sesión visible
y genera un retorno `cancelled`, no un pending indefinido.

En el primer `agent_end` realmente terminal, la hija publica estado y texto
final acotado; no persiste prompts ni transcripts. `waiting` o `blocked`
difieren una respuesta normal para que el owner quede retomable, pero nunca
suprimen `error` o `aborted`. Un `session_shutdown` cancela primero cada pending
propio, cierra los panes runtime-owned que todavía controla y conserva para
reconciliación sólo las cancelaciones que no pudo cerrar. Después publica su
propio `cancelled`, de modo que Retry, cierre o fallo no dejen al parent ni a un
subárbol de workers esperando sin estado terminal.

El mismo mailbox acepta transiciones acotadas
`working|waiting|blocked|attention_required`. El parent las consume, actualiza
un widget persistente sobre el editor y las propaga transitivamente si también
es una hija. No convierte la ausencia genérica de liveness en resultado
terminal; sólo reconcilia la desaparición comprobada de un pane
`closeOnComplete` que todavía posee en memoria. Los lanzamientos anidados
publican `waiting`, los retornos recibidos publican `working` y la falta de
actividad publica una única atención por launch.
`agent_runtime_status` cubre los cambios que sólo el owner conoce.

`/runtime-children` lista launch id, nombre y antigüedad de los pending propios.
`/runtime-cancel <launchId>` publica `cancelled` por el canal normal, reanuda la
integración y conserva las validaciones de ownership.

Al llegar un resultado final, el parent lee el completion sin retirar todavía
el registro pending e inyecta un `followUp` que reanuda automáticamente su
orquestación. Sólo después de que `sendUserMessage` acepta ese follow-up reconoce
el mailbox; entonces, si la hija declaró `closeOnComplete:true`, cierra el pane
runtime-owned con el mismo adapter y handle del launch. Si la inyección falla,
completion, pending y pane permanecen disponibles para reintento. Un restart
anterior al reconocimiento vuelve a ofrecer el mismo completion: el contrato es
at-least-once y prioriza no perder el mailbox. Un launch sin completion válido
permanece pendiente salvo que el parent vivo compruebe que desapareció el pane
`closeOnComplete` exacto que posee; en ese caso publica `cancelled`. Un
completion ya publicado siempre prevalece sobre una cancelación tardía.

Cada follow-up de completion reserva un token in-memory antes de llamar
`sendUserMessage`; el siguiente `agent_start` consume exactamente uno y marca
ese loop como integración. Si ese loop termina con `willContinue:true` —por
ejemplo, porque Advisor o mantenimiento agenda una continuación— conserva la
marca hasta el primer `agent_end` realmente terminal; no convierte la
continuación en un falso final ni pierde el retorno upstream. `agent_start`, no
`before_agent_start`, es la frontera fiable porque los follow-ups internos
pueden continuar sin repetir el preflight de un prompt interactivo. El
`agent_end` anterior no consume un token que llegó después de haber empezado.

Si una hija actúa como orquestador y todavía conserva pending propios, no
reporta upstream al cerrar su primer turno. Integra los retornos que recibe y
sólo publica su resultado cuando ya no quedan hijas pendientes. El registro es
atómico y forma parte del launch: si falla, el pane recién creado se revierte.
El mailbox permite recuperar completions y estados pendientes cuando una sesión
guardada se reabre; los archivos consumidos se eliminan sólo después del
reconocimiento post-enqueue. Al iniciar, el janitor retira progress expirado,
completions huérfanos ya fuera de retención y directorios vacíos. Nunca borra un
pending sin completion: incluso después de siete días sigue visible y cancelable
por reconciliación explícita.

### Modelo: rol de agente vs spec real

`agent_runtime_session.model.spec` acepta exclusivamente un modelo efectivo del
registry OMP, por ejemplo `openai-codex/gpt-5.6-sol`. No acepta nombres de roles
de la tool Task como `luna-low`, ni IDs sintetizados como
`openai-codex/gpt-5.6-luna-low`.

Si el caller conoce el rol deseado pero no comprobó el spec efectivo y su
effort, debe usar `{ "mode": "inherit" }` o consultar una superficie nativa que
resuelva el modelo antes de lanzar. Nunca debe convertir el nombre de un agente
en un model spec por convención.

### Después del lanzamiento

Un resultado `ok` con `paneId`, `sessionId` y `model` confirma que la sesión hija
recibió el prompt, empezó y quedó registrada para retorno. El parent muestra el
último estado recibido en el widget de orquestación y vuelve a su trabajo;
cuando la hija finaliza, el runtime lo reanuda con su resultado. No debe pedir al
usuario que vigile tabs ni monitorear panes con Computer Use, screenshots,
scrollback o polling visual.

Un host, placement o request no soportado devuelve `unsupported`. No debe activar investigación de source, procesos, sesiones o fallbacks ad hoc.

El `cwd` de lanzamiento debe existir antes de crear el pane; Habitat lo valida
y devuelve `unsupported` sin tocar WezTerm si falta. Si el trabajo debe crear
un directorio nuevo, la sesión arranca en su padre existente y lo crea después.

WezTerm asigna la identidad del pane desde el entorno real del proceso creado.
`scripts/runtime-child-bootstrap.ts` conserva la frontera: recibe por argv sólo
launch id, nonce, parent session id, título, conducta al salir y agent dir;
deriva pane e instancia del child, limpia marcadores de recursión y arranca OMP.
El prompt no entra en ese argv. Si el request exige `keep-open`, después de OMP
el bootstrap abre el shell interactivo sin propagar metadata del lanzamiento.

## Prompt y readiness

La detección de contexto ya valida el pane origen contra la instancia. El
adapter no repite ese preflight antes de `split-pane`/`spawn`: la propia CLI
recibe instancia y pane explícitos y falla si dejaron de existir. Después de
crear, `list --format json` puede quedar brevemente detrás del resultado de la
CLI; el adapter reintenta de forma acotada sólo la aparición del pane nuevo
antes de registrar ownership o ejecutar rollback.

Los dos acks siguen siendo la readiness de la sesión OMP. Cada etapa admite
hasta 45 segundos para absorber startups transitorios sin abrir un segundo
pane. El polling limita la última espera al deadline y realiza una lectura final
en ese borde; si el ack no llega, cierra exactamente el pane owned y limpia el
canal y los markers. No existe retry que cree otro pane.

Antes de crear el pane, el parent abre un endpoint HTTP efímero, one-shot y
tokenizado sobre `127.0.0.1`. El entorno del child recibe sólo la URL opaca y el
SHA-256 esperado, nunca el texto. En `session_start`, la extensión hija publica
el primer ack, consume el prompt por loopback, valida longitud y hash, elimina
las variables del proceso y llama `pi.sendUserMessage()`. Esto inicia el turno
sin simular input de teclado.

Los procesos auxiliares pueden heredar metadata `OMP_RUNTIME_*` capturada antes
de que el proceso OMP principal la limpie. Todo probe que lance otro OMP debe
retirarla de su entorno; `scripts/audit.ts` lo hace antes del smoke RPC. Esto
evita que un proceso anidado intente reutilizar una URL one-shot ya cerrada.

Si el canal falla, el child publica `prompt_channel_failed` en el segundo marker
y el parent falla inmediatamente en vez de esperar un timeout opaco.
`before_agent_start` publica el segundo ack normal con SHA-256, nunca con el
texto. El parent valida launch id, nonce, pane, session id distinta, modelo y
hash antes de devolver éxito. Un ack rechazado conserva sólo el código de la
validación fallida (`model_mismatch`, `prompt_hash_mismatch`, etc.); no persiste
valores, prompt, URL ni nonce.

La publicación atómica aplica permisos al archivo temporal antes del `rename`.
Ese rename es el último acceso del publisher al path final: el consumer puede
claimarlo inmediatamente y no existe un `chmod` posterior que compita contra su
rename. El mismo orden rige los mailboxes de completion.

La tool devuelve fallos estructurados con etapa, creación del pane, confirmación
de `session_start`, rollback y último código de ack rechazado. El canal se cierra
después de una única lectura válida o durante rollback; el prompt no aparece en
argv, env, terminal, logs, artifacts ni markers.

El schema mantiene `cwd`, `prompt`, `pane`, freshness, persistencia, modelo y
focus obligatorios. `placement` y `workflow` son opcionales; omitir `workflow`
conserva el lanzamiento legacy y omitir `placement` normaliza a
`{ kind: "split", direction: "right", percent: 50 }`. `placement` acepta además
`{ kind: "tab" }` y `{ kind: "window" }`. Ambos objetos son closed-world: una
forma explícita inválida falla como `unsupported` antes del launch.

## Ownership y rollback

El adapter sólo puede enfocar o cerrar un pane creado por esa instancia de la
operación. Un window placement crea una ventana nueva cuyo primer pane queda
bajo el mismo ownership; nunca mueve el pane origen. Ese handle habilita dos
cierres seguros: rollback ante fallo posterior a la creación y cleanup opt-in
tras un completion ya entregado. Si creación, título, handshake o registro de
completion fallan, intenta cerrar exactamente el pane owned —y con él la ventana
vacía— y devuelve `rollback: completed|failed`. Nunca crea otro pane como retry,
cierra el origen, adopta un pane tras reload ni usa el último pane enfocado como
fallback.

Cerrar un pane owned que ya terminó se considera rollback satisfecho. WezTerm
puede devolver `no such pane` cuando el programa child falla y el pane desaparece
antes de la limpieza; eso no debe ocultar el error primario.

## Discovery global

La fuente durable vive en `extensions/agent-runtime-habitat.ts`. El
`config.yml` global la declara por path absoluto y `.omp/config.yml` repite la
misma fuente para este workspace, porque cualquier lista explícita de
`extensions` reemplaza la lista heredada:

```yaml
extensions:
  - C:/dev/omp/extensions/agent-runtime-habitat.ts
```

No se mantiene un wrapper bajo `~/.omp/agent/extensions/`: con configuración
global explícita era inerte y constituía una segunda ruta de resolución.
`bun run audit` prueba el import con un agent dir temporal, sin prompt ni
modelo, y los tests usan runner fake para que ninguna prueba unitaria controle
WezTerm real.

## Verificación

```powershell
cd C:/dev/omp
bun test
bun run audit
```

Smoke vivo del 2026-08-11: pane `76` abrió pane `118` dentro de window `0`, tab
`33`; creó session `019ff29a-6775-7000-bf11-aa5bcaa23d13` con
`openai-codex/gpt-5.6-sol`, confirmó ambos acks y entregó por el canal efímero un
prompt Unicode de 9165 caracteres. La sesión respondió exactamente
`IPC_LONG_OK`.

Smoke vivo del 2026-08-25: dispatcher pane `90` quedó en window `0`; un window
placement creó el orquestador pane `91` y su worker tab pane `92` juntos en la
window dedicada `3`. Los títulos quedaron
`os: Smoke dispatcher 4: Orquestador smoke` y
`os: Smoke dispatcher 4: Orquestador smoke: Worker smoke`. La worker respondió
`WORKER_WINDOW_OK`; el mailbox reanudó al orquestador, que respondió
`ORCHESTRATOR_RETURN_OK`; ese retorno reanudó al dispatcher y llegó al parent
original como `DISPATCHER_RETURN_OK`, sin aviso manual.

Smoke vivo del 2026-08-26: owner pane `184`, session
`01a03f67-474d-7000-a646-e4f921991b52`, publicó `working`, lanzó worker pane
`185`, session `01a03f67-94e6-7000-a47c-35ae50df1462`, y publicó `waiting`.
El worker devolvió `WORKER_STATUS_6_OK`; el widget cambió a integración con cero
pendientes, el owner publicó `working`, respondió
`ORCHESTRATION_STATUS_6_OK` y el widget se retiró al cerrar el loop. El retorno
upstream eliminó el pending del owner; los artifacts de smoke se limpiaron.

Smoke vivo del 2026-08-31: el repro produjo un owner con worker ya integrado y
respuesta final persistida, pero una continuación automática consumió la marca
in-memory y dejó el retorno upstream sin publicar mientras `keep-open` conservaba
el pane. El smoke posterior atravesó owner → worker → follow-up con
continuaciones de Advisor entre turnos; el worker devolvió
`RUNTIME_SEMANTIC_CHILD_OK`, el owner respondió
`RUNTIME_SEMANTIC_OWNER_OK`, ambos mailboxes quedaron sin pending y
`closeOnComplete` retiró los dos panes. Los tests focales reproducen además
reentrega previa al acknowledgment, enqueue fallido, cleanup fallido y el orden
enqueue → acknowledgment → cierre.

El smoke vivo requiere pedido explícito. Para splits debe demostrar mismo tab,
nuevo pane, session id distinta, modelo esperado y acknowledgment exacto. Para
orquestación visible debe demostrar ventana dedicada, tabs agrupados, títulos
genealógicos y retorno automático transitivo hasta el parent.
