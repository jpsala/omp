# Working Memory

## Propósito

Mantener sólo el estado vivo necesario para retomar trabajo en este laboratorio.
Las razones históricas viven en `docs/DECISIONS.md`; los contratos reutilizables,
en `docs/topics/`; el código y la configuración siguen siendo la fuente de verdad.

## Estado vivo

- La workstation `JP` ejecuta `omp/18.1.10` desde `~/.bun/bin/omp.exe`, compilado
  con el addon Win32 publicado de la misma versión y el delta reproducible
  `patches/omp-18.1.10-workstation.patch`.
- La notebook `ASUS` conserva su despliegue anterior hasta una sincronización
  explícita. Repositorio y perfil administrado ya tienen la configuración nueva.
- `extensions/` es la fuente durable. `.omp/config.yml` repite el conjunto
  global y agrega `omp-profiles`, porque OMP reemplaza —no fusiona— la lista
  `extensions` project-local.
- `browser.enabled=false` y `computer.enabled=false` mantienen AXI como única
  superficie web interactiva autorizada. `tui.hyperlinks=auto` activa links
  Markdown locales; WezTerm abre sólo `file://` en VS Code y conserva HTTP(S)
  con su comportamiento normal.
- El selector granular se abre con `Ctrl+Shift+M` en WezTerm
  (`Ctrl+Alt+O` dentro de OMP). Controla thinking, preámbulos, métricas y
  actividad por tool; ofrece los presets `Conversación limpia`,
  `Trabajo enfocado` y `Diagnóstico`, además de perfiles nombrados.
- WinInput mantiene selección editable por teclado, undo Windows y la semántica
  segura de `Ctrl+C`. El mouse y la rueda quedan en manos de WezTerm;
  `Shift + flechas` selecciona dentro del prompt.
- `extensions/live-markdown.ts` publica una vista de lectura por turnos bajo
  `C:/dev/omp-live/<repo>/<fecha>/`. Los archivos usan el título nativo de OMP,
  pane y un digest corto; cada escritura propaga actividad a las carpetas para
  el orden `modified`. Incluye prompts, progreso público transitorio y respuesta
  final; excluye thinking, argumentos, resultados, system prompts y adjuntos.
- La selección persistente de modelos usa `Alt+M`/`/models`; `/switch` cambia
  sólo la sesión viva. `/modo normal|economico|estado` conserva los perfiles
  gestionados del laboratorio. Los overlays completos siguen en `profiles/`.
- Habitat administra sesiones visibles y handoffs; Fleet, ejecuciones
  multi-repo; el cliente RPC, framing y finalización. Sus contratos detallados
  viven en los topics enlazados abajo, no en esta memoria.
- Orca `1.4.197` está instalado como host visual piloto en `JP`, con OMP como
  agente predeterminado, permisos manuales, PowerShell, Chat UI, CLI registrada
  y telemetría deshabilitada por `ORCA_TELEMETRY_DISABLED=1`. `orca.yaml` fija
  setup reproducible con `bun install --frozen-lockfile` antes de iniciar el
  agente. Las skills oficiales `orca-cli` y `computer-use` se mantienen bajo
  `~/.agents/skills/` y OMP las descubre mediante junctions en su home; no se
  enlaza `orchestration` porque Task/Hub, Habitat y Fleet conservan esa
  autoridad. El workspace activo y limpio es `orca-flow` (`OMP Flow`).

## Trabajo abierto

- Sincronizar el binario 18.1.10 en `ASUS` sólo cuando se ejecute el flujo
  explícito de esa workstation.
- La propuesta upstream de filtros granulares espera dirección del maintainer;
  no abrir branch ni PR hasta recibirla.
- Cada actualización futura de OMP exige `omp update --check`, clone del tag
  exacto, rebase y tests focales, build con addon coincidente y despliegue
  exclusivo mediante `bun run deploy:omp -- <artifact>`.
- El piloto verificó setup previo al agente, Chat UI estructurada, input,
  paste UTF-8, copy Markdown, scroll dirigido, apertura de archivos, status
  `done` y resume de transcript por path absoluto. `Terminal attention` y
  `Agent sleep` quedaron habilitados; falta observar el sleep automático tras
  30 minutos y confirmar que su resume preserva Chat UI, porque el resume manual
  con `omp --resume <transcript>` abrió correctamente el transcript en vista
  terminal.

## Invariantes operativas

- El workspace contiene fuentes; nunca auth, sesiones, stores, caches ni
  artifacts privados.
- No crear wrappers de extensiones ni implementaciones paralelas de capacidades
  nativas.
- El límite económico de dispatch para Sol/Luna es 272k. Si una continuación lo
  supera, OMP compacta o aborta antes de enviar otra request.
- Los procesos runtime sólo operan panes que poseen. La persistencia de sesión,
  el retorno al parent y la vida del pane son contratos separados.
- `/cerrar-computadora` sólo prepara el draft: no ejecuta Git, deploy ni cierre.

## Verificación vigente

- Rebase 18.1.10: 22 tests focales, 92 assertions y check completo de
  `packages/coding-agent`.
- Laboratorio: `bun run audit` y `bun test`.
- Último smoke: PE e instalación aprobaron `--smoke-test`; el TUI mostró los
  tres presets, perfiles `main` y `zen`, 41 opciones, `Windows input: on` y un
  link local.
- Regenerar el índice tras cambiar topics con `bun run index`.

## Foco Único De Ejecución

- **Estado:** `complete`.
- **Referencia:** `docs/tracks/archive/aos-conformance-v2.md`.
- **Siguiente acción:** priorizar explícitamente los 18 downstreams clasificados como `migration-required`.

## Próxima lectura

- `docs/topics/ux-matrix.md`: OMP/WinInput, filtros, links, modelos y OMP Live.
- `docs/topics/agent-runtime-habitat.md`: sesiones visibles, handoff y lifecycle.
- `docs/topics/omp-fleet.md`: workers multi-repo y cancelación.
- `docs/topics/rpc-client.md`: protocolo RPC y settle.
- `docs/topics/wezterm-attention.md`: atención del terminal.
