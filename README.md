# Sistema de Boletos para Seminarios Amway

App web para registrar asistentes, cobrar con Mercado Pago (tarjeta de débito/crédito vía QR) y controlar el acceso escaneando un boleto QR en la puerta.

## ¿Cómo funciona?

1. **Asistente escanea un QR** (lo generas tú e imprimes/pegas en tus anuncios) que lleva a la página de registro.
2. Llena **nombre completo** y elige su nivel: **Platino, Esmeralda o Diamante** (cada uno con su precio).
3. Lo manda a pagar con **Mercado Pago** (tarjeta de débito/crédito).
4. Al confirmarse el pago, se genera un **boleto digital con su propio código QR** (página `ticket.html`).
5. En la puerta, tú o tu staff usan la página **`/scanner.html`** desde un celular para escanear ese QR: si es válido marca "entró" y evita que se use dos veces.
6. Desde **`/admin.html`** ves la lista completa: quién pagó y quién ya entró.

---

## PRIMERO: probarla en tu computadora (Mac)

No necesitas ser programador, solo seguir estos pasos en la app **Terminal** (la encuentras con Spotlight: `Cmd + Espacio`, escribe "Terminal").

### Paso 1 — Instalar Node.js (solo una vez)

1. Abre tu navegador y entra a https://nodejs.org
2. Descarga la versión "LTS" (la recomendada) e instálala como cualquier programa (siguiente, siguiente, instalar).
3. Para confirmar que quedó instalado, abre Terminal y escribe:
   ```
   node -v
   ```
   Debe mostrarte algo como `v20.x.x`.

### Paso 2 — Ubicar la carpeta de la app

Esta carpeta que te compartí (con `server.js`, `package.json`, etc.) guárdala en un lugar fácil, por ejemplo en tu carpeta de Escritorio, en una carpeta llamada `seminario-app`.

### Paso 3 — Instalar lo necesario

En Terminal, escribe (cambia la ruta si guardaste la carpeta en otro lugar):

```
cd ~/Desktop/seminario-app
npm install
```

Espera a que termine (puede tardar 1-2 minutos).

### Paso 4 — Configurar tus datos

1. En la carpeta, busca el archivo `.env.example`.
2. Haz una copia y renómbrala a `.env` (en Finder: clic derecho → Duplicar, luego renombrar y quitar el ".example").
3. Abre `.env` con TextEdit y ajusta:
   ```
   MP_ACCESS_TOKEN=tu_token_de_mercado_pago
   ADMIN_PASSWORD=elige-una-clave-para-el-scanner
   EVENT_NAME=Seminario Amway - Junio
   PRECIO_PLATINO=500
   PRECIO_ESMERALDA=800
   PRECIO_DIAMANTE=1200
   ```
   (Para probar sin Mercado Pago todavía, deja `MP_ACCESS_TOKEN=TU_ACCESS_TOKEN_AQUI` tal cual — el sistema simula el pago automáticamente para que veas el flujo completo).
4. Guarda el archivo.

### Paso 5 — Arrancar la app

En Terminal:

```
npm start
```

Debe aparecer: `Servidor corriendo en http://localhost:3000`.

### Paso 6 — Probarla

Abre tu navegador (Chrome/Safari) y visita:

- `http://localhost:3000` → formulario de registro (lo que vería el asistente).
- `http://localhost:3000/scanner.html` → escáner de la puerta (pide la `ADMIN_PASSWORD`).
- `http://localhost:3000/admin.html` → lista de asistentes.

Para apagar el servidor, vuelve a Terminal y presiona `Control + C`.

---

## SEGUNDO: configurar Mercado Pago

1. Entra a https://www.mercadopago.com.mx/developers/panel/app y crea una aplicación.
2. Copia tu **Access Token de producción**.
3. Pégalo en `MP_ACCESS_TOKEN` dentro de tu archivo `.env`.

---

## TERCERO: publicarla en internet (para que la gente la use el día del evento)

Para que Mercado Pago confirme los pagos automáticamente y la gente pueda registrarse desde su celular, la app debe estar en una dirección de internet (no solo en tu computadora). Cuando tengas todo probado localmente y quieras que te ayude a publicarla (por ejemplo en Render.com, gratis), dime y te guío paso a paso — solo necesitarás crear una cuenta gratuita ahí.

Una vez publicada, generas un código QR apuntando a esa dirección (con cualquier generador de QR gratuito) y ese es el QR que pones en tus anuncios para que la gente se registre y pague.

---

## El día del evento

1. Abre `/scanner.html` en el celular que estará en la puerta, ingresa la clave de administrador (`ADMIN_PASSWORD`) y permite el acceso a la cámara.
2. Conforme lleguen los asistentes, escanea el QR de su boleto (lo tienen guardado desde `/ticket.html`).
   - **Verde** = acceso permitido.
   - **Amarillo** = boleto ya fue usado antes.
   - **Rojo** = boleto no válido o no pagado.

## Notas importantes

- Los datos se guardan en el archivo `data.json` (se crea solo, dentro de la carpeta de la app).
- Modo demo: si dejas `MP_ACCESS_TOKEN` sin configurar, el sistema marca los pagos como "pagados" automáticamente (sin cobrar) — útil para probar el flujo completo antes de poner tu token real.
- Cambia `ADMIN_PASSWORD` por algo solo tú/tu staff conozcan.
