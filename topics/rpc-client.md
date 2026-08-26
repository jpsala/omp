# OMP RPC client v2

Status: active
Summary: Contrato de referencia para stdio JSONL, correlación, reassembly v2 y settle correcto.

## Fuente normativa

La referencia primaria es [RPC Protocol Reference](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md). El contrato se revalidó con OMP 18.0.6:

- `src/modes/rpc/rpc-types.ts` para comandos/frames;
- `src/modes/rpc/rpc-frame.ts` para límites y validación de chunks;
- `src/modes/rpc/rpc-client.ts` como cliente oficial de comparación.

## Transporte

1. Lanzar `omp --mode rpc` sobre stdio.
2. Leer un objeto JSON por línea.
3. Esperar `ready`; si anuncia 2, enviar `negotiate_protocol` con id.
4. Mantener comandos inbound como JSONL sin chunking.
5. En v2, reensamblar secuencias stdout `rpc_chunk` antes de despachar el objeto lógico.

El decoder mantiene como máximo una secuencia. Exige ids/índices consistentes y ordenados, base64 canónico, longitud declarada exacta, límite anunciado, UTF-8 estricto y objeto JSON final.

## Correlación

Cada request generado recibe un string id único. Las respuestas normales se resuelven por ese id, no por orden de llegada. Una failure sin id (`unknown`/`parse` en el contrato oficial) no se atribuye por conjetura: rechaza todos los pending con un error de correlación explícito para que ninguno quede infinito.

## Ack versus settle

El ack de `prompt` sólo confirma aceptación. La operación de alto nivel finaliza por:

- respuesta o `prompt_result` con el mismo id y `agentInvoked: false`; o
- `agent_end` con `isTerminal !== false`.

`isTerminal: false` indica trabajo posterior programado. La ausencia del campo es compatible con runtimes anteriores y se considera terminal. Un error tardío con el mismo id después del ack rechaza el prompt activo.

El cliente limita a uno los prompts de alto nivel activos porque los eventos `agent_end` no llevan request id. Mientras uno está activo, `request()` rechaza `prompt`, `abort_and_prompt`, `steer` y `follow_up`; `abort` y requests de estado siguen disponibles.

## Límites

Los límites físicos y de reassembly se toman de `ready`, con defaults del protocolo documentado (1 MiB y 64 MiB). El cliente no acumula chunks por encima del límite. `start()` impone timeout finito (y acepta `startupSignal`); ante fallo intenta SIGTERM por 1 s, escala a SIGKILL y espera como máximo 2 s más antes de resetear decoder/ready/pending.

## No dependencia downstream

`src/omp-rpc-client.ts` usa sólo módulos `node:` y no importa paquetes OMP. Los consumidores pueden estudiar o copiar el patrón explícitamente; otros repos no lo reciben como runtime dependency.
