// Almacenamiento simple basado en archivo JSON (sin dependencias nativas,
// ideal para ~100-200 asistentes y fácil de desplegar en cualquier host).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'data.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archivos');

function load() {
  if (!fs.existsSync(FILE)) return { attendees: [], config: {} };
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data.attendees) data.attendees = [];
    if (!data.config) data.config = {};
    return data;
  } catch (e) {
    return { attendees: [], config: {} };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  insertAttendee(record) {
    const data = load();
    data.attendees.push(record);
    save(data);
    return record;
  },
  getByCode(ticket_code) {
    const data = load();
    return data.attendees.find(a => a.ticket_code === ticket_code) || null;
  },
  updateByCode(ticket_code, fields) {
    const data = load();
    const att = data.attendees.find(a => a.ticket_code === ticket_code);
    if (!att) return null;
    Object.assign(att, fields);
    save(data);
    return att;
  },
  getAll() {
    const data = load();
    return [...data.attendees].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  },
  getConfig() {
    const data = load();
    return data.config || {};
  },
  setConfig(fields) {
    const data = load();
    data.config = Object.assign({}, data.config || {}, fields);
    save(data);
    return data.config;
  },
  // Guarda los asistentes actuales en un archivo de respaldo (archivos/seminario-<fecha>.json)
  // y deja la lista de asistentes vacía para el siguiente evento.
  archiveAndReset(label) {
    const data = load();
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);
    const safeLabel = (label || 'seminario').toString().trim().replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-') || 'seminario';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveFile = path.join(ARCHIVE_DIR, `${safeLabel}-${stamp}.json`);
    fs.writeFileSync(archiveFile, JSON.stringify({
      eventName: data.config && data.config.eventName,
      eventDate: data.config && data.config.eventDate,
      archived_at: new Date().toISOString(),
      attendees: data.attendees,
    }, null, 2));
    data.attendees = [];
    save(data);
    return path.basename(archiveFile);
  },
  // Lista los archivos de respaldo guardados (más reciente primero)
  listArchives() {
    if (!fs.existsSync(ARCHIVE_DIR)) return [];
    return fs.readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));
  },
  getArchive(filename) {
    const safe = path.basename(filename);
    const file = path.join(ARCHIVE_DIR, safe);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return null;
    }
  },
  // Devuelve TODOS los asistentes históricos (evento actual + todos los archivos)
  getAllHistorico() {
    const data = load();
    const todos = [...data.attendees];
    if (fs.existsSync(ARCHIVE_DIR)) {
      fs.readdirSync(ARCHIVE_DIR)
        .filter(f => f.endsWith('.json'))
        .forEach(f => {
          try {
            const archivo = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
            if (Array.isArray(archivo.attendees)) todos.push(...archivo.attendees);
          } catch(e) {}
        });
    }
    return todos;
  },
  // Devuelve todos los registros de nuevo_empresario con ese número (histórico completo)
  getNuevoSociosPorNumero(auspicio_numero) {
    return this.getAllHistorico().filter(a =>
      a.ticket_type === 'nuevo_empresario' &&
      a.auspicio_numero === String(auspicio_numero).trim()
    );
  },
  // Cuántas veces se ha registrado este número (histórico completo)
  countNuevoSocioRegistros(auspicio_numero) {
    return this.getNuevoSociosPorNumero(auspicio_numero).length;
  },
  // Busca registros de invitado con ese nombre en el historial completo
  getInvitadoByNombre(nombre) {
    return this.getAllHistorico().find(a =>
      a.ticket_type === 'invitado' &&
      a.full_name.trim().toLowerCase() === nombre.trim().toLowerCase()
    ) || null;
  },
  // Devuelve el siguiente número de boleto secuencial (histórico + actual)
  getNextTicketNumber() {
    const todos = this.getAllHistorico();
    const maxNum = todos.reduce((max, a) => Math.max(max, a.ticket_number || 0), 0);
    return maxNum + 1;
  },
  // Búsqueda por nombre (parcial, sin distinción may/min)
  searchByName(query) {
    const data = load();
    const q = query.trim().toLowerCase();
    return data.attendees.filter(a =>
      a.full_name && a.full_name.toLowerCase().includes(q)
    );
  },
  // Devuelve todos los boletos de un paquete grupo
  getByPaqueteId(paquete_id) {
    const data = load();
    return data.attendees.filter(a => a.paquete_id === paquete_id);
  },
  // Actualiza todos los boletos de un paquete grupo con los mismos campos
  updateByPaqueteId(paquete_id, fields) {
    const data = load();
    data.attendees.forEach(a => {
      if (a.paquete_id === paquete_id) Object.assign(a, fields);
    });
    save(data);
  },
};
