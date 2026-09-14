# Mi Bolsillo

App para llevar los gastos e ingresos del mes desde el celular: resumen, torta por
categoría, últimos 6 meses, presupuestos, buscador de movimientos y exportar/importar.

- **La app** se publica gratis en GitHub Pages y se instala en el celular como una app.
- **Los datos** se guardan en Supabase (base de datos en la nube, plan gratis).
  Cada cambio queda primero en el celular y se sube cuando hay señal.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html`, `styles.css`, `app.js` | La app |
| `config.js` | Datos de conexión con Supabase (los pegas tú) |
| `supabase.sql` | Crea las tablas y la seguridad por usuario |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lo que la hace instalable y usable sin señal |
| `tools/generar-iconos.js` | Vuelve a dibujar los íconos (`node tools/generar-iconos.js`) |

Sin `config.js` lleno, la app abre en **modo prueba** y guarda solo en ese navegador.

## Puesta en marcha (una sola vez)

### 1. Supabase
1. Entra a [supabase.com](https://supabase.com) → **Start your project** → **Continue with GitHub**.
2. **New project**: nombre `mi-bolsillo`, crea una contraseña para la base
   (guárdala en tu gestor; la app no la usa) y región **East US** (la más cercana).
3. Cuando termine de crearse: menú izquierdo **SQL Editor** → **New query** →
   pega todo `supabase.sql` → **Run**. Debe decir *Success*.
4. **Project Settings → API**: copia **Project URL** y la clave **anon public**
   y pégalas en `config.js`.
5. **Authentication → URL Configuration → Site URL**: pon la dirección de la app
   en GitHub Pages (paso 2), para que el correo de confirmación lleve a la app.

### 2. GitHub Pages
El código vive en el repositorio `mi-bolsillo`. En GitHub: **Settings → Pages →
Branch: main / (root) → Save**. La app queda en
`https://TU-USUARIO.github.io/mi-bolsillo/`.

### 3. Crear tu cuenta en la app
Abre la dirección → **¿Primera vez? Crear cuenta** → confirma el correo → entra.

Después, en Supabase: **Authentication → Sign In / Providers** → apaga
**Allow new users to sign up**. Así nadie más puede crear cuentas en tu app
(igual no verían tus datos, pero queda cerrada).

### 4. Instalar en el iPhone
Abre la dirección en **Safari** → botón **•••** → **Compartir** → **Agregar a inicio**
→ activa **Abrir como app web** → **Agregar**.

## Cuando se cambie algo de la app
Subir el número de `VERSION` en `sw.js` (por ejemplo `mi-bolsillo-v2`) antes de
publicar, para que los celulares tomen la versión nueva. La app se actualiza sola
la segunda vez que se abre.
