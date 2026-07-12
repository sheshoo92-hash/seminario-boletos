require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const EVENT_NAME_DEFAULT = process.env.EVENT_NAME || 'Seminario Amway';
const PRECIO_DEFAULT = parseInt(process.env.PRECIO_BOLETO || '450', 10);

let mpClient = null;
if (process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN !== 'TU_ACCESS_TOKEN_AQUI') {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

// ---------- Directorios de uploads ----------
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
const DOCS_DIR = path.join(UPLOADS_DIR, 'docs');
[UPLOADS_DIR, DOCS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Servir uploads desde la carpeta configurable (necesario en Railway)
app.use('/uploads', express.static(UPLOADS_DIR));

// Multer para flyer del evento
const uploadFlyer = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, 'flyer' + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Solo imÃ¡genes'))),
});

// Multer para documentos de registro (INE / comprobante)
const uploadDocs = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOCS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, Date.now() + '-' + file.fieldname + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Solo imÃ¡genes'))),
});

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.password;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

function getEventConfig() {
  const cfg = db.getConfig();
  return {
    eventName:        cfg.eventName        || EVENT_NAME_DEFAULT,
    eventDate:        cfg.eventDate        || '',
    precio:           cfg.precio           != null ? cfg.precio           : PRECIO_DEFAULT,
    early_bird_active: cfg.early_bird_active || false,
    early_bird_precio: cfg.early_bird_precio != null ? cfg.early_bird_precio : 400,
    comision_mp:      cfg.comision_mp      != null ? cfg.comision_mp      : 3.49,
    precio_paquete:   cfg.precio_paquete   != null ? cfg.precio_paquete   : 1400,
    flyer:            cfg.flyer            || null,
  };
}

// NÃºmero mÃ¡ximo de escaneos:
// - early_bird = true (cualquier tipo, registrado durante el evento) = 2 (Ticket Holder + DÃ­a del evento)
// - Resto = 1
function maxCheckins(att) {
  return att.early_bird ? 2 : 1;
}

// ---------- Config pÃºblica ----------
app.get('/api/config', (req, res) => {
  const cfg = getEventConfig();
  res.json({
    eventName:         cfg.eventName,
    eventDate:         cfg.eventDate,
    precio:            cfg.early_bird_active ? cfg.early_bird_precio : cfg.precio,
    precio_normal:     cfg.precio,
    precio_paquete:    cfg.precio_paquete,
    early_bird_active: cfg.early_bird_active,
    early_bird_precio: cfg.early_bird_precio,
    flyer:             cfg.flyer ? `/uploads/${cfg.flyer}` : null,
    mpEnabled:         !!mpClient,
  });
});

// ---------- Registro ----------
app.post('/api/register', uploadDocs.fields([
  { name: 'comprobante', maxCount: 1 },
  { name: 'ine_photo',   maxCount: 1 },
  { name: 'ine_nuevo',   maxCount: 1 },
]), async (req, res) => {
  try {
    const {
      full_name, platino, esmeralda, diamante,
      ticket_type, auspicio_numero, fecha_auspicio,
    } = req.body;

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: 'Falta el nombre completo' });
    }

    const type = ticket_type || 'empresario';
    if (!['empresario', 'nuevo_empresario', 'invitado'].includes(type)) {
      return res.status(400).json({ error: 'Tipo de boleto invÃ¡lido' });
    }

    const cfg = getEventConfig();
    const ticket_code = uuidv4();
    let amount = 0;
    let early_bird = false;
    let comprobante_image = null;
    let ine_image = null;

    // -- Validaciones y precio por tipo --
    if (type === 'nuevo_empresario') {
      if (!auspicio_numero || !String(auspicio_numero).trim()) {
        return res.status(400).json({ error: 'Falta el nÃºmero de empresario' });
      }
      // Validar nombre completo (mÃ­nimo 2 palabras)
      if (full_name.trim().split(/\s+/).length < 2) {
        return res.status(400).json({ error: 'Por favor escribe tu nombre completo (nombre y apellido).' });
      }

      const registrosExistentes = db.getNuevoSociosPorNumero(auspicio_numero.trim());
      const nombreNorm = full_name.trim().toLowerCase().replace(/\s+/g, ' ');

      // FunciÃ³n para detectar si dos nombres son similares (uno contiene al otro)
      const nombresSimilares = (a, b) => {
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        return false;
      };

      // Separar registros del mismo titular/cotitular vs otras personas
      const registrosMismaPersna = registrosExistentes.filter(r =>
        nombresSimilares(nombreNorm, (r.full_name || '').trim().toLowerCase().replace(/\s+/g, ' '))
      );
      const personasUnicas = [...new Set(
        registrosExistentes.map(r => (r.full_name || '').trim().toLowerCase().replace(/\s+/g, ' '))
      )].filter(n => !nombresSimilares(n, nombreNorm));

      // Regla 1: esta persona ya usÃ³ sus 2 eventos gratis
      if (registrosMismaPersna.length >= 2) {
        return res.status(400).json({ error: 'Ya usaste tus 2 eventos gratuitos como Nuevo Empresario. Debes comprar un boleto de Empresario.' });
      }

      // Regla 2: el nÃºmero ya tiene 2 personas distintas y esta persona es una tercera
      if (personasUnicas.length >= 2 && registrosMismaPersna.length === 0) {
        return res.status(400).json({ error: 'Este nÃºmero de empresario ya tiene registrados al titular y cotitular. No se permiten mÃ¡s registros gratuitos con este nÃºmero.' });
      }
      if (!req.files || !req.files.comprobante) {
        return res.status(400).json({ error: 'Debes subir el comprobante de tu fecha de auspicio' });
      }
      comprobante_image = req.files.comprobante[0].filename;
      if (!req.files || !req.files.ine_nuevo) {
        return res.status(400).json({ error: 'Debes subir una foto de tu INE' });
      }
      ine_image = req.files.ine_nuevo[0].filename;
      amount = 0; // gratis
      if (cfg.early_bird_active) early_bird = true; // Ticket Holder si se registrÃ³ durante el evento

    } else if (type === 'invitado') {
      const existing = db.getInvitadoByNombre(full_name.trim());
      if (existing) {
        return res.status(400).json({ error: 'Ya existe un registro de este invitado. Los invitados sÃ³lo pueden asistir gratuitamente una sola vez.' });
      }
      if (!req.files || !req.files.ine_photo) {
        return res.status(400).json({ error: 'Debes subir una foto de tu INE' });
      }
      ine_image = req.files.ine_photo[0].filename;
      amount = 0; // acceso gratuito
      if (cfg.early_bird_active) early_bird = true; // Ticket Holder si se registrÃ³ durante el evento

    } else { // empresario
      if (cfg.early_bird_active) {
        amount = cfg.early_bird_precio;
        early_bird = true;
      } else {
        amount = cfg.precio;
      }
    }

    const ticket_number = db.getNextTicketNumber();
    const record = {
      ticket_number,
      ticket_code,
      full_name: full_name.trim(),
      platino: (platino || '').trim(),
      esmeralda: (esmeralda || '').trim(),
      diamante: (diamante || '').trim(),
      ticket_type: type,
      auspicio_numero: auspicio_numero ? String(auspicio_numero).trim() : null,
      fecha_auspicio: fecha_auspicio || null,
      comprobante_image,
      ine_image,
      amount,
      early_bird,
      payment_method: 'mercadopago',
      payment_status: 'pendiente',
      mp_preference_id: null,
      mp_payment_id: null,
      checked_in: false,
      checked_in_count: 0,
      checked_in_at: null,
      created_at: new Date().toISOString(),
    };

    db.insertAttendee(record);

    // Gratis (nuevo_empresario): marcar pagado directo
    if (amount === 0) {
      db.updateByCode(ticket_code, { payment_status: 'pagado' });
      return res.json({ demo: true, ticket_code, redirect: `/ticket.html?code=${ticket_code}` });
    }

    // Sin MP configurado: modo demo
    if (!mpClient) {
      db.updateByCode(ticket_code, { payment_status: 'pagado' });
      return res.json({ demo: true, ticket_code, redirect: `/ticket.html?code=${ticket_code}` });
    }

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{ title: `${cfg.eventName} - Boleto`, quantity: 1, unit_price: amount, currency_id: 'MXN' }],
        payer: { name: full_name.trim() },
        external_reference: ticket_code,
        back_urls: {
          success: `${BASE_URL}/pago-resultado.html?code=${ticket_code}&status=success`,
          failure: `${BASE_URL}/pago-resultado.html?code=${ticket_code}&status=failure`,
          pending: `${BASE_URL}/pago-resultado.html?code=${ticket_code}&status=pending`,
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        payment_methods: {
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'bank_transfer' },
            { id: 'atm' },
          ],
        },
      },
    });

    db.updateByCode(ticket_code, { mp_preference_id: result.id });
    res.json({ ticket_code, init_point: result.init_point, sandbox_init_point: result.sandbox_init_point });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el registro' });
  }
});

// ---------- Registro Paquete Grupo (4 boletos por $1400) ----------
app.post('/api/register-paquete', async (req, res) => {
  try {
    const { personas } = req.body;
    if (!Array.isArray(personas) || personas.length !== 4) {
      return res.status(400).json({ error: 'Se requieren exactamente 4 personas' });
    }
    for (let i = 0; i < 4; i++) {
      const p = personas[i];
      if (!p.full_name || p.full_name.trim().split(/\s+/).length < 2) {
        return res.status(400).json({ error: `Persona ${i + 1}: escribe nombre y apellido` });
      }
      if (!p.platino || !p.esmeralda || !p.diamante) {
        return res.status(400).json({ error: `Persona ${i + 1}: faltan datos de lÃ­nea` });
      }
    }

    const cfg = getEventConfig();
    const paquete_id = uuidv4();
    const PRECIO_PAQUETE = cfg.precio_paquete;
    const early_bird = cfg.early_bird_active || false;
    const ticket_codes = [];

    for (const p of personas) {
      const ticket_code = uuidv4();
      const ticket_number = db.getNextTicketNumber();
      db.insertAttendee({
        ticket_number,
        ticket_code,
        full_name: p.full_name.trim(),
        platino: p.platino.trim(),
        esmeralda: p.esmeralda.trim(),
        diamante: p.diamante.trim(),
        ticket_type: 'empresario',
        paquete_id,
        auspicio_numero: null,
        fecha_auspicio: null,
        comprobante_image: null,
        ine_image: null,
        amount: Math.round(PRECIO_PAQUETE / 4),
        early_bird,
        payment_method: 'mercadopago',
        payment_status: 'pendiente',
        mp_preference_id: null,
        mp_payment_id: null,
        checked_in: false,
        checked_in_count: 0,
        checked_in_at: null,
        created_at: new Date().toISOString(),
      });
      ticket_codes.push(ticket_code);
    }

    // Modo demo (sin MP configurado)
    if (!mpClient) {
      db.updateByPaqueteId(paquete_id, { payment_status: 'pagado' });
      return res.json({ demo: true, paquete_id, redirect: `/paquete.html?id=${paquete_id}` });
    }

    // Pago Ãºnico de $1400 via Mercado Pago
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{ title: `${cfg.eventName} â Paquete Grupo (4 boletos)`, quantity: 1, unit_price: PRECIO_PAQUETE, currency_id: 'MXN' }],
        payer: { name: personas[0].full_name.trim() },
        external_reference: `paquete:${paquete_id}`,
        back_urls: {
          success: `${BASE_URL}/paquete.html?id=${paquete_id}&status=success`,
          failure: `${BASE_URL}/paquete.html?id=${paquete_id}&status=failure`,
          pending: `${BASE_URL}/paquete.html?id=${paquete_id}&status=pending`,
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        payment_methods: {
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'bank_transfer' },
            { id: 'atm' },
          ],
        },
      },
    });

    ticket_codes.forEach(code => db.updateByCode(code, { mp_preference_id: result.id }));
    res.json({ paquete_id, init_point: result.init_point });

  } catch (err) {
    console.error('[REGISTER-PAQUETE]', err);
    res.status(500).json({ error: 'Error al crear el paquete' });
  }
});

// ---------- Consultar paquete grupo ----------
app.get('/api/paquete/:id', async (req, res) => {
  const attendees = db.getByPaqueteId(req.params.id);
  if (!attendees.length) return res.status(404).json({ error: 'Paquete no encontrado' });
  const cfg = getEventConfig();
  const withQR = await Promise.all(attendees.map(async att => {
    let qr = null;
    if (att.payment_status === 'pagado') {
      qr = await QRCode.toDataURL(att.ticket_code, { width: 200, margin: 1 });
    }
    return { ...att, qr };
  }));
  res.json({ attendees: withQR, eventName: cfg.eventName, eventDate: cfg.eventDate });
});

// ---------- Webhook Mercado Pago ----------
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const topic = req.query.topic || req.query.type || req.body.type;
    const id = req.query['data.id'] || (req.body.data && req.body.data.id);
    if (topic === 'payment' && id && mpClient) {
      const payment = new Payment(mpClient);
      const info = await payment.get({ id });
      if (info.external_reference && info.status === 'approved') {
        const ref = info.external_reference;
        if (ref.startsWith('paquete:')) {
          db.updateByPaqueteId(ref.replace('paquete:', ''), { payment_status: 'pagado', mp_payment_id: String(info.id) });
        } else {
          db.updateByCode(ref, { payment_status: 'pagado', mp_payment_id: String(info.id) });
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// ---------- Consultar boleto ----------
app.get('/api/ticket/:code', async (req, res) => {
  const att = db.getByCode(req.params.code);
  if (!att) return res.status(404).json({ error: 'Boleto no encontrado' });

  if (att.payment_status === 'pendiente' && mpClient) {
    try {
      const payment = new Payment(mpClient);
      const search = await payment.search({ options: { external_reference: att.ticket_code, sort: 'date_created', criteria: 'desc' } });
      const approved = (search.results || []).find(p => p.status === 'approved');
      if (approved) {
        db.updateByCode(att.ticket_code, { payment_status: 'pagado', mp_payment_id: String(approved.id) });
        att.payment_status = 'pagado';
      }
    } catch (e) { /* ignora */ }
  }

  let qr = null;
  if (att.payment_status === 'pagado') {
    qr = await QRCode.toDataURL(att.ticket_code, { width: 280, margin: 1 });
  }

  const cfg = getEventConfig();
  res.json({
    full_name: att.full_name,
    platino: att.platino,
    esmeralda: att.esmeralda,
    diamante: att.diamante,
    ticket_type: att.ticket_type || 'empresario',
    auspicio_numero: att.auspicio_numero,
    fecha_auspicio: att.fecha_auspicio,
    amount: att.amount,
    early_bird: att.early_bird || false,
    payment_status: att.payment_status,
    checked_in: !!att.checked_in,
    checked_in_count: att.checked_in_count || 0,
    checked_in_at: att.checked_in_at,
    ticket_number: att.ticket_number || null,
    ticket_code: att.ticket_code,
    qr,
    eventName: cfg.eventName,
    eventDate: cfg.eventDate,
    max_checkins: maxCheckins(att),
  });
});

// ---------- ADMIN: lista de asistentes ----------
app.get('/api/admin/attendees', (req, res) => {
  res.json(db.getAll());
});

// ---------- ADMIN: bÃºsqueda por nombre ----------
app.get('/api/admin/search', (req, res) => {
  const q = req.query.q || '';
  if (q.trim().length < 2) return res.json([]);
  res.json(db.searchByName(q));
});

// ---------- ADMIN: configuraciÃ³n ----------
app.get('/api/admin/config', (req, res) => {
  res.json(getEventConfig());
});

app.post('/api/admin/config', uploadFlyer.single('flyer'), (req, res) => {
  try {
    const fields = {};
    if (req.body.eventName?.trim())  fields.eventName  = req.body.eventName.trim();
    if (req.body.eventDate != null)  fields.eventDate  = String(req.body.eventDate).trim();
    if (req.body.precio?.trim())     fields.precio     = parseInt(req.body.precio, 10) || PRECIO_DEFAULT;
    if (req.body.early_bird_precio?.trim()) fields.early_bird_precio = parseInt(req.body.early_bird_precio, 10) || 400;
    if (req.body.early_bird_active != null) fields.early_bird_active = req.body.early_bird_active === 'true' || req.body.early_bird_active === true;
    if (req.body.comision_mp?.trim()) fields.comision_mp = parseFloat(req.body.comision_mp) || 3.49;
    if (req.body.precio_paquete?.trim()) fields.precio_paquete = parseInt(req.body.precio_paquete, 10) || 1400;
    if (req.file) fields.flyer = req.file.filename;
    db.setConfig(fields);
    res.json({ ok: true, config: getEventConfig() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar la configuraciÃ³n' });
  }
});

// ---------- ADMIN: reiniciar evento ----------
app.post('/api/admin/reset', (req, res) => {
  try {
    const cfg = getEventConfig();
    const archivo = db.archiveAndReset(cfg.eventName);
    res.json({ ok: true, archivo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo reiniciar el evento' });
  }
});

// ---------- ADMIN: archivos anteriores ----------
app.get('/api/admin/archivos', (req, res) => {
  res.json(db.listArchives());
});

// ---------- ADMIN: exportar CSV ----------
app.get('/api/admin/export', (req, res) => {
  let attendees;
  let nombreArchivo = 'reporte';
  if (req.query.archivo) {
    const archivo = db.getArchive(req.query.archivo);
    if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });
    attendees = archivo.attendees;
    nombreArchivo = req.query.archivo.replace(/\.json$/, '');
  } else {
    attendees = db.getAll();
  }

  const cfg = getEventConfig();
  const comision = cfg.comision_mp / 100;

  const headers = [
    'NÂ° Boleto', 'Nombre completo', 'Tipo de boleto', 'Platino', 'Esmeralda', 'Diamante',
    'NÂ° Empresario', 'Fecha auspicio', 'Early Bird', 'Monto cobrado',
    'ComisiÃ³n MP estimada', 'Ingreso neto', 'Estado de pago',
    'EntrÃ³', 'Veces escaneado', 'Fecha/hora de entrada', 'Registrado'
  ];

  const tipoLabel = { empresario: 'Empresario', nuevo_empresario: 'Nuevo Empresario', invitado: 'Invitado' };

  const fmtDate = iso => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      });
    } catch(e) { return iso; }
  };

  // Ordenar por fecha de registro (ascendente) para que el nÃºmero sea cronolÃ³gico
  const attendeesSorted = [...attendees].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const rows = attendeesSorted.map((a, i) => {
    const monto = a.amount || 0;
    const comisionMonto = a.payment_status === 'pagado' ? (monto * comision).toFixed(2) : '0.00';
    const neto = a.payment_status === 'pagado' ? (monto - monto * comision).toFixed(2) : '0.00';
    return [
      a.ticket_number || (i + 1),
      a.full_name || '',
      tipoLabel[a.ticket_type] || a.ticket_type || 'Empresario',
      a.platino || '', a.esmeralda || '', a.diamante || '',
      a.auspicio_numero || '',
      a.fecha_auspicio || '',
      a.early_bird ? 'SÃ­' : 'No',
      `$${monto}`,
      `$${comisionMonto}`,
      `$${neto}`,
      a.payment_status || '',
      a.checked_in ? 'SÃ­' : 'No',
      a.checked_in_count || 0,
      a.checked_in_at || '',
      fmtDate(a.created_at),
    ];
  });

  // Totales al final
  const totalCobrado = attendees.filter(a => a.payment_status === 'pagado').reduce((s, a) => s + (a.amount || 0), 0);
  const totalComision = (totalCobrado * comision).toFixed(2);
  const totalNeto = (totalCobrado - totalCobrado * comision).toFixed(2);
  rows.push([]);
  rows.push(['TOTALES', '', '', '', '', '', '', '', '', `$${totalCobrado}`, `$${totalComision}`, `$${totalNeto}`]);

  const csvEscape = val => {
    const s = String(val == null ? '' : val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const csv = [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}.csv"`);
  res.send('ï»¿' + csv);
});

// ---------- CHECK-IN (escÃ¡ner de puerta) ----------
// modo: 'ticket_holder' = registro previo (solo early bird) | 'evento' = dÃ­a del seminario (default)
// TH y evento son conteos INDEPENDIENTES para que no se interfieran.
// Endpoint pÃºblico de bÃºsqueda para escÃ¡neres (sin datos sensibles)
app.get('/api/scanner/search', (req, res) => {
  const q = req.query.q || '';
  if (q.trim().length < 2) return res.json([]);
  const data = db.searchByName(q);
  res.json(data.map(r => ({
    ticket_code: r.ticket_code,
    full_name: r.full_name,
    ticket_type: r.ticket_type,
    early_bird: r.early_bird,
    payment_status: r.payment_status,
    th_scanned: r.th_scanned,
  })));
});

app.post('/api/checkin', (req, res) => {
  const { ticket_code, modo } = req.body;
  console.log('[CHECKIN] modo recibido:', JSON.stringify(modo), '| code:', ticket_code);
  if (!ticket_code) return res.status(400).json({ error: 'CÃ³digo de boleto requerido' });

  const att = db.getByCode(ticket_code);
  if (!att) return res.status(404).json({ ok: false, reason: 'no_encontrado', message: 'Boleto no encontrado' });
  if (att.payment_status !== 'pagado') return res.json({ ok: false, reason: 'no_pagado', message: 'Boleto no pagado', attendee: att });

  const ts = () => new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });

  // ---- Modo Ticket Holder (conteo SEPARADO del evento) ----
  if (modo === 'ticket_holder') {
    if (!att.early_bird) {
      return res.json({ ok: false, reason: 'no_aplica_th', message: 'Este boleto no aplica Ticket Holder (no es Early Bird)', attendee: enrichAttendee(att) });
    }
    if (att.th_scanned) {
      return res.json({ ok: false, reason: 'ya_escaneado_th', message: 'Este Ticket Holder ya fue registrado', attendee: enrichAttendee(att) });
    }
    // Registrar TH â NO toca checked_in_count del evento
    const updated = db.updateByCode(ticket_code, { th_scanned: true, th_scanned_at: ts() });
    return res.json({ ok: true, message: 'Ticket Holder registrado â', attendee: enrichAttendee(updated) });
  }

  // ---- Modo Evento (dÃ­a del seminario) â independiente del TH ----
  const count = att.checked_in_count || 0;
  if (count >= 1) {
    return res.json({ ok: false, reason: 'ya_usado', message: 'Este boleto ya fue usado el dÃ­a del evento', attendee: enrichAttendee(att) });
  }
  const updated = db.updateByCode(ticket_code, {
    checked_in: true,
    checked_in_count: 1,
    checked_in_at: ts(),
  });
  res.json({ ok: true, message: 'Acceso permitido â', attendee: enrichAttendee(updated) });
});

// Agrega URLs de imÃ¡genes al objeto de asistente
function enrichAttendee(att) {
  return {
    ...att,
    comprobante_url: att.comprobante_image ? `/uploads/docs/${att.comprobante_image}` : null,
    ine_url:         att.ine_image         ? `/uploads/docs/${att.ine_image}`         : null,
    nuevo_socio_total: att.ticket_type === 'nuevo_empresario'
      ? db.countNuevoSocioRegistros(att.auspicio_numero)
      : null,
  };
}

app.listen(PORT, () => {
  console.log(`Servidor corriendo en ${BASE_URL} (puerto ${PORT})`);
});
