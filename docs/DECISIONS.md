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

## 2026-08-08 — Fleet local, explícito y sin dependencias (discovery reemplazado)

`extensions/omp-fleet.ts` es la fuente durable. El perfil OMP carga un wrapper mínimo en `~/.omp/agent/extensions/omp-fleet.ts` que reexporta esa fuente, evitando copias divergentes y haciendo `/fleet` global entre repos y reinicios; `.omp/config.yml` ya no duplica su discovery. La implementación usa APIs públicas de OMP y módulos `node:`, sin dependencias de terceros.

Cada repo habilitado obtiene un RPC independiente; los comandos que cambian workers o responden solicitudes exigen run id y target explícitos. Las aprobaciones nunca son automáticas: además identifican repo y request id, conservan ese request id en la respuesta y pasan por approve/deny explícito.

WezTerm y `fleet-observer.ts` son observadores de artifacts, no propietarios de workers; cerrarlos no cancela el run. La persistencia local conserva sólo metadatos, estados y resúmenes sanitizados, nunca texto crudo de resultados o errores.

## 2026-08-11 — Runtime Habitat global, launch explícito y fast fail (discovery reemplazado)

`extensions/agent-runtime-habitat.ts` es la fuente durable del contexto runtime
y del lanzamiento de sesiones hijas. El `config.yml` global declara esa fuente
directamente porque su lista explícita de extensiones reemplaza discovery; el
wrapper mínimo queda como fallback para perfiles sin lista. Los repos de
producto no copian la implementación ni construyen comandos WezTerm.

Harness y host son independientes. La primera implementación soporta OMP sobre
WezTerm, usa pane e instancia explícitos, separa `fresh` de `persistence` y
entrega prompts por un canal loopback efímero con handshake/hash, nunca por argv,
env ni input simulado del terminal. La operación conserva ownership únicamente
sobre panes que creó y hace rollback del pane exacto ante un fallo posterior a
la creación.

El bootstrap Bun transporta sólo metadata correlacionada no sensible por argv,
deriva pane e instancia del entorno real del child, limpia recursion markers y
arranca OMP. El parent expone el prompt una sola vez en un endpoint tokenizado
de `127.0.0.1`; el entorno lleva sólo URL opaca y hash. La extensión hija valida
el contenido, limpia esas variables y usa `pi.sendUserMessage()`. El prompt
sigue excluido de argv, env, terminal, markers y artifacts.

Una combinación sin adapter/capability devuelve `unsupported` y termina. No
busca variables internas, sesiones, procesos, directorios de colaboración ni
fallbacks manuales. El control manual por CLI queda reservado a diagnóstico
explícito, no al flujo normal del agente.

## 2026-08-12 — Capacidades OMP por trigger, no por novedad

Las herramientas avanzadas se seleccionan por evidencia de la tarea. `eval` es
el laboratorio preferido para cálculo ad hoc, análisis de datos y prototipos
incrementales en Python o JavaScript; no sustituye la ejecución, integración ni
verificación del código real del repositorio. `debug` se activa ante fallos de
estado, crashes o hangs que el análisis estático no cierre, y `ast_edit` ante
codemods estructurales repetidos.

LSP, hashline, internal URLs y los checks focales continúan como flujo normal.
Advisor, review y subagentes pueden activarse por defecto cuando OMP o el
sistema agéntico detectan riesgo, revisión especializada o slices realmente
independientes; no requieren una solicitud adicional por ejecución. El agente
principal conserva contratos, integración y aceptación. Commits, push,
publicación, deploy, instalaciones y uso de credenciales disponibles no agregan
un gate AOS cuando son necesarios para el resultado; se verifican destino,
alcance y valores y se respetan las salvaguardas runtime de OMP o del proveedor.
Los pull requests son excepcionales y requieren un motivo concreto. Collab,
browser y computer sólo se activan cuando su necesidad y las políticas locales
lo permiten.

## 2026-08-14 — Implementación corta usa workflow nativo de OMP 18

`/plan-implement-short [objetivo]` vive en la extensión global
`agent-runtime-habitat`, junto a la tool que lanza la sesión. El parent ya no
duplica planificación: empaqueta objetivo, límites, evidencia y verificación en
un prompt autocontenido y abre una única hija.

La hija arranca en Sol heredado dentro de un split derecho al 50%, fresh saved,
mismo cwd y foco conservado en el parent. El request cerrado declara
`workflow: { mode: "plan-yolo", target: "@smol", advisor: true }`: OMP 18
planifica en el modelo fuerte, autoaprueba el plan y entrega la implementación
al rol económico; Advisor revisa el corte de forma opt-in. El parent no
implementa ni monitorea el pane después del handshake.

`agent_runtime_session` también admite workflow `prewalk`, pero nunca argv
libre. El target es un selector de rol nativo OMP, no un `model.spec`; ausencia
de workflow conserva exactamente el lanzamiento anterior. Esta integración usa
el `plan-yolo` nativo de OMP 18 y debe revalidarse al actualizar OMP.

## 2026-08-14 — Nombre y cierre del pane son contrato explícito

`agent_runtime_session` exige `pane: { title, onExit }` para tabs y splits.
`title` usa `OSC 1`; `onExit: "close"` termina el pane con OMP y
`onExit: "keep-open"` vuelve a un shell interactivo en el mismo `cwd`. Así se
separan ubicación (`placement`), almacenamiento de la sesión (`persistence`) y
ciclo de vida del terminal (`pane.onExit`) sin inferencias por tipo de launch.

El shell posterior recibe un entorno limpio, sin metadata `OMP_RUNTIME_*`, canal
efímero del prompt ni marcadores de recursión. `/plan-implement-short` elige
`Implementador · <objetivo>` y `keep-open`; otros callers deben declarar su
propia intención.

## 2026-08-14 — Closeout semántico y promoción explícita

El baseline global exige comparar los deltas de todo trabajo no trivial con la
documentación canónica antes de entregar. Sólo se promueve información durable
faltante y una única vez; ausencia de delta no crea archivos. Transcripts,
intentos, logs, resultados crudos de tools y hechos derivables del código se
descartan.

`/promote-context [foco]` y su alias en español
`/guardar-sesion [foco]` complementan ese gate con una curaduría profunda bajo
demanda desde `agent-runtime-habitat`. Actualizan fuentes existentes, preservan
certeza, riesgos y gates, y ejecutan los checks documentales definidos por el
repo. No introducen una auto-memory ni otra fuente de verdad.

## 2026-08-16 — Cierre multi-repo revisable y gobernado por Infra (discovery reemplazado)

`/cerrar-computadora [foco]` es una extensión UX pequeña, no un sincronizador.
Precarga mediante `ctx.ui.setEditorText()` una instrucción para cerrar el trabajo
versionable del host y deja el envío bajo control humano. No llama
`sendUserMessage`, Git, workers ni proveedores al ejecutar el slash command.

La política vive únicamente en
`C:\dev\infra\docs\runbooks\sync-multi-repo.md`; la extensión conserva un prompt
compacto que remite a esa autoridad y fija los límites necesarios para una
sesión sin contexto: auditoría inicial/final, revisión semántica por repo,
checks focales, commits y push no productivos, y bloqueo explícito de
divergencias, artifacts privados o riesgo de producción. Merge/rebase a `main`,
release, deploy y reparación destructiva quedan fuera del cierre cotidiano.

La fuente durable es `extensions/sync-close-prompt.ts`; el perfil global carga
un wrapper mínimo. Así el comando queda disponible desde cualquier repo sin
copiar reglas de Infra ni estado privado al laboratorio.

## 2026-08-18 — Agente DeepSeek project-local con prewalk económico (reemplazada)

El workspace incorpora `.omp/agents/deepseek-pro.md`. Su lista de modelos
prioriza `deepseek/deepseek-v4-pro:high` cuando existe una credencial directa y
usa `openrouter/deepseek/deepseek-v4-pro-0813:high` como fallback actualmente
disponible en el catálogo efectivo del workspace. `prewalk` transfiere el primer
`edit` o `write` al selector económico
`openrouter/deepseek/deepseek-v4-flash-0731:low`.

La elección permanece en OMP, no en AOS: el modelo, provider, effort, tools y
handoff son configuración runtime del agente project-local. AOS conserva sólo
esta razón durable y el repositorio sigue sin almacenar credenciales. El provider
directo `deepseek` queda como primera opción cuando exista una credencial OMP
válida; no se copia ningún secreto al repositorio.

## 2026-08-18 — Perfil reversible para investigar DeepSeek

El workspace incorpora `profiles/deepseek-lab.yml` como overlay OMP de proceso,
no como un `--profile` de almacenamiento. Esa elección evita separar sesiones,
auth y caches: el objetivo es cambiar modelos, no crear otro perfil de usuario.

El overlay usa V4 Pro `high` como `default`, `slow` y `plan`; V4 Flash `low`
como `smol`, `task` y `tiny`; y `cycleOrder: [default, smol]` para alternar la
calidad normal y la implementación guiada. `prewalk.enabled` queda activo para
que el modelo fuerte pueda planificar y el modelo económico tomar la edición
cuando existe un todo-list de implementación.

La investigación mide costo efectivo, tokens, latencia, tool calls y tasa de
reparación con `omp bench` y el uso del provider. No se agregan scripts de API,
claves ni un segundo runtime; `--config` permite retirar el experimento sin
alterar la configuración global.

## 2026-08-18 — Baseline de costo y latencia DeepSeek vía OpenRouter

Se ejecutó un benchmark controlado con una solicitud normal por modelo (`maxTokens`
128, `par=1`) y un par cold/warm de cache (`maxTokens` 64), usando los selectors
OpenRouter V4 Pro 0813 `high` y V4 Flash 0731 `low`. Las cuatro solicitudes
terminaron correctamente.
La corrida normal observó TTFT de 1732 ms y duración de 2297 ms para Pro, frente
a 690 ms y 1557 ms para Flash. En el par de cache, Pro costó `$0.0022842864`
en frío y `$0.00034394976` en caliente, con 1536 tokens leídos de cache; Flash
costó `$0.00024965325` tanto en frío como en caliente y no expuso cache hit en
esa ruta. El par completo fue `$0.00262823616` para Pro y `$0.0004993065` para
Flash, aproximadamente 5.26x más caro para Pro en esta muestra.

Es un baseline de precio/latencia, no una comparación de calidad: una sola corrida
no prueba superioridad para coding. El prompt de cache tenía aproximadamente
1555 tokens de input y 64 de output por fase. Las solicitudes fueron vía
OpenRouter; el panel oficial de DeepSeek permaneció en `$0.00`, 0 requests y 0
tokens. Repetir con tareas de programación equivalentes, éxito de primera pasada,
reparaciones y costo por tarea cerrada antes de fijar una política definitiva.

## 2026-08-18 — Primer smoke Luna Max frente a DeepSeek Pro Max + Flash

La comparación cambió la baseline solicitada: Luna Max actúa como padre y como
implementador; el perfil DeepSeek usa V4 Pro `max` como padre y V4 Flash `low`
como hijo `task`. Ambos perfiles desactivan `prewalk`, fijan una sola tarea hija
y trabajan sobre `tmp/deepseek-study-fixture`, que se excluye del repositorio.

La tarea fue implementar `summarizeQueue` con invariantes de conteo, tasa de
completitud, cola vacía, primer queued por `createdAt` y no mutación. Ambos padres
delegaron exactamente una tarea y ambos dejaron `3 pass, 0 fail`; las
implementaciones fueron equivalentes en complejidad y pasaron el mismo fixture.

Luna Max tardó 165.51 s de extremo a extremo. DeepSeek Pro + Flash tardó
138.33 s, aproximadamente 16.4% menos en esta corrida. El stream DeepSeek
expuso seis turnos del padre, 56,334 tokens de input, 2,388 de output y un costo
observado del padre de `$0.08508346308`; el hijo Flash quedó asignado por
`task.agentModelOverrides`, pero esta ejecución sin sesión no expuso su receipt
de uso separado. El provider openai-codex conservó el reporte grueso de 96% de
cuota semanal usada antes y después, por lo que no permite atribuir un costo
unitario a Luna Max.

Este smoke prueba coordinación, compilación/tests y latencia, no superioridad de
calidad. La siguiente iteración debe repetir varias tareas y capturar receipts
de padre e hijo por separado antes de decidir el routing por defecto.

## 2026-08-18 — Catálogo de overlays y activación honesta

`profiles/catalog.json` separa la metadata mantenible de los seis overlays
YAML nativos. `extensions/omp-profiles.ts` registra una única superficie
`/profiles` con `list`, `show <name>`, `activate <name>` y `prepare <name>`, y
deriva el autocomplete de las entradas del catálogo.

La allowlist valida nombres estables y overlays relativos directos dentro de
`profiles/`; no acepta traversal, paths absolutos ni modelos arbitrarios.
`activate` cambia explícitamente el modelo padre y thinking de la sesión viva
mediante `setModel`/`setThinkingLevel`, sin fingir cambios de Task, `prewalk` o
concurrencia. `prepare` conserva el launcher exacto del overlay para una sesión
nueva cuando se necesita aplicar la combinación completa.

## 2026-08-18 — Hotkey `Ctrl+Alt+M` cicla los padres del catálogo de perfiles (reemplazada)

`extensions/profile-hotkey.ts` recorre los padres de `profiles/catalog.json`
mediante `PROFILE_CATALOG` + `splitModelSelector`. Cada pulsación activa el
modelo padre y thinking de la sesión viva con `setModel`/`setThinkingLevel`,
igual que `/profiles activate`; no promete cambios de Task, `prewalk` ni
concurrencia.

El catálogo incorpora `deepseek-pro-high` y `deepseek-flash-high` como presets
directos, ambos con thinking `high`. Sus overlays usan respectivamente
`deepseek/deepseek-v4-pro` y `deepseek/deepseek-v4-flash` en todos los roles; no
introducen fallback ni routing automático.

`splitModelSelector` y el tipo `ProfileThinkingLevel` viven en
`src/profile-catalog.ts` para que el catálogo sea la única fuente del parseo de
selectores `modelo:thinking`. El hotkey usa `registerShortcut` y no depende de
`CustomEditor` ni de la carga de `pi_natives`; esto evita que un OMP nuevo quede
sin el handler cuando el addon nativo opcional no está instalado.

`.omp/config.yml` carga `extensions/windows-input.ts` directamente porque su
lista explícita reemplaza el discovery ambient. Ese wrapper estable registra el
hotkey para todos los repos que lo descubren y carga bajo demanda
`windows-input-native.ts`; si falta `pi_natives`, omite sólo el editor Windows
sin romper el hotkey ni la sesión OMP.

## 2026-08-18 — Discovery global del hotkey de perfiles (histórica)

El wrapper `~/.omp/agent/extensions/windows-input.ts` quedó declarado también
en `~/.omp/agent/config.yml`, no sólo en el config project-local de este
workspace. Así un repo sin `.omp/config.yml`, como `C:\dev\dictation-tauri`,
descubre el mismo hotkey sin exigir `omp --extension ...` en cada arranque.
La fuente continúa siendo `C:\dev\omp`; no se copian código, credenciales ni
estado privado a otros repos.

## 2026-08-18 — Fallback de terminal para `Ctrl+Alt+M` (reemplazada)

En Windows, ConPTY/WezTerm puede entregar `Ctrl+Alt+M` como el carácter
`U+00B5` (`µ`). El editor nativo ya reconocía esa representación, pero si
falta el addon opcional `pi_natives` ese editor no se instala y el carácter
terminaba en el editor OMP. `profile-hotkey.ts` registra ahora un listener de
terminal que consume `µ` y ejecuta el mismo ciclo del catálogo; el shortcut
`ctrl+alt+m` sigue cubriendo la representación nativa. El wrapper conserva el
hotkey aunque el editor opcional falle y expone `/windows-input` como diagnóstico
de esa disponibilidad.

## 2026-08-18 — Preset mixto GLM Flash, Qwen Coder y MiniMax

Se agrega `profiles/glm-flash-qwen-coder-minimax.yml` y su entrada en
`profiles/catalog.json` como combinación explícita de tres roles: GLM 4.7 Flash
`low` para `default` y `minimal` para `smol/tiny`, Qwen3 Coder Next `off` para
`task`, y MiniMax M3 `high` para `slow/plan`. Los selectores corresponden a
modelos presentes en el catálogo local de OMP vía OpenRouter; no se incorporan
credenciales, fallback ni routing automático.

`prewalk` queda desactivado para que los cambios reales delegados conserven
Qwen como implementador, y Task queda limitado a una ejecución concurrente.
`activate` sólo puede cambiar el padre GLM de la sesión viva; el overlay sigue
siendo necesario para aplicar Task, `slow/plan`, `prewalk` y concurrencia.

## 2026-08-18 — Activación de perfiles y persistencia de modelos

`/profiles activate <name>` activa un perfil en la sesión viva mediante `omp.setModel()`, pero **no persiste** entre reinicios ni cambia la configuración global `~/.omp/agent/config.yml`. Los procesos heredan el modelo por defecto de la configuración global a menos que se lance explícitamente con el overlay correcto.

Para usar un perfil de forma persistente en nuevas sesiones:

1. **Iniciar con el overlay**:
   ```bash
   omp --config profiles/<overlay>.yml
   ```

2. **Crear alias global (opcional)**:
   ```bash
   omp --profile <name> --alias omp-<profile>
   ```

3. **Hotkey `Ctrl+Alt+M` cicla padres** sin cambiar Task, `prewalk` ni concurrencia. Solo cambia `default/slow/plan/smol/task/tiny` al padre del perfil.

El catálogo en `profiles/catalog.json` mantiene la metadata mantenible (`parent`, `task`, `tags`, `status`). Los overlays YAML contienen la configuración runtime efectiva (`modelRoles`, `cycleOrder`, `prewalk`). Los procesos heredan del overlay si se lanza con `--config`, de lo contrario usan `~/.omp/agent/config.yml` global.

No se promueve persistencia automática porque la autoridad de autorización y credenciales (`~/.omp`) permanece separada del workspace. La elección de perfil sigue siendo una decisión del usuario por launcher o hotkey.

## 2026-08-18 — Favoritos de modelo nativos (reemplazada)

Para cambiar rápidamente modelo y esfuerzo sin escribir `/model`, se eligió el
contrato nativo `modelRoles` + `modelTags` + `cycleOrder` en lugar de otra
extensión o renderer. Cada role favorito es un selector atómico
`provider/model:effort`; `Ctrl+P` y `Ctrl+Shift+P` recorren sólo el ciclo
seleccionado. `Alt+M` queda como selector de sesión y `/models` como hub
completo para editar Roles.

La configuración global actual mantiene tres favoritos directos de DeepSeek:
`flash` (`deepseek-v4-flash:low`), `pro` (`deepseek-v4-pro:high`) y `pro-max`
(`deepseek-v4-pro:max`). `Ctrl+Alt+M` conservaba el ciclo de perfiles completos,
porque los overlays también gobiernan Task, `prewalk` y concurrencia. El cambio
rápido de favoritos no promete modificar esos parámetros de orquestación.

## 2026-08-18 — Selección de modelos sólo por hub nativo

Se retira el hotkey custom `Ctrl+Alt+M` y la capa de favoritos propia. La
selección rápida queda en `Alt+M`/`/models` y en el editor de Roles nativo de
OMP. Se eliminan los roles `flash`, `pro` y `pro-max` agregados por el
workspace, sus `modelTags` y el override global de `cycleOrder`; `Ctrl+P`
queda sujeto al ciclo nativo de OMP.

Los perfiles y overlays permanecen porque representan configuración completa de
sesión (`Task`, `prewalk`, proveedor y concurrencia), no un segundo selector
rápido de modelo. El editor Windows opcional sigue disponible, pero ya no
intercepta teclas de selección ni registra un ciclo paralelo.

## 2026-08-20 — WinInput directo; wrapper global no operativo

El editor vigente no reproduce el conflicto histórico con autocomplete: cargado
directamente mediante `extensions/windows-input.ts` sobre OMP 17.3.8, activa
`/windows-input`, conserva el menú `/` y convive con `/profiles`.

El wrapper global `~/.omp/agent/extensions/windows-input.ts` no es equivalente.
Su reexportación cruza la frontera del loader de extensiones y los imports
internos terminan resolviendo `@oh-my-pi/pi-natives` 17.4.0 desde el cache de
Bun; ese paquete no contiene el addon Win32 requerido. El wrapper captura el
error y deja únicamente el comando diagnóstico, por lo que parece que WinInput
estuviera cargado aunque el `CustomEditor` no se instaló.

Hasta corregir esa resolución, la ruta verificable es cargar la fuente directa.
El 2026-08-21 la configuración global reemplazó el wrapper por
`C:/dev/omp/extensions/windows-input.ts`; el smoke RPC desde Constelaciones
expuso `Toggle Windows-like input editor`, prueba de que el módulo nativo cargó.
El backup byte-exacto previo quedó en
`C:/Users/jpsal/.omp/agent/config.yml.windows-input-backup-2026-08-21T11-02-26.280Z`
con SHA-256
`5bbcf775d22fa1aba352a8420beaac1c194f27dc90e494f09f22f0ccb54a1c75`.

## 2026-08-21 — Mouse del prompt como contrato TUI opt-in

Click-to-caret y selección por drag no se implementan reconstruyendo geometría
desde la extensión. `pi-tui` expone hit-testing del `Editor` sobre el frame
renderizado y enruta SGR mouse sólo al componente normal enfocado que declara
`wantsMouseTracking`. Usa button-motion `1002` más coordenadas extendidas
`1006`; los overlays fullscreen conservan su tracking separado `1003`.

`WindowsInputEditor` inicialmente consumió ese contrato para click-to-caret y
selección por drag. La prueba posterior sobre el hardware real mostró el costo:
mouse reporting permanente impide el scroll continuo de la rueda sin
modificador. Los bindings de WezTerm con `mouse_reporting = true`, tanto con
delta fijo como con `ScrollByCurrentEventWheelDelta`, no resolvieron el
conflicto.

`Ctrl+Z` se reserva como undo de texto en WinInput, no como suspend POSIX.
Las ediciones de rango guardan snapshots atómicos compatibles con el TUI 17.4
ya instalado; el TUI custom agrega además `replaceTextUndoable()` y `undo()`.
`Ctrl+C` copia cuando hay selección, limpia un draft no vacío de forma
reversible y es inerte sobre un draft vacío. Así conserva el clear útil sin
mantener el doble Ctrl+C accidental como salida destructiva; `Ctrl+D` sigue
siendo la salida explícita.

Decisión final: WinInput no declara `wantsMouseTracking` ni consume eventos SGR
en el prompt. La rueda y la selección con mouse pertenecen a WezTerm; la
selección editable usa `Shift + flechas`. Los overlays fullscreen conservan su
tracking separado. Se prioriza el comportamiento cotidiano verificable sobre
click-to-caret y drag editable.

El paquete oficial OMP 17.4.0 aporta el addon Win32 correcto. El override
actual de mouse tiene SHA-256
`96da502deb46cda9f014c795d4e3174b5ba36d1804879e49cfb7784e265843f4`,
pero la extensión viva ya aporta el undo compatible y el smoke lo verificó. El
build TUI completo pendiente tiene SHA-256
`90a83ae249bd82f428875150cba265e495ed1357ab6bcc6001e76ea63f289fd4`;
`omp-undo-activate` reemplaza `omp.com` cuando su sesión bloqueante termine y
`omp-mouse-finalize-v2` hace luego el cutover limpio de `omp.exe`.

Rollback al launcher oficial 17.4:
`C:/Users/jpsal/.bun/bin/omp.exe.official-17.4-backup-2026-08-21T11-41-10.889Z`,
SHA-256
`942767491537d14a8d2334a77cb3b4508479eef77323c4bcfe6387f2450d2e24`.

## 2026-08-25 — Primera vista fullscreen reversible (reemplazada)

El toggle nativo `Ctrl+Shift+O` no satisface el caso de sesiones reanudadas:
OMP puede repintar componentes vivos, pero las filas ya comprometidas al
scrollback nativo de WezTerm son historia inmutable. Limpiar y reconstruir la
pantalla habría destruido scrollback y selección; iniciar oculto tampoco sería
reversible después de mostrar los bloques.

Se eligió una vista filtrada fullscreen. OMP registra `Ctrl+Alt+O` como chord
interno; WezTerm reemplaza su `Hide` default de `Ctrl+Shift+M` y emite
directamente la secuencia privada al PTY. Main no participa. La extensión
reconstruye la conversación de la rama activa sobre el alternate screen:
conserva mensajes de usuario y respuestas finales del assistant; omite
thinking, preámbulos de turnos con tools, tool calls y tool results. Vuelve con
`Esc`, `q` o `Ctrl+Shift+M`; transcript y scrollback quedan intactos debajo.
El overlay no habilita mouse reporting para preservar selección y rueda nativas.

## 2026-08-25 — Filtros granulares en el transcript principal

La vista fullscreen anterior preservaba scrollback byte por byte, pero impedía
continuar trabajando y degradaba Markdown y componentes ricos. Queda retirada.
OMP 17.4 ya puede ejecutar `resetDisplay()` y reconstruir la sesión sobre la
pantalla principal; se acepta reemplazar la representación terminal previa para
conservar formato, editor, streaming e interacción normal.

El delta downstream agrega filtros persistentes para thinking, preámbulos de
mensajes que invocan tools, actividad global y tools individuales. Los
preámbulos sólo se ocultan cuando el mensaje efectivamente contiene una tool
call; una respuesta final sin tools nunca desaparece. La extensión accede por
una API pública opcional. Registra `Ctrl+Alt+O`; WezTerm convierte el chord
físico `Ctrl+Shift+M` en esa secuencia y abre un selector modal, no otro
transcript.

El entonces patch 18.0.4 fue el delta reproducible contra `v18.0.4`. El
`omp update` oficial reemplazó el binario 17.4 y confirmó que los
filtros no existen upstream; se rebasaron sobre 18 sólo los filtros granulares.
El delta anterior de status/cuota no se arrastró a ciegas frente al core nuevo.
El despliegue publica el addon Win32 de la misma versión como sidecar y rota
launchers mediante artifacts únicos fuera de `PATHEXT`, incluso cuando una
sesión anterior mantiene el backup previo bloqueado.

Los tabs OMP de WezTerm ejecutan `wezterm.home_dir .. '/.bun/bin/omp.exe'`.
Nombrar sólo `omp.exe` todavía dejaba resolución indirecta y permitió abrir una
sesión con el core anterior aunque la extensión nueva ya estuviera en disco.
Una sesión viva no puede incorporar APIs agregadas al binario; el fallback de
la extensión avisa una sola vez y exige un tab nuevo, sin repetir errores.

La instalación Windows adopta un único basename ejecutable: `omp.exe`.
`scripts/deploy-omp-workstation.ts` es el único flujo downstream de publicación:
valida PE/tamaño, staging y rotación con rollback, retira `omp.com` antes del
cutover y deja backups bloqueados con sufijos fuera de `PATHEXT`. El audit falla
si `omp.com` reaparece. No se corrige modificando `PATHEXT`, aliases ni perfiles
de shell.

## 2026-08-25 — `omp update` exige rebase explícito del delta downstream

`omp update` preservó la resolución única a `omp.exe`, pero reemplazó el core y
retiró la API granular. Esto es el comportamiento esperado de un updater de
binario completo, no una nueva colisión de launchers. El flujo validado es:
actualizar, clonar el tag exacto, rebasar y probar el patch focal, construir con
el addon nativo de la misma versión y desplegar mediante `bun run deploy:omp`.

El deploy usa nombres de backup únicos; un `omp.exe.previous` bloqueado ya no
impide publicar la versión siguiente. Las preferencias de thinking, preámbulos
y tools se restauran después del update si el schema oficial las descarta.

La primera rebase 18 era incompleta: configuraba el container creado por
`InteractiveMode`, pero `renderInitialMessages()` lo reemplazaba por un
`stagedChatContainer` que sólo heredaba el toggle global. El selector podía
mostrar preferencias correctas mientras la superficie efectiva seguía
renderizando Bash. La política granular ahora se aplica en cada creación y
rebuild del transcript. Un test de integración construye `InteractiveMode`,
ejecuta el swap inicial y exige que `bash` quede oculto mientras `read` sigue
visible.

## 2026-08-25 — Presets y perfiles atómicos de visibilidad

Las métricas por turno son componentes separados de las tools; ocultar Bash no
las elimina. `TranscriptVisibility` incorpora `hideTokenUsage`, que invierte
`display.showTokenUsage` y fuerza el mismo rebuild del transcript.

Para evitar micromanejo, el selector ofrece tres presets completos:
`Conversación limpia` oculta toda la actividad interna; `Trabajo enfocado`
oculta thinking, preámbulos, métricas, Bash y Hub; `Diagnóstico` muestra todo.
El usuario también puede guardar el estado actual con un nombre, aplicarlo
atómicamente o eliminarlo. Los perfiles viven en el setting global
`display.transcriptVisibilityProfiles`; no crean otro archivo de preferencias ni
se mezclan con perfiles de modelos.

## 2026-08-25 — Rebase granular sobre OMP 18.0.5

El tag estable `v18.0.5` seguía sin ofrecer filtros por tool, preámbulos o
perfiles de visibilidad. En ese update se reemplazó el patch 18.0.4 por un
delta fijado a `v18.0.5`; cada versión mantiene una sola base activa.

El único conflicto del rebase estaba en el render final de
`EventController`: se preservó la semántica 18.0.5 de `SilentAbort` estructural
y se agregó únicamente el filtro de preámbulos al timeline visible. El delta
pasó 23 tests focales, 94 assertions y el check completo de
`packages/coding-agent`. El build Windows embebe el addon nativo 18.0.5 y se
publica sólo mediante `bun run deploy:omp`; el smoke real confirmó
`omp/18.0.5` y el selector granular con presets, perfil `zen` y 39 opciones.

## 2026-08-25 — Discovery directo y una sola fuente por extensión

Las listas explícitas de `extensions` reemplazan, no fusionan, el discovery del
perfil. Los wrappers históricos bajo `~/.omp/agent/extensions/` quedaban
inertes cuando el perfil global declaraba su propia lista y además abrían una
segunda ruta de resolución de módulos. Se retiran: el perfil global carga por
path directo `wezterm-attention`, `agent-runtime-habitat`, `omp-fleet`,
`sync-close-prompt` y `windows-input` desde `C:/dev/omp/extensions/`.
`.omp/config.yml` repite ese conjunto, suma `omp-profiles` y conserva las
integraciones runtime de OS para ser un superset efectivo.

`extensions/windows-input.ts` continúa como entrypoint global que compone el
selector granular con el editor opcional, pero deja de registrar un
`/windows-input` diagnóstico antes del import. El único dueño del comando es
`windows-input-native.ts`; así una carga exitosa no registra dos handlers y una
carga fallida no aparenta que el editor esté disponible.

El agente suelto `.omp/agents/deepseek-pro.md` y su copia legacy
`.omp.borrar/` quedan retirados. Los overlays allowlisteados bajo `profiles/`,
su catálogo y `/profiles` son la única autoridad para combinaciones completas
de modelos, Task, `prewalk` y concurrencia. La selección viva permanece en el
hub nativo `Alt+M`/`/models`.

La selección por trigger no habilita Advisor globalmente:
`advisor.enabled=false`, `advisor.syncBacklog=off` y `task.prewalk=false`
siguen siendo los defaults. `/plan-implement-short` es el único flow mantenido
que solicita Advisor y el target económico de forma explícita.

## 2026-08-26 — Rebase granular sobre OMP 18.0.6

El updater oficial instaló los paquetes 18.0.6, pero no reemplazó el
`omp.exe` compilado downstream; esa advertencia es esperable en este layout.
El tag `v18.0.6` tampoco ofrece filtros por tool, preámbulos, perfiles ni un
hook genérico de transcript, por lo que el delta sigue siendo necesario.

El patch 18.0.5 aplicó limpio. Los únicos archivos del delta tocados por
upstream fueron `settings-schema.ts` y `transcript-container.ts`; se conserva
el endurecimiento nuevo que congela publicaciones de filas estables cuando
retraen bytes ya emitidos. La base durable pasa a
`patches/omp-18.0.6-workstation.patch` y se retira la anterior.

Los 23 tests focales pasaron con 94 assertions y el check completo de
`packages/coding-agent` quedó limpio. El binario embebe el addon Win32 18.0.6,
se publicó mediante `bun run deploy:omp`, y el smoke TUI real confirmó
`omp/18.0.6`, los tres presets, el perfil `zen` y 39 opciones.

## 2026-08-27 — Tabs de orquestación cierran tras entregar su retorno

`pane.closeOnComplete` es un opt-in independiente de `pane.onExit`. El parent
conserva en memoria el adapter y el `WezTermPaneHandle` exactos del launch; tras
encolar correctamente el follow-up del completion, cierra sólo ese pane
runtime-owned. `/orquestar` lo activa para el owner y exige el mismo flag en cada
worker tab, por lo que el cleanup se propaga worker → owner → dispatcher.

No se persiste ni reconstruye una capacidad de cierre desde un `paneId`. Una
recarga o reapertura pierde deliberadamente ese cleanup automático y conserva
el tab sobreviviente: evitar cerrar un pane reutilizado pesa más que recuperar
la limpieza visual. Un fallo de cierre no descarta ni bloquea el resultado; un
fallo sincrónico al encolar el follow-up conserva el pane y restaura el mailbox.

## 2026-08-28 — Espejo Markdown fuera de Git mediante eventos oficiales

La lectura de una respuesta mientras todavía se genera no justifica otro patch
del renderer. La extensión `live-markdown.ts` consume `message_update`, conserva
el Markdown crudo del asistente y reescribe un archivo por sesión cada 60 ms.
Reconstruye primero la rama persistida mediante `SessionManager.getBranch()`.

El mirror es deliberadamente assistant-only. No persiste prompts ni usa el
nombre de sesión, porque ambos pueden derivar del texto del usuario. Thinking y
preámbulos de mensajes con tools se incluyen sólo cuando la política viva de
visibilidad los muestra; si el build no expone esa API, el default privado los
omite. Los payloads de tools nunca se copian.

Los archivos viven por defecto en `C:/dev/omp-live/<ruta-relativa-del-repo>/`,
nunca dentro del checkout ni de Git. Cada nombre fija fecha, hora, pane y
session id completo; el propio documento conserva cwd, sesión, pane, estado y
timestamp. `/live-markdown` muestra la ruta activa y `OMP_LIVE_MARKDOWN_ROOT`
permite cambiar sólo la raíz. Sesiones headless no publican y una sesión
interactiva sin respuesta visible no deja archivos huérfanos.

Las escrituras pendientes coalescen al snapshot más reciente y nunca se esperan
desde eventos de mensaje, agente o shutdown. Un fallo de filesystem queda en el
logger sin interrumpir OMP; reiniciar no limpia archivos previos.

Se acepta que VS Code u Obsidian vuelvan a renderizar el archivo completo: este
contrato busca lectura Markdown viva sin modificar OMP. Si el preview no
preserva la posición al hacer scroll, el siguiente paso es un visor local sobre
el mismo productor, no volver mutable el scrollback nativo.
