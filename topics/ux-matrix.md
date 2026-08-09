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

## Conclusión

La portabilidad activa queda reducida a WezTerm Attention y a conductas Windows acotadas sobre el renderer nativo: selección y ciclo explícito de presets. El resto se apoya en OMP nativo para evitar drift, duplicación de keybindings y componentes TUI que compitan con el autocomplete/status.

## Revalidación

Tras actualizar OMP, comparar las rutas locales citadas y releer Settings/Extensions. Una ausencia documental no autoriza a inventar una API; se conserva la clasificación previa hasta obtener evidencia nueva.
