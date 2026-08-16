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
| Windows input, clipboard y presets | **portar sobre renderer nativo** | En 17.2.11, `src/utils/clipboard.ts` implementa lectura PowerShell nativa/WSL de texto e imagen; `src/modes/controllers/input-controller.ts` conecta paste de texto/imagen al editor; `@oh-my-pi/pi-tui/src/terminal.ts` habilita VT input, UTF-8 y mitigaciones ConPTY en `win32`. `extensions/windows-input.ts` conserva el `CustomEditor` y su `super.render()`, por lo que `/`, `@`, `#`, skills e internal URLs siguen usando el autocomplete nativo; la selección visual se añade sólo durante el frame mediante `decorateText`. En el layout Windows activo, WezTerm entrega `Ctrl+Alt+M` como U+00B5; la extensión reconoce tanto el chord parseable como ese carácter y usa `ctx.models.resolve`, `pi.setModel` y `pi.setThinkingLevel` para recorrer GPT-5.6 Sol/medium, GPT-5.6 Luna/xhigh y GPT-5.6 Luna/max. | Mantener la fuente durable en `extensions/windows-input.ts` y la copia instalada en el perfil OMP. No volver a copiar ni reemplazar el renderer completo. |
| Status/footer | **native**; **descartar** un footer paralelo | [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md#appearance-and-terminal) documenta `statusLine.preset`, separators y custom segments. En 17.2.7, `src/modes/components/status-line/presets.ts` y `segments.ts` implementan el componente. | Hablar de `statusLine`, el nombre real. Configurar presets/segments sólo cuando exista un objetivo medible. |
| Quota/usage en status | **native** | `src/modes/components/status-line/segments.ts` registra `usage` y muestra ventanas 5h/7d y resets desde `SegmentContext.usage`; `omp usage` también existe en la CLI 17.2.7. | Usar el segmento `usage` o `omp usage`; no consultar auth ni crear un poller propio. |
| Renderers | **native** | [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md#tool-callresult-renderer) documenta `renderCall`/`renderResult`, message renderer y thinking renderer. `omp gallery` es el visor nativo de estados de tool renderers en 17.2.7. | Mantener renderers dentro del contrato nativo sólo cuando una tool local los necesite. No portar un renderer general. |
| WezTerm Attention | **portar** | El productor existente usa eventos OMP (`agent_start`, `tool_execution_start`, `session_stop`, `tool_call`, `tool_result`) y un marcador atómico consumible por WezTerm. [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) documenta el factory y los eventos. | Fuente saneada en `extensions/wezterm-attention.ts`; carga project-local en `.omp/config.yml`. |


## Mercado de renderers y clientes (2026-08-15)

Revalidado con `omp/17.3.0` local y las fuentes primarias enlazadas.

| Opción | Aporte | Compatibilidad con OMP | Decisión |
| --- | --- | --- | --- |
| Controles TUI nativos | `Ctrl+O` expande outputs, `Ctrl+Shift+O` muestra/oculta actividad de tools y `Ctrl+T` muestra/oculta thinking; themes, límites de output y status line son configurables. | **Nativa**. [Keybindings](https://github.com/can1357/oh-my-pi/blob/main/docs/keybindings.md), [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md). | Explotar primero; no instalar una extensión para estos toggles. |
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
