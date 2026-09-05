# OMP Lab

Este repositorio es un laboratorio downstream de Oh My Pi (OMP).

<!-- aos-bootstrap: stable-bootstrap-v1 -->
<!-- aos-runtime-authority: omp -->
<!-- aos-local-authority: product, domain, data, security, external-effects -->

Bootstrap estable: OMP gobierna la ejecución y el runtime de agentes; este laboratorio y cliente de referencia conserva autoridad local sobre producto, dominio, datos, seguridad y gates de efectos externos.

## Límites

- Trabajar sólo dentro de este workspace salvo lecturas explícitas de documentación o código instalado.
- No copiar autenticación, sesiones, caches, stores, telemetría ni secretos desde el estado de usuario.
- `extensions/` es la fuente durable; `.omp/config.yml` sólo conecta esas fuentes con el discovery project-local.
- El cliente RPC es una referencia reusable y no una dependencia runtime de otros repositorios.
- Los inicios de sesión nuevos y los efectos externos sensibles conservan sus gates.
- `C:/dev/orca` es el repo dueño del host Orca: instalación, configuración,
  CLI, worktrees y parches. Consultar su `AGENTS.md` e índice antes de trabajar
  en ese dominio; aquí dejar referencias, no procedimientos espejo.
- `orca.yaml` conserva sólo el setup de este proyecto. OMP, Task/Hub, Habitat
  y Fleet conservan ejecución y orquestación; la orquestación propia de Orca
  se usa únicamente ante pedido explícito.

## Flujo documental

1. Leer `docs/WORKING_MEMORY.md` y `docs/TOPICS.md`.
2. Abrir sólo los topics relevantes.
3. Registrar decisiones durables en `docs/DECISIONS.md`.
4. Tras cambiar topics, ejecutar `bun run index`.
5. Antes de entregar, ejecutar `bun run audit` y los checks focales aplicables.

## Cambios

- Preferir APIs documentadas de OMP y evidencia del paquete instalado.
- No inventar eventos, settings o contratos wire.
- Ante cualquier pedido de actualizar OMP, revisar primero
  `docs/topics/ux-matrix.md` y el patch `patches/omp-*-workstation.patch`; comparar
  la versión destino con los filtros granulares upstream, retirar sólo lo que
  ya sea nativo, rebasar el delta restante, ejecutar sus tests y un smoke TUI
  real, y desplegar únicamente por `bun run deploy:omp`. Nunca permitir que el
  updater oficial reemplace silenciosamente el build granular.
- Mantener los scripts sin dependencias externas.
- Crear tests sólo para contratos observables nuevos; el cliente RPC sí tiene tests de framing, correlación y finalización.
