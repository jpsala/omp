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
