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

## Flujo documental

1. Leer `docs/WORKING_MEMORY.md` y `docs/TOPICS.md`.
2. Abrir sólo los topics relevantes.
3. Registrar decisiones durables en `docs/DECISIONS.md`.
4. Tras cambiar topics, ejecutar `bun run index`.
5. Antes de entregar, ejecutar `bun run audit` y los checks focales aplicables.

## Cambios

- Preferir APIs documentadas de OMP y evidencia del paquete instalado.
- No inventar eventos, settings o contratos wire.
- Mantener los scripts sin dependencias externas.
- Crear tests sólo para contratos observables nuevos; el cliente RPC sí tiene tests de framing, correlación y finalización.
