# Agent Runtime Habitat

Status: active
Summary: Contexto runtime tipado y lanzamiento OMP fresco sobre un pane WezTerm poseído, con handshake y rollback.

## Contrato

`extensions/agent-runtime-habitat.ts` registra dos tools globales:

- `agent_runtime_context`: lectura sanitizada de harness, host, ubicación y capacidades.
- `agent_runtime_session`: lanzamiento local explícito de una sesión hija OMP.

La extensión no autoriza lanzamientos por estar disponible. La tool mutante conserva los gates del perfil y sólo opera ante una solicitud directa.

### Handoff corto de implementación

`/plan-implement-short [objetivo]` dispara un turno compacto en la sesión actual:
el parent cierra alcance, contratos e invariantes, produce el plan completo con
la menor cantidad de pasos y entrega un único prompt autocontenido a un
implementador. Sin argumento usa la solicitud accionable inmediatamente
anterior; sin objetivo recuperable pide sólo ese dato y no abre una sesión.

El comando lanza exactamente una sesión fresh saved, hereda modelo y cwd, abre
un split derecho al 50% y conserva el foco en el parent. El pane recibe un
título corto `Implementador · <objetivo>` y `onExit: "keep-open"`: salir de OMP
devuelve a un PowerShell limpio en el mismo split, en vez de eliminarlo. Los
pasos sólo se marcan paralelos cuando son independientes; el implementador puede
delegarlos con contratos ya cerrados. El parent no implementa, no abre panes
adicionales ni monitorea al child después del handshake.

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

## Primera implementación

- Harness: OMP 17.2.13.
- Host: WezTerm en Windows.
- Ubicación: instancia, window, tab y pane se validan por `wezterm cli list --format json`.
- Split: `split-pane` con pane origen explícito; tab: `spawn` con pane origen explícito.
- Fresh saved: overlay `runtime/omp-fresh-session.yml` con `autoResume: false`.
- Fresh ephemeral: `--no-session`.
- Selección de modelo: el request siempre declara `explicit` o `inherit`;
  `inherit` resuelve el modelo actual.

### Ciclo de vida y nombre de panes

Todo request de `agent_runtime_session` declara `pane: { title, onExit }`.
`placement` es opcional: si se omite, el runtime abre un split derecho al 50%;
una ubicación explícita conserva soporte para tab u otra dirección. `title` es
un nombre breve, sin caracteres de control, que el bootstrap publica mediante
`OSC 1`; con la configuración actual de WezTerm aparece como título del tab
cuando ese pane está activo.

`onExit: "close"` conserva el comportamiento nativo: al terminar OMP también
termina el proceso principal y WezTerm elimina el pane. `onExit: "keep-open"`
inicia un shell interactivo después de OMP, en el mismo `cwd`; Windows usa
PowerShell 7 y otros hosts usan `$SHELL` o `/bin/sh`. El shell recibe un entorno
limpio: no hereda metadata `OMP_RUNTIME_*`, el canal efímero del prompt ni
marcadores de recursión. Cerrar explícitamente el pane en WezTerm siempre lo
elimina.

`persistence: "saved"|"ephemeral"` gobierna el almacenamiento de la sesión OMP;
no gobierna la vida del pane. `placement` gobierna únicamente ubicación y tamaño.


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
recibió el prompt y empezó. El parent debe volver a su trabajo o esperar el
handoff del usuario; no debe monitorear el pane con Computer Use, screenshots,
lectura de scrollback ni polling visual salvo que JP lo pida explícitamente.

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

La tool devuelve fallos estructurados con etapa, creación del pane, confirmación
de `session_start`, rollback y último código de ack rechazado. El canal se cierra
después de una única lectura válida o durante rollback; el prompt no aparece en
argv, env, terminal, logs, artifacts ni markers.

El schema mantiene `cwd`, `prompt`, `pane`, freshness, persistencia, modelo y
focus obligatorios. `placement` es el único campo opcional y su ausencia se
normaliza a `{ kind: "split", direction: "right", percent: 50 }`. Un objeto
explícito inválido sigue fallando cerrado y devuelve la forma esperada.

## Ownership y rollback

El adapter sólo puede enfocar o cerrar un pane creado por esa instancia de la
operación. Si la creación funciona pero la validación posterior falla, intenta
cerrar exactamente ese pane y devuelve `rollback: completed|failed` junto con el
error primario. Nunca crea otro pane como retry.
Nunca debe cerrar el pane origen ni usar el último pane enfocado como fallback.

Cerrar un pane owned que ya terminó se considera rollback satisfecho. WezTerm
puede devolver `no such pane` cuando el programa child falla y el pane desaparece
antes de la limpieza; eso no debe ocultar el error primario.

## Discovery global

La fuente durable vive en `extensions/agent-runtime-habitat.ts`. El
`config.yml` global la declara por path absoluto porque una lista explícita de
`extensions` reemplaza el discovery implícito del perfil:

```yaml
extensions:
  - C:/dev/omp/extensions/agent-runtime-habitat.ts
```

El wrapper mínimo en `~/.omp/agent/extensions/agent-runtime-habitat.ts`
conserva discovery para perfiles sin lista explícita, pero no sustituye esa
entrada. `bun run audit` prueba el import con un agent dir temporal, sin prompt
ni modelo, y los tests usan runner fake para que ninguna prueba unitaria
controle WezTerm real.

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

El smoke vivo requiere pedido explícito: debe demostrar mismo tab, nuevo pane, session id distinta, modelo esperado y acknowledgment exacto del prompt.
