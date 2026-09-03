# Development

## Requisitos

- OMP disponible como `omp`.
- Bun disponible para scripts y tests.
- WezTerm es opcional: sólo se necesita para la señal visual y las ventanas de observación.
- No hay instalación de dependencias del proyecto.

## Comandos focales

```powershell
# Regenerar el índice durable de topics
bun run index

# Comprobar límites, secretos, config e import/discovery real
bun run audit

# Contrato observable del cliente RPC (servidor fake local, sin proveedor)
bun test

# Ejercicio real; usa el modelo/auth configurados y puede tener coste
bun examples/rpc-once.ts "Responde sólo: ok"

# Abrir OMP con discovery local
omp
```

## Deploy downstream de OMP en Windows

El único launcher canónico es `~/.bun/bin/omp.exe`. Para publicar un build,
pasar siempre el artifact exacto ya compilado y verificado:

```powershell
bun run deploy:omp -- C:\ruta\al\build\omp.exe
```

El comando sin artifact falla: un nombre implícito puede apuntar a un build
granular anterior y degradar silenciosamente el launcher. El deploy valida que
el artifact explícito sea PE, copia y valida un staging en el mismo directorio
antes de retirar `omp.com`, y recién entonces rota atómicamente `omp.exe`. Si el
staging o el cutover fallan, restaura el launcher anterior. Backups bloqueados
por sesiones vivas quedan con sufijo no ejecutable y se limpian en la próxima
corrida. `bun run audit` falla si reaparece `omp.com`, porque Windows lo
resolvería antes que `.exe`.

## Extensión WezTerm Attention

La extensión escribe un marcador JSON por pane en un directorio absoluto. Por defecto usa `~/.local/state/wezterm-attention`; `WEZTERM_ATTENTION_DIR` permite apuntar al directorio que ya consume la configuración de WezTerm. Si `WEZTERM_PANE` no es un entero o el directorio configurado no es absoluto, no escribe.

Contrato del marcador:

- `type`: `thinking`, `stop` o `notify`.
- `source`: `omp`.
- `updated_at`: epoch en milisegundos.
- `ttl_ms`: sólo en `thinking`.
- `label`: sólo cuando OMP espera una respuesta.

La escritura usa archivo temporal y rename para que el consumidor no vea JSON parcial. Los fallos de integración no interrumpen el agente.

`/wezterm-attention-status` es un diagnóstico local mantenible y también la señal observable usada por el audit para probar que OMP descubrió e importó la extensión.

## Cliente RPC

`OmpRpcClient.start()` espera `ready` y negocia protocolo 2 si el servidor lo anuncia, bajo timeout finito o `startupSignal`; cleanup escala SIGTERM→SIGKILL con esperas acotadas y siempre resetea transporte. `request()` correlaciona respuestas por id y rechaza comandos que crearían un segundo flujo agent sin correlación. `prompt()` conecta el handler de completion al crearla para que una failure previa al ack no produzca rejection huérfana, y espera tanto el ack como una señal de settle válida:

- `response.data.agentInvoked === false`;
- `prompt_result.agentInvoked === false` con el mismo id; o
- `agent_end` cuando `isTerminal !== false`.

`agent_end` con `isTerminal: false` es intermedio. El decoder rechaza chunks intercalados, fuera de orden, base64 no canónico, longitudes falsas, UTF-8 inválido, segmentos mayores de 256 KiB y frames físicos/lógicos que superen los límites anunciados.

Una failure sin id rechaza todos los pending como error de correlación, nunca el request “más probable”. El audit lanza `omp --mode rpc` sin prompt/modelo, con `PI_CODING_AGENT_DIR` temporal y borrado al terminar; exige `ready`, consulta `get_available_commands`, comprueba `/wezterm-attention-status` y falla ante `extension_error` o import inválido.

## OMP Fleet

`extensions/omp-fleet.ts` registra `/fleet` y el perfil global carga esa fuente por path directo; `.omp/config.yml` la repite porque su lista explícita reemplaza la global. No hay wrapper de discovery. El autocomplete nativo sugiere subcomandos y, cuando existen, run ids, repos, requests pendientes y modos de ventana. `examples/fleet-publication.json` contiene `goal`, mensajes por repo, `window: "tabs"` y concurrencia explícita; sus paths absolutos deben existir antes de usarlo:

```text
/fleet status
/fleet run examples/fleet-publication.json
```

El primer comando no inicia workers. El segundo crea un RPC por repo habilitado, invoca los modelos configurados y puede tener coste. Los comandos mutantes se enrutan con run id explícito: `/fleet send <run-id> <repo> <message>`, `/fleet follow-up <run-id> <repo> <message>`, `/fleet approve <run-id> <repo> <request-id>`, `/fleet deny <run-id> <repo> <request-id>` y `/fleet cancel <run-id> <repo|all>`.

El scheduler admite hasta 32 repos habilitados, concurrencia de 1 a 16 y default 4. Sólo entrega a los workers el allowlist de entorno documentado en `topics/omp-fleet.md`. Los observers de `scripts/fleet-observer.ts` leen `artifacts/fleet/<run-id>/` y no poseen el ciclo de vida RPC. Estos artifacts excluyen texto crudo de resultados y errores.

## Actualización de OMP

1. Consultar `omp update --check`; no ejecutar el updater mutante sobre el build
   granular.
2. Clonar el tag oficial exacto, releer `topics/ux-matrix.md` y comparar el
   patch vigente contra settings, transcript, extensiones y session maintenance.
3. Retirar únicamente del patch lo que upstream ya haya incorporado; resolver
   los conflictos preservando la semántica nueva del tag.
4. Ejecutar tests focales y el check completo de `packages/coding-agent`.
5. Compilar el binario Windows con el addon Win32 publicado de la misma versión.
6. Publicar exclusivamente con `bun run deploy:omp -- <artifact>` y hacer un
   smoke TUI real del selector granular y `/windows-input`.
7. Regenerar el patch fijado al tag, actualizar evidencia durable y ejecutar
   `bun run index`, `bun run audit` y `bun test`.
