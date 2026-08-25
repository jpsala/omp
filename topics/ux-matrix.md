# UX surfaces: native, port or discard

Status: active
Summary: Matriz durable de Windows input, status/cuota, renderers y atención WezTerm basada en OMP 17.2.7.

## Criterio

- **native**: OMP actual ya posee el contrato; configurar o usar sin mantener una segunda implementación.
- **portar**: la integración aporta una capacidad externa concreta que OMP no sustituye.
- **descartar**: no llevar al laboratorio una implementación paralela o legacy.

## Matriz

| Superficie | Clasificación | Evidencia verificada | Acción |
| --- | --- | --- | --- |
| Windows input, clipboard y perfiles | **portar sobre renderer nativo** | En 17.2.11, `src/utils/clipboard.ts` implementa lectura PowerShell nativa/WSL de texto e imagen; `src/modes/controllers/input-controller.ts` conecta paste de texto/imagen al editor; `@oh-my-pi/pi-tui/src/terminal.ts` habilita VT input, UTF-8 y mitigaciones ConPTY en `win32`. Smoke 2026-08-20 sobre OMP 17.3.8: la carga directa de `extensions/windows-input.ts` conserva autocomplete `/` y convive con `/profiles`; el wrapper global reexportado no carga el editor porque resuelve `pi-natives` 17.4.0 sin addon Win32 desde el cache de Bun. | Mantener el editor sobre OMP nativo y cargar la fuente directa; no considerar operativo el wrapper global hasta eliminar esa frontera de resolución. Dejar la selección de modelos al hub y keybindings nativos. |
| Status/footer | **native**; **descartar** un footer paralelo | [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md#appearance-and-terminal) documenta `statusLine.preset`, separators y custom segments. En 17.2.7, `src/modes/components/status-line/presets.ts` y `segments.ts` implementan el componente. | Hablar de `statusLine`, el nombre real. Configurar presets/segments sólo cuando exista un objetivo medible. |
| Quota/usage en status | **native** | `src/modes/components/status-line/segments.ts` registra `usage` y muestra ventanas 5h/7d y resets desde `SegmentContext.usage`; `omp usage` también existe en la CLI 17.2.7. | Usar el segmento `usage` o `omp usage`; no consultar auth ni crear un poller propio. |
| Modelos y esfuerzos rápidos | **native** | `modelRoles` acepta selectores con sufijo de effort; `modelTags` nombra roles; `cycleOrder` es el ciclo nativo de `Ctrl+P`/`Ctrl+Shift+P`; `/models` permite editar Roles y `Alt+M` selecciona el modelo de la sesión. | Usar `Alt+M`/`/models` como única superficie local de selección; no agregar favoritos, renderers ni hotkeys paralelos. Reservar overlays/perfiles para Task, `prewalk` y concurrencia. |
| Renderers | **native** | [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md#tool-callresult-renderer) documenta `renderCall`/`renderResult`, message renderer y thinking renderer. `omp gallery` es el visor nativo de estados de tool renderers en 17.2.7. | Mantener renderers dentro del contrato nativo sólo cuando una tool local los necesite. No portar un renderer general. |
| WezTerm Attention | **portar** | El productor existente usa eventos OMP (`agent_start`, `tool_execution_start`, `session_stop`, `tool_call`, `tool_result`) y un marcador atómico consumible por WezTerm. [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) documenta el factory y los eventos. | Fuente saneada en `extensions/wezterm-attention.ts`; carga project-local en `.omp/config.yml`. |

## Mouse en WinInput

El `Editor` ofrece hit-testing opt-in contra sus filas realmente renderizadas,
pero WinInput no activa ese tracking en el prompt. La prueba sobre el hardware
real mostró que mantener mouse reporting para click/drag impide el scroll
continuo de la rueda sin modificador; los bindings de WezTerm con
`mouse_reporting = true` no resolvieron el conflicto. Se prioriza la rueda
nativa y la selección de texto del terminal.

WinInput reserva `Ctrl+Z` para undo de texto y snapshots atómicos de selecciones.
`Ctrl+C` copia una selección, limpia un draft no vacío como edición reversible
y no hace nada sobre un draft vacío; un doble toque accidental ya no ejecuta la
salida global. `Ctrl+D` conserva la salida explícita.

La rueda normal revisa el scrollback de WezTerm. El mouse selecciona texto del
terminal y la selección editable del prompt usa `Shift + flechas`; copy, cut,
delete, paste y reemplazo siguen operando sobre esa selección. Las TUIs
fullscreen activan su tracking separado y conservan sus propios eventos de
rueda.

## Filtros nativos del transcript

OMP 18.0.4 puede retirar snapshots comprometidos y reconstruir el transcript
principal con `resetDisplay()`. Eso permite seguir trabajando con Markdown,
renderers, streaming y editor normales; el costo es reemplazar la representación
terminal anterior, no conservarla byte por byte en el scrollback.

El patch downstream durable `patches/omp-18.0.4-workstation.patch` agrega
`display.hiddenTools`, `display.hideAssistantToolPreambles` y la API opcional
`getTranscriptVisibility`/`setTranscriptVisibility` para extensiones. El filtro
por nombre compone con `display.hideToolActivity`: el global prevalece y cada
tool individual oculta su llamada y resultado. Los preámbulos sólo se eliminan
cuando el mismo mensaje contiene una tool call; las respuestas finales sin tools
siempre permanecen.
El build se publica exclusivamente con `bun run deploy:omp`: instala
`~/.bun/bin/omp.exe`, retira `omp.com` y evita que `PATHEXT` seleccione un core
anterior.
La política debe inicializar tanto el container vivo como el
`stagedChatContainer` de `renderInitialMessages()`; ese swap ocurre en startup y
replay. Configurar sólo el container constructor produce un selector correcto
pero no filtra la superficie efectiva.

`extensions/tool-activity-view.ts` registra el chord privado `Ctrl+Alt+O`
mediante `extensions/windows-input.ts`. WezTerm reemplaza su `Hide` default de
`Ctrl+Shift+M` y emite `CSI 111;7u` directamente al PTY. El chord abre un
selector modal pequeño con thinking, preámbulos, toggle global y todas las tools
registradas; al cerrar se continúa en el transcript principal. Main no participa.


## Mercado de renderers y clientes (2026-08-15)

Revalidado con `omp/17.3.0` local y las fuentes primarias enlazadas.

| Opción | Aporte | Compatibilidad con OMP | Decisión |
| --- | --- | --- | --- |
| Controles TUI nativos | `Ctrl+O` expande outputs, `Ctrl+Shift+O` cambia toda la actividad y `Ctrl+T` muestra/oculta thinking. El patch downstream suma filtros por tool y preámbulos mediante `Ctrl+Shift+M`. | **Nativa con replay explícito**. `resetDisplay()` reconstruye la sesión con componentes ricos; reemplaza el scrollback visual previo en vez de preservar sus bytes. [Keybindings](https://github.com/can1357/oh-my-pi/blob/main/docs/keybindings.md), [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md). | Trabajar en el transcript principal. Usar el selector granular; no mantener una segunda vista fullscreen. |
| Export/share/collab | `/export --themes` genera HTML con renderers web por tool; `/share` publica un snapshot cifrado; `/collab` ofrece transcript web vivo con thinking, tool cards y subagentes. | **Nativa**. [Session operations](https://github.com/can1357/oh-my-pi/blob/main/docs/session-operations-export-share-fork-resume.md), [Collab](https://github.com/can1357/oh-my-pi/blob/main/docs/collab.md). | Usar para lectura rica fuera del TUI antes de adoptar un cliente alternativo. |
| Paseo | Cliente desktop/web/mobile multiagente; OMP es provider directo mediante `omp --mode rpc-ui`, con approvals y tools host. | **Explícita**, aunque el provider OMP viene deshabilitado por defecto. [Repositorio](https://github.com/getpaseo/paseo), [provider contract](https://github.com/getpaseo/paseo/blob/main/docs/providers.md). | Mejor opción externa para evaluar una UI completa y mantenida. |
| `omp-desktop` | Tauri/React enfocado en OMP: Bash/eval streaming, código resaltado, diff unificado scrubbable, tool cards y minimapa. | **Explícita** sobre `omp --mode rpc`; proyecto pequeño y contrato RPC sujeto a drift. [Repositorio](https://github.com/apoc/omp-desktop). | Prototipo Windows prometedor; probar aislado, no volverlo interfaz principal todavía. |
| Renderers del marketplace Pi (`pi-tool-display`, `pi-claude-style-tools`, `@vanillagreen/pi-tool-renderer`, `@heyhuynhgiabuu/pi-diff`) | UIs compactas, previews Bash y diffs Shiki split/unified. | **No directa**. Re-registran `read`/`bash`/`edit`/`write` con factories de Pi o parchean componentes internos. El loader OMP reescribe imports legacy, pero no adapta contratos de renderer ni schemas de tools. | No instalar globalmente en OMP: puede reemplazar Bash, artifacts y el editor hashline. Portar sólo ideas visuales sobre APIs OMP. |
| `pi-thinking-box` | Caja configurable para thinking. | **Frágil**: monkey-patch de `AssistantMessageComponent.prototype`, no el API público OMP. [Package](https://pi.dev/packages/pi-thinking-box). | No portar el patch; usar `registerAssistantThinkingRenderer` para UI suplementaria. |
| Bash live-view de Pi | Widget PTY y tail en vivo. | **Redundante**: OMP ya posee PTY overlay, updates parciales, truncación con artifacts y async jobs. [Bash runtime](https://github.com/can1357/oh-my-pi/blob/main/docs/bash-tool-runtime.md). | Descartar salvo una carencia reproducible del Bash nativo. |

La oportunidad reusable no es copiar un paquete Pi completo, sino una extensión
OMP-native de perfiles de output. Debe delegar los built-ins con `ctx.invokeTool`,
conservar sus schemas/approvals/artifacts y limitarse a `renderCall`/`renderResult`;
thinking usa `registerAssistantThinkingRenderer`. Un cliente RPC alternativo es la
opción correcta cuando se necesita navegación, paneles o layouts que exceden el TUI.

## Conclusión

La base sigue siendo OMP nativo. Las excepciones justificadas son WezTerm
Attention, conductas Windows acotadas y, si aparece una necesidad medible, un
renderer OMP-native que delegue la ejecución sin sustituir tools. Paseo u
`omp-desktop` son evaluaciones de interfaz completas, no extensiones del TUI;
los paquetes de render Pi quedan como referencias visuales, no dependencias.

## Revalidación

Tras actualizar OMP, comparar las rutas locales citadas y releer Settings/Extensions. Una ausencia documental no autoriza a inventar una API; se conserva la clasificación previa hasta obtener evidencia nueva.
