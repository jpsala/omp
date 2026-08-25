# OMP Fleet

Status: active
Summary: Ejecución multi-repositorio por RPC con control explícito, aprobaciones en vivo y observadores WezTerm sin propiedad del ciclo de vida.

## Fuente y discovery

`extensions/omp-fleet.ts` es la única fuente durable de `/fleet`. El perfil global la carga por path absoluto y `.omp/config.yml` repite la fuente porque una lista project-local explícita reemplaza la global; no existe un wrapper de discovery. La implementación usa módulos `node:` y las APIs públicas de extensiones de OMP, sin paquetes de terceros.

El autocomplete nativo completa los subcomandos (`run`, `status`, `send`, `follow-up`, `approve`, `deny`, `cancel`, `results`, `window`, `clear`) y agrega contexto vivo cuando existe: run ids, repositorios, request ids pendientes y `--window=tabs|dashboard|none`.

## Configuración JSON

`/fleet run` recibe un archivo JSON con este contrato cerrado:

- `name`: nombre no vacío del fleet;
- `goal`: instrucción común no vacía;
- `window`: `none`, `dashboard` o `tabs`;
- `maxConcurrency`: entero opcional de 1 a 16; el default es 4;
- `repos`: objeto no vacío cuyas claves nombran repositorios y cuyos valores aceptan `cwd` absoluto, `message` opcional y `enabled` opcional.

Se permiten como máximo 32 repos habilitados y al menos uno debe quedar habilitado. Los campos desconocidos se rechazan; cada `cwd` debe ser absoluto y no contener un segmento `..`. Cada prompt contiene primero `goal` y después, cuando existe, `message` bajo `Repository-specific instructions:`. El ejemplo mantenido y listo para adaptar está en `examples/fleet-publication.json`:

```powershell
Set-Location C:\dev\omp
omp
```

Ya dentro de OMP:

```text
/fleet run examples/fleet-publication.json
```

Ese ejemplo usa `C:/dev/omp` y `C:/dev/infra`; hay que cambiar los paths si esos workspaces no existen.

## Comandos operativos

```text
/fleet run <config.json> [--window=none|dashboard|tabs]
/fleet status [run-id]
/fleet send <run-id> <repo> <message>
/fleet follow-up <run-id> <repo> <message>
/fleet approve <run-id> <repo> <request-id>
/fleet deny <run-id> <repo> <request-id>
/fleet cancel <run-id> <repo|all>
/fleet results [run-id]
/fleet window [run-id]
/fleet clear
```

`status`, `results` y `window` aceptan el último run de la sesión cuando se omite el id. Esos comandos sólo operan sobre runs registrados en la sesión OMP actual; los artifacts de sesiones anteriores siguen disponibles para lectura local, pero no reconstituyen workers. Todos los comandos que mutan workers o responden solicitudes exigen `run-id`, para que el enrutamiento nunca dependa del orden ni del run más reciente. `/fleet status` sin runs sólo muestra el estado vacío; no crea workers ni invoca un modelo. `/fleet clear` retira el status y widget persistentes sin cancelar ni modificar runs.

`status` muestra estado, conteos, errores y solicitudes pendientes con salida acotada. `results` muestra sólo el estado final de cada worker y errores accionables; nunca vuelca el texto del asistente. Un run completamente exitoso limpia automáticamente el status y widget vivos y deja una única notificación breve. Los artifacts sanitizados siguen siendo la evidencia durable local.

## Contrato RPC y aprobaciones

Cada repo habilitado posee exactamente un `OmpRpcClient` con su propio `cwd`. El scheduler inicia como máximo `maxConcurrency` workers, mantiene los fallos aislados y siempre cierra cada transporte. El flujo de un worker es `start()` → `prompt()` → `get_last_assistant_text` → `close()`; el settle de prompt sigue el contrato de `topics/rpc-client.md`, no el mero ack.

`send` usa `steer` y `follow-up` usa `follow_up`, siempre sobre el cliente del repo nombrado. `cancel` omite un worker `pending` sin crear su cliente, cierra el transporte de uno `starting` y envía `abort` RPC a uno `running`. Las solicitudes RPC `extension_ui_request` de tipo `confirm`, `select`, `input` o `editor` quedan pendientes. No hay aprobación automática: `/fleet approve` abre la UI administrada correspondiente para revisión/valor, `/fleet deny` responde negativamente, y la respuesta `extension_ui_response` conserva el id original.

Los workers reciben sólo estas variables del proceso anfitrión: `APPDATA`, `COLORTERM`, `COMSPEC`, `HOME`, `LANG`, `LC_ALL`, `LOCALAPPDATA`, `PATH`, `PATHEXT`, `SHELL`, `SYSTEMROOT`, `TEMP`, `TERM`, `TMP`, `USERPROFILE`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` y `XDG_DATA_HOME`. No se copian credenciales ni variables de inyección de código.

## Artifacts y observadores

Cada run escribe `artifacts/fleet/<run-id>/events.jsonl`, `snapshot.json` y `results.json`. Son artifacts locales sanitizados: conservan ids, estados, conteos, timestamps y resúmenes de frames; no persisten texto crudo de resultados, errores, prompts, mensajes de UI, opciones, credenciales ni entorno. `results.json` contiene sólo `repo`, estado exitoso y `completedAt`.

`window:"dashboard"` abre una ventana WezTerm dedicada con el dashboard; `window:"tabs"` añade una pestaña por repo; `none` no abre nada automáticamente. `/fleet window [run-id]` abre al menos el dashboard aun cuando el modo configurado sea `none`. El launcher usa argv directo, nunca shell:

```text
executable: wezterm.exe (Windows) o wezterm (otras plataformas), resuelto mediante PATH
argv dashboard: ["cli", "spawn", "--new-window", "--cwd", <run-directory>, "--", "bun", <absolute-observer-script>, "--run", <run-id>, "--root", <absolute-fleet-root>, "--mode", "dashboard"]. No se asigna un workspace nuevo: WezTerm oculta ventanas de workspaces inactivos, por lo que omitirlo mantiene visible la ventana dedicada.
argv repo: ["cli", "spawn", "--pane-id", <dashboard-pane-id>, "--cwd", <repo-cwd>, "--", "bun", <absolute-observer-script>, "--run", <run-id>, "--root", <absolute-fleet-root>, "--mode", "repo", "--repo", <repo>]
```

El stdout exitoso de `spawn` debe ser un pane id decimal. Ese id se reutiliza con `set-window-title` y `set-tab-title`; `tabs` ancla cada observer de repo al pane del dashboard.

Los procesos `fleet-observer.ts` sólo leen artifacts. No abren, controlan ni cierran RPC workers; cerrar una pestaña o ventana no cancela el run. Un fallo de WezTerm produce un warning y los workers continúan.

## Verificación y coste

`bun run index`, `bun run audit` y `bun test` son comprobaciones locales sin proveedor. Abrir OMP y ejecutar `/fleet status` comprueba discovery sin iniciar workers. `/fleet run ...` sí inicia un modelo configurado por repo habilitado y puede tener coste; `send` y `follow-up` pueden prolongar ese trabajo. Las aprobaciones y cancelaciones conservan sus gates explícitos y no autorizan otros efectos externos por sí solas.
