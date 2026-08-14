# Agent Runtime Habitat

Status: active
Summary: Contexto runtime tipado y lanzamiento OMP fresco sobre un pane WezTerm poseído, con handshake y rollback.

## Contrato

`extensions/agent-runtime-habitat.ts` registra dos tools globales:

- `agent_runtime_context`: lectura sanitizada de harness, host, ubicación y capacidades.
- `agent_runtime_session`: lanzamiento local explícito de una sesión hija OMP.

La extensión no autoriza lanzamientos por estar disponible. La tool mutante conserva los gates del perfil y sólo opera ante una solicitud directa.

## Primera implementación

- Harness: OMP 17.2.13.
- Host: WezTerm en Windows.
- Ubicación: instancia, window, tab y pane se validan por `wezterm cli list --format json`.
- Split: `split-pane` con pane origen explícito; tab: `spawn` con pane origen explícito.
- Fresh saved: overlay `runtime/omp-fresh-session.yml` con `autoResume: false`.
- Fresh ephemeral: `--no-session`.
- Selección de modelo: el request siempre declara `explicit` o `inherit`;
  `inherit` resuelve el modelo actual.


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
launch id, nonce, parent session id y agent dir; deriva pane e instancia del
child, limpia marcadores de recursión y arranca OMP. El prompt no entra en ese
argv.

## Prompt y readiness

Antes de crear el pane, el parent abre un endpoint HTTP efímero, one-shot y
tokenizado sobre `127.0.0.1`. El entorno del child recibe sólo la URL opaca y el
SHA-256 esperado, nunca el texto. En `session_start`, la extensión hija publica
el primer ack, consume el prompt por loopback, valida longitud y hash, elimina
las variables del proceso y llama `pi.sendUserMessage()`. Esto inicia el turno
sin simular input de teclado.

`before_agent_start` publica un segundo ack con SHA-256, nunca con el texto. El
parent valida launch id, nonce, pane, session id distinta, modelo y hash antes de
devolver éxito. El canal se cierra después de una única lectura válida o durante
rollback; el prompt no aparece en argv, env, terminal, logs, artifacts ni
markers.

La tool publica el schema anidado completo de `placement` y `model`; todos los
campos de lanzamiento son requeridos. Esto evita que el agente improvise
sinónimos como `type`/`size`, que el traductor V1 rechaza. Un request inválido
devuelve además la forma exacta esperada.

## Ownership y rollback

El adapter sólo puede enfocar o cerrar un pane creado por esa instancia de la operación. Si la creación funciona pero la validación posterior falla, intenta cerrar exactamente ese pane. Si también falla el rollback, devuelve ambos errores en un `AggregateError` y elimina cualquier ownership lógico.

Nunca debe cerrar el pane origen ni usar el último pane enfocado como fallback.

Cerrar un pane owned que ya terminó se considera rollback satisfecho. WezTerm
puede devolver `no such pane` cuando el programa child falla y el pane desaparece
antes de la limpieza; eso no debe ocultar el error primario.

## Discovery global

La fuente durable vive en `extensions/agent-runtime-habitat.ts`. El perfil global contiene únicamente:

```ts
export { default } from "file:///C:/dev/omp/extensions/agent-runtime-habitat.ts";
```

`bun run audit` prueba el import con un agent dir temporal, sin prompt ni modelo, y los tests usan runner fake para que ninguna prueba unitaria controle WezTerm real.

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
