# UX surfaces: native, port or discard

Status: active
Summary: Matriz durable de Windows input, status/cuota, renderers y atención WezTerm revalidada sobre OMP 18.1.6.

## Criterio

- **native**: OMP actual ya posee el contrato; configurar o usar sin mantener una segunda implementación.
- **portar**: la integración aporta una capacidad externa concreta que OMP no sustituye.
- **descartar**: no llevar al laboratorio una implementación paralela o legacy.

## Matriz

| Superficie | Clasificación | Evidencia verificada | Acción |
| --- | --- | --- | --- |
| Windows input y clipboard | **integración deliberada sobre editor nativo** | OMP 18.1.6 ya posee clipboard, paste, VT input y mitigaciones ConPTY. `windows-input-native.ts` conserva únicamente la selección editable por teclado, undo Windows y la semántica verificada de `Ctrl+C`; delega render y autocomplete al editor OMP. El build activo embebe el addon Win32 18.1.6 publicado. | Cargar `extensions/windows-input.ts` directamente. Mantener un único registro de `/windows-input` en la implementación nativa; no conservar wrappers, diagnóstico duplicado ni selección paralela de modelos. |
| Status/footer | **native**; **descartar** un footer paralelo | OMP 18.1.6 documenta e implementa `statusLine.preset`, separators y custom segments. | Hablar de `statusLine`, el nombre real. Configurar presets/segments sólo cuando exista un objetivo medible. |
| Quota/usage en status | **nativa + enriquecimiento AOS acotado** | OMP 18.1.6 registra el segmento `usage`, muestra ventanas y resets del provider, y expone `omp usage`. AOS Budget agrega mediante `setStatus` sólo `ritmo N×`: reutiliza su forecast laboral, refresca en lifecycle con cache de un minuto y no crea un timer de polling. | Conservar `usage` como meter y porcentaje autoritativos. Mostrar únicamente el ritmo compacto desde AOS Budget; porcentaje proyectado, reserva, créditos y detalle permanecen en `/aos-budget`. |
| Modelos y esfuerzos rápidos | **native** | `modelRoles` acepta selectores con sufijo de effort; `modelTags` nombra roles; `cycleOrder` es el ciclo nativo de `Ctrl+P`/`Ctrl+Shift+P`; `/models` permite editar Roles y `Alt+M` selecciona el modelo de la sesión. | Usar `Alt+M`/`/models` como única superficie local de selección; no agregar favoritos, renderers ni hotkeys paralelos. Reservar overlays/perfiles para Task, `prewalk` y concurrencia. |
| Renderers | **native** | OMP 18.1.6 documenta `renderCall`/`renderResult`, message renderer y thinking renderer; `omp gallery` es el visor nativo de estados. | Mantener renderers dentro del contrato nativo sólo cuando una tool local los necesite. No portar un renderer general. |
| WezTerm Attention | **integración deliberada** | El productor existente usa eventos OMP (`agent_start`, `tool_execution_start`, `session_stop`, `tool_call`, `tool_result`) y un marcador atómico consumible por WezTerm. [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) documenta el factory y los eventos. | Fuente única en `extensions/wezterm-attention.ts`, cargada directamente por el perfil global y repetida en `.omp/config.yml`; no mantener wrapper. |

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

OMP 18.1.6 puede retirar snapshots comprometidos y reconstruir el transcript
principal con `resetDisplay()`. Eso permite seguir trabajando con Markdown,
renderers, streaming y editor normales; el costo es reemplazar la representación
terminal anterior, no conservarla byte por byte en el scrollback.

El patch downstream durable `patches/omp-18.1.6-workstation.patch` agrega
`display.hiddenTools`, `display.hideAssistantToolPreambles`,
`display.transcriptVisibilityProfiles`, la API opcional de visibilidad y el
ceiling económico de provider dispatch. La política visual cubre thinking,
preámbulos, métricas por turno, toggle global y tools individuales; el filtro
por nombre compone con `display.hideToolActivity` y las respuestas finales sin
tools permanecen.

El guard de contexto toma el menor entre `model.contextWindow` y
`cost.longContext.inputThreshold`. Si un tool result deja la continuación por
encima de 272k, fuerza compactación sincrónica y aborta sin otra request cuando
no hay progreso. La revisión del rebase confirmó que su estimación suma prompt y
schemas no-message, mensajes persistidos y mensajes pendientes; no existe el
subconteo señalado en la primera pasada del audit.

Revisión contra el tag oficial `v18.1.6`: upstream conserva los toggles
globales de thinking, actividad de tools y métricas, pero no expone filtros por
nombre, ocultamiento de preámbulos ni perfiles atómicos. Las reacciones, el
picker de modelos ampliado y el nuevo status line de extensiones no sustituyen
esa granularidad downstream. El endurecimiento de filas estables continúa
congelando publicaciones que retraen bytes ya emitidos en vez de fallar el
render; es complementario al selector granular. El delta requirió resolver
conflictos en `ChatTranscriptBuilder`, `TranscriptContainer` y
`EventController`, preservó las firmas nuevas de timeline de 18.1.6 y pasó los
22 tests focales, 92 assertions y el check tipado/formato completo de
`packages/coding-agent`. El smoke TUI real mostró 42 opciones, los perfiles
`main` y `zen`, y restauró `Windows input: on`. El patch queda fijado a
`v18.1.6`; cada update posterior exige rebase y tests focales, nunca aplicación
ciega.

### Promoción upstream

La propuesta previa a PR está publicada en
[Discord `#feature-requests`](https://discord.com/channels/1465833614603325562/1465867712000692459/1541865268798820362).
Propone upstreamar sólo los settings y la semántica de rendering general; el
selector, shortcuts, presets y perfiles permanecen en la extensión. Está
relacionada con [#2158](https://github.com/can1357/oh-my-pi/issues/2158), pero
resuelve filtros persistentes por categoría/tool en vez de auto-fold por turno.
No crear branch o PR upstream hasta que el maintainer indique si prefiere
settings nativos o un hook genérico de transcript.

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
selector modal pequeño con presets, perfiles guardados y filtros individuales;
al cerrar se continúa en el transcript principal. Main no participa.


## Espejo Markdown durante streaming

El texto normal del asistente permanece mutable hasta `message_end`, por lo que
el renderer nativo no puede retirarlo de forma segura al scrollback mientras
crece. Para lectura paralela sin otro delta core, `extensions/live-markdown.ts`
consume `message_update` y publica Markdown local por sesión en
`C:/dev/omp-live/<repo>/<fecha>/`. Usa la rama persistida como base, reemplaza
el snapshot vivo con debounce de 60 ms y conserva el session id completo en el
nombre. La fecha y hora salen del header de sesión, no del instante de una
recarga o switch. Dos procesos concurrentes con ids distintos no comparten
archivo.

El mirror es una vista de lectura por turnos, independiente de la visibilidad
diagnóstica del transcript. Cada turno cita el texto `user` antes de la
respuesta útil del asistente, de modo que respuestas concurrentes conservan su
contexto. Esto persiste deliberadamente prompts en la raíz local fuera de Git;
no copia imágenes, mensajes `developer`, system prompts ni contenido de
adjuntos.

Mientras un turno genera y todavía no existe respuesta terminal, un único
bloque `En curso` acumula preámbulos públicos anteriores a tool calls y el
`intent` corto de `tool_execution_start`. El snapshot acumulativo reemplaza ese
bloque, nunca agrega una tarjeta por delta. Thinking, argumentos, resultados y
payloads de tools permanecen excluidos. Al comenzar la respuesta final, el
bloque transitorio desaparece y el Markdown crudo de la respuesta vuelve a ser
el único cuerpo del agente.

Cada sesión TUI materializa desde `session_start` un archivo metadata-only, aun
antes de producir un prompt o respuesta; las sesiones background/headless no
publican. La cola coalesce snapshots pendientes y ejecuta
`mkdir`/`writeFile` sin hacer esperar eventos de agente, mensaje o sesión. Un
error del destino se registra y la sesión OMP continúa; cerrar o reiniciar no
elimina salidas anteriores. La raíz central conserva la jerarquía relativa
bajo `C:/dev` sin introducir estos documentos en los checkouts.
`/live-markdown` muestra el archivo actual y `OMP_LIVE_MARKDOWN_ROOT` permite
cambiar sólo la raíz.

Si VS Code u Obsidian no preservan el scroll al reescribir el snapshot, la
evolución correcta es un visor local sobre el mismo productor, no publicar
Markdown incompleto en el scrollback de OMP.

## Mercado de renderers y clientes (2026-08-15)

Revalidado con `omp/17.3.0` local y las fuentes primarias enlazadas.

| Opción | Aporte | Compatibilidad con OMP | Decisión |
| --- | --- | --- | --- |
| Controles TUI nativos | `Ctrl+O` expande outputs, `Ctrl+Shift+O` cambia toda la actividad y `Ctrl+T` muestra/oculta thinking. El patch downstream suma filtros por tool y preámbulos mediante el chord interno `Ctrl+Alt+O`; WezTerm traduce el chord físico `Ctrl+Shift+M` a esa secuencia privada. | **Nativa con replay explícito**. `resetDisplay()` reconstruye la sesión con componentes ricos; reemplaza el scrollback visual previo en vez de preservar sus bytes. [Keybindings](https://github.com/can1357/oh-my-pi/blob/main/docs/keybindings.md), [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md). | Trabajar en el transcript principal. Usar el selector granular; no mantener una segunda vista fullscreen. |
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
