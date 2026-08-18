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

## Perfil experimental DeepSeek

`profiles/deepseek-lab.yml` es un overlay reversible de OMP para investigar el
costo y el comportamiento de DeepSeek sin cambiar el perfil global ni copiar
credenciales. Arranca el modelo por defecto en V4 Pro `high`, usa V4 Flash
`low` para `smol` y subagentes `task`, y deja `Ctrl+P`/el selector de modelo
alternar entre `default` y `smol`.

```powershell
omp --config profiles/deepseek-lab.yml
```

El overlay sólo afecta ese proceso; para volver a la configuración normal se
abre OMP sin `--config`. Las pruebas de costo usan `omp bench` con pocas
solicitudes y un límite de salida pequeño.

Para comparar una baseline de un solo modelo con una arquitectura delegada:

```powershell
omp --config profiles/study-luna-max.yml
omp --config profiles/study-deepseek.yml
```

`study-luna-max` usa Luna Max como padre y como implementador. `study-deepseek`
usa DeepSeek V4 Pro `max` como padre y V4 Flash `low` como implementador. Ambos
desactivan `prewalk`, limitan la concurrencia a uno y delegan una sola tarea para
que la comparación no mezcle orquestación con un handoff automático.

## Preset mixto GLM, Qwen y MiniMax

`profiles/glm-flash-qwen-coder-minimax.yml` combina GLM 4.7 Flash para el uso
cotidiano, Qwen3 Coder Next para las tareas `task` que hacen cambios reales y
MiniMax M3 `high` para `slow` y `plan` cuando el problema requiere más
razonamiento. Desactiva `prewalk` y limita la concurrencia de Task a uno para
que el handoff a Qwen sea explícito.

```powershell
omp --config profiles/glm-flash-qwen-coder-minimax.yml
```

## Catálogo de perfiles

`profiles/catalog.json` es el catálogo mantenible y
`extensions/omp-profiles.ts` expone el comando nativo `/profiles`. Los siete
overlays existentes siguen siendo YAML nativo de OMP; la metadata no se mezcla
con ese schema.

Dentro de OMP:

```text
/profiles list
/profiles show study-sol-luna
/profiles activate study-sol-luna
/profiles prepare study-sol-luna
```

`list` enumera los perfiles activos, `show` muestra nombre, overlay, padre,
Task, `prewalk`, concurrencia, tags y advertencia de proveedor/costo. Los
nombres se completan por autocomplete y se validan contra la allowlist del
catálogo. Un nombre arbitrario, path absoluto, traversal o sustitución por
modelo se rechaza.

`activate` cambia explícitamente el modelo padre y el nivel de thinking de la
sesión OMP actual mediante la API nativa. Por ejemplo, `study-sol-luna` activa
Sol `medium`. También informa Task, `prewalk` y concurrencia del catálogo, pero
no finge cambiar esos parámetros si la API de la sesión no los expone.

`prepare` conserva la alternativa de sesión nueva: precarga en el editor el
comando exacto `omp --config profiles/<archivo>.yml`. El overlay completo sigue
siendo la única forma de cambiar simultáneamente proveedor, Task, `prewalk` y
política de delegación.

Los perfiles `deepseek-pro-high` y `deepseek-flash-high` usan el provider
directo `deepseek` con thinking `high` en padre y Task. No forman parte de
ningún hotkey de selección rápida: el cambio de modelo vive en el selector
nativo de OMP (`Alt+M`/`/models`).

Para agregar, modificar o retirar una combinación:

1. Crear o editar el overlay YAML nativo dentro de `profiles/`.
2. Agregar o actualizar su entrada en `profiles/catalog.json`.
3. Mantener `name` estable, `overlay` relativo directo a `profiles/` y completar
   padre, Task, tags, estado, `prewalk` y concurrencia.
4. Ejecutar `bun run audit && bun test`.

Retirar un perfil significa marcarlo `retired` o quitarlo del registro después
de retirar su overlay; la lógica de autocomplete no cambia.

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
