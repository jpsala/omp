# OMP Lab

Laboratorio independiente para estudiar y extender Oh My Pi con sus superficies nativas.

## Dos ubicaciones, dos responsabilidades

- `C:\dev\omp`: fuentes versionables del laboratorio, decisiones, topics, extensión local y cliente RPC de referencia.
- `~/.omp`: estado privado administrado por OMP (autenticación, sesiones, settings, caches y stores). No es parte de este workspace y nunca se copia aquí.

Para abrir OMP desde este workspace:

```powershell
omp
```

`extensions/omp-fleet.ts` es la fuente durable de `/fleet` y
`extensions/sync-close-prompt.ts` la de `/cerrar-computadora`. El perfil OMP
instala punteros mínimos en `~/.omp/agent/extensions/`, por lo que ambos
comandos sobreviven reinicios y aparecen desde cualquier repo. `.omp/config.yml`
conserva la lista explícita de extensiones project-local y globales requerida
para probar este workspace sin copiar sus fuentes.

## Mapa

- `docs/WORKING_MEMORY.md`: estado operativo breve.
- `docs/TOPICS.md`: índice generado de investigaciones focales.
- `docs/DECISIONS.md`: decisiones durables.
- `docs/DEVELOPMENT.md`: desarrollo y verificación.
- `topics/`: evidencia y contratos focales, incluido `topics/omp-fleet.md`.
- `extensions/`: extensiones mantenidas por el laboratorio.
- `src/omp-rpc-client.ts`: cliente RPC v2 reusable, sin dependencias.
- `src/omp-fleet*.ts`: scheduler, configuración y observadores del fleet multi-repositorio.
- `examples/rpc-once.ts`: invocación real de referencia.
- `scripts/update-index.ts`: regeneración determinista del índice.
- `scripts/audit.ts`: límites, higiene y contratos del workspace.

## Inicio rápido

```powershell
bun run index
bun run audit
bun test
bun examples/rpc-once.ts "Responde sólo: ok"
```

Dentro de OMP, `/fleet status` comprueba el discovery sin iniciar workers. El ejemplo multi-repo listo para adaptar se ejecuta con `/fleet run examples/fleet-publication.json`; sus `cwd` deben existir.

`/cerrar-computadora [foco opcional]` no ejecuta el cierre: reemplaza el
contenido del editor con una instrucción revisable que delega el procedimiento
al runbook canónico de Infra. Recién al enviarla el agente puede auditar,
preparar commits y publicar ramas no productivas; merge, deploy y reparación
destructiva permanecen fuera de alcance.

El ejemplo RPC y `/fleet run` invocan modelos configurados y pueden tener coste. El índice, el audit, los tests y `/fleet status` sin runs no contactan proveedores.

## Fuentes oficiales

- [RPC Protocol Reference](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)
- [Extension loading](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)
- [Repositorio OMP](https://github.com/can1357/oh-my-pi)

La evaluación local se hizo contra `@oh-my-pi/pi-coding-agent` 17.2.7 instalado; las rutas exactas se registran en los topics para que futuras actualizaciones puedan revalidarlas.
