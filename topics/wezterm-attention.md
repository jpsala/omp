# WezTerm Attention

Status: active
Summary: Productor OMP global de marcadores atómicos de atención por pane, cargado desde una única fuente durable.

## Alcance

La extensión no configura WezTerm, no lee su configuración y no conserva estado de usuario. Sólo publica un marcador pequeño para el pane indicado por `WEZTERM_PANE`.

El perfil global carga `extensions/wezterm-attention.ts` por path directo y
`.omp/config.yml` repite esa fuente por semántica de reemplazo; no existe un
wrapper de discovery.

## Procedencia y saneamiento

Se portó la extensión activa existente como código fuente, no su directorio de estado. La copia no contiene paths de máquina, tokens, auth, sesiones ni contenido del usuario. Se preservaron las propiedades útiles:

- validar pane numérico;
- exigir un directorio absoluto cuando se sobreescribe;
- write + rename atómico;
- limpieza best-effort del temporal;
- TTL acotado y configurable para `thinking`;
- no romper OMP si la integración visual falla.

## Lifecycle

| Evento OMP | Marcador |
| --- | --- |
| `agent_start` | `thinking` |
| `tool_execution_start` | `thinking` |
| `session_stop` | `stop` |
| tool de pregunta, al iniciar | `notify` con label |
| tool de pregunta, tras resultado | `thinking` |

Se usa `session_stop` como settle de la sesión principal. La extensión no intenta inferir finalización desde mensajes ni intercepta el flujo del agente.

## Carga

[Extension loading](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md) documenta fuentes TypeScript y discovery/configuración local. En este workspace `.omp/config.yml` contiene un único path relativo a la fuente durable y deshabilita por id el editor ambient incompatible. No hay package, copia generada ni instalación.

La extensión registra `/wezterm-attention-status`, un diagnóstico real que informa si el pane actual tiene target válido. `bun run audit` lanza OMP RPC con estado temporal, consulta los comandos disponibles y exige ese nombre; así verifica discovery + import sin prompt de modelo ni acceso al estado privado.

## Consumidor

El consumidor WezTerm debe tratar el marcador como datos no confiables: parsear JSON, comprobar `updated_at`/`ttl_ms` y degradar a estado normal si falta o expira. Ese consumidor queda fuera de este laboratorio porque su configuración de usuario no debe copiarse aquí.
