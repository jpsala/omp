---
status: archived
priority: high
updated: 2026-09-04
---

# Alinear OMP con context-governance-v2

## Objetivo

Alinear el laboratorio con el contrato AOS normativo sin tocar comportamiento de producto: ruta documental canónica, foco único, índice/audit compartidos y checks locales aditivos.

## Estado

- Política global AOS compactada, protegida por presupuesto y desplegada al perfil.
- OMP usa topics canónicos, foco único, índice/audit compartidos y checks locales aditivos.
- El dry-run fleet clasificó `omp` compatible y 18 repos como `migration-required`; ningún otro repo fue modificado.

## Evidencia

- `bun run index && bun run audit`
- `bun test`
- `bun run profile:smoke -- --repo C:/dev/omp`, desde `C:/dev/os`
