# Instalar el optimizador en el PC (PWA) · v1.7.0

Desde la v1.7.0 el optimizador es una **Progressive Web App**: se instala desde Edge o Chrome como una aplicación
de escritorio (acceso en el menú Inicio, ventana propia), **funciona sin conexión** y **se actualiza sola** cuando
se publica una versión nueva. No requiere permisos de administrador ni instalador .exe/.msi.

## Requisitos
- **HTTPS** (o `http://localhost`). Desde `http://servidor/...` el navegador **no** ofrece instalar.
- Microsoft Edge o Google Chrome (Windows). Firefox de escritorio no instala PWA.
- Compilación de **producción** (`npm run build:prod`): el service worker no se activa con `ng serve`.

## Qué incluye
| Función | Detalle |
|---|---|
| Botón **⬇ Instalar en el PC** | En la cabecera. Abre el diálogo nativo del navegador; si no está disponible muestra la ayuda manual (y avisa si falta HTTPS). |
| Indicador **✔ Instalada** | Cuando se ejecuta como aplicación en su propia ventana. |
| **Sin conexión** | Todo se guarda en caché al instalar; el análisis es 100 % local. Indicador "● Sin conexión". |
| **Actualizaciones** | Al publicar una versión nueva aparece "🔄 Hay una nueva versión… Actualizar ahora". Se revisa al abrir y cada 6 h. |
| **Abrir con…** | En Windows, clic derecho sobre un `.sql` o `.sqlplan` → *Abrir con* → *Optimizador SQL* (lo abre en el módulo correcto). |
| **Atajos del icono** | Clic derecho en el icono instalado: *Analizar procedimiento* / *Analizar plan de ejecución*. |

## Probar en local
```bash
npm install
npm run build:prod
npm run serve:pwa        # http://localhost:8080 → botón "Instalar en el PC"
```

## Publicar
- **IIS:** copiar `dist/sql-optimizer/browser/*` y `web.config` (incluye el MIME de `.webmanifest` y sin caché para
  `ngsw-worker.js`, `ngsw.json` e `index.html`). El sitio debe tener **certificado HTTPS** (interno de la Caja).
- **Docker / Nginx:** `nginx.conf` ya incluye las mismas reglas; publicar detrás de HTTPS.
- **Subcarpeta:** `ng build --base-href /optimizador-sql/` (el manifest usa rutas relativas).

## Desinstalar
En la ventana de la app: menú **…** → **Desinstalar Optimizador SQL** (o en Windows: Configuración → Aplicaciones).

## Archivos de esta versión
Nuevos: `public/manifest.webmanifest`, `public/icons/*`, `ngsw-config.json`, `src/pwa.scss`,
`src/app/core/services/pwa.service.ts`, `src/app/shared/pwa-bar.component.ts`, `docs/PWA.md`.
Modificados: `package.json` (+ `@angular/service-worker`, script `serve:pwa`), `angular.json` (service worker y
`pwa.scss`), `src/index.html` (manifest, theme-color, iconos), `src/app/app.config.ts` (`provideServiceWorker`),
`src/app/app.component.ts/.html` (botón Instalar), `web.config`, `nginx.conf`.

## Changelog 1.7.0
- Instalable como aplicación de escritorio desde el navegador (PWA): botón Instalar, funcionamiento sin conexión,
  aviso de actualización, "Abrir con" para `.sql`/`.sqlplan`, atajos al módulo Procedimiento o Plan.
